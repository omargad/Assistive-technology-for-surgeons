/// <reference types="jest" />
/**
 * BLE behaviour during long cases:
 * - SP-MOB-9: the cancellation / link-loss error that ble-plx reports on a removed monitor does not
 *   overwrite "reconnecting" with "error", and Bluetooth switched off mid-case is named as such.
 * - DOC-N1: the battery level is re-read periodically while streaming (native and Web Bluetooth).
 */
import {
  BATTERY_LEVEL,
  BODY_SENSOR_LOCATION,
  bytesToBase64,
} from '@surgeonpulse/core';
import { createBleSource } from '../ble.native';
import type { BleManagerLike } from '../ble.native';
import { createBleSource as createWebBleSource } from '../ble.web';
import type { WebBleSourceOptions } from '../ble.web';
import { BATTERY_REFRESH_MS } from '../measurement';
import type { SensorStatus } from '../types';

jest.mock('react-native-ble-plx', () => ({
  BleManager: jest.fn(() => {
    throw new Error('native module unavailable in tests');
  }),
  State: {
    Unknown: 'Unknown',
    Resetting: 'Resetting',
    Unsupported: 'Unsupported',
    Unauthorized: 'Unauthorized',
    PoweredOff: 'PoweredOff',
    PoweredOn: 'PoweredOn',
  },
}));

type Cb = (error: unknown, value: unknown) => void;

interface FakeManager extends BleManagerLike {
  adapter: string;
  batteryLevel: number;
  monitors: { cb: Cb; removed: boolean }[];
  disconnectCb: (() => void) | null;
}

function createFakeManager(): FakeManager {
  const m = { adapter: 'PoweredOn', batteryLevel: 87, monitors: [], disconnectCb: null } as unknown as FakeManager;
  Object.assign(m, {
    state: jest.fn(async () => m.adapter),
    onStateChange: jest.fn((cb: (s: string) => void, emit?: boolean) => {
      if (emit) cb(m.adapter);
      return { remove: jest.fn() };
    }),
    startDeviceScan: jest.fn(async () => undefined),
    stopDeviceScan: jest.fn(async () => undefined),
    connectToDevice: jest.fn(async (id: string) => ({ id, name: 'Polar H10 A1B2C3D4', localName: null })),
    cancelDeviceConnection: jest.fn(async (id: string) => ({ id })),
    onDeviceDisconnected: jest.fn((_id: string, cb: () => void) => {
      m.disconnectCb = cb;
      return { remove: jest.fn(() => (m.disconnectCb = null)) };
    }),
    discoverAllServicesAndCharacteristicsForDevice: jest.fn(async (id: string) => ({ id })),
    readCharacteristicForDevice: jest.fn(async (_id: string, _svc: string, ch: string) => {
      if (ch === BATTERY_LEVEL) return { value: bytesToBase64([m.batteryLevel]) };
      if (ch === BODY_SENSOR_LOCATION) return { value: bytesToBase64([1]) };
      throw new Error('unknown characteristic');
    }),
    monitorCharacteristicForDevice: jest.fn((_id: string, _svc: string, _ch: string, cb: Cb) => {
      const entry = { cb, removed: false };
      m.monitors.push(entry);
      return { remove: jest.fn(() => (entry.removed = true)) };
    }),
  });
  return m;
}

/** flags 0x16: uint8 HR, contact supported + detected, RR present; 72 bpm; RR 1000 ms. */
const NOTIFICATION = bytesToBase64([0x16, 72, 0x00, 0x04]);

const T = new Date('2026-03-02T08:00:00.000Z');
beforeEach(() => jest.useFakeTimers({ now: T }));
afterEach(() => jest.useRealTimers());

async function started(m: FakeManager, statuses: SensorStatus[]) {
  const src = createBleSource({ manager: () => m, requestAndroidPermissions: async () => true });
  await src.connect('A');
  await src.start({ onData: () => undefined, onStatus: (s) => statuses.push(s) });
  return src;
}

describe('native BLE status during outages (SP-MOB-9)', () => {
  it.each([
    ['DeviceDisconnected', 201],
    ['OperationCancelled', 2],
  ])('a %s error from the removed monitor keeps the status "reconnecting"', async (_name, errorCode) => {
    const m = createFakeManager();
    const statuses: SensorStatus[] = [];
    await started(m, statuses);
    const monitor = m.monitors[0]!;
    m.disconnectCb!(); // link loss → reconnect scheduled
    monitor.cb({ errorCode, message: 'cancelled' }, null); // the rejection of the cancelled monitor arrives afterwards
    expect(statuses[statuses.length - 1]?.state).toBe('reconnecting');
  });

  it('still reports a real error on the live subscription', async () => {
    const m = createFakeManager();
    const statuses: SensorStatus[] = [];
    await started(m, statuses);
    m.monitors[0]!.cb({ errorCode: 401, message: 'Characteristic notify change failed' }, null);
    expect(statuses[statuses.length - 1]).toEqual(
      expect.objectContaining({ state: 'error', message: 'Heart-rate notifications were interrupted.' }),
    );
  });

  it('says that Bluetooth is off while it stays off, then reconnects when it is back', async () => {
    const m = createFakeManager();
    const statuses: SensorStatus[] = [];
    await started(m, statuses);
    m.adapter = 'PoweredOff';
    m.disconnectCb!();
    await jest.advanceTimersByTimeAsync(60_000);
    const messages = statuses.filter((s) => s.state === 'reconnecting').map((s) => s.message);
    expect(messages.slice(1).length).toBeGreaterThan(0);
    expect(messages.slice(1).every((x) => /Bluetooth is off/.test(x ?? ''))).toBe(true);

    m.adapter = 'PoweredOn';
    await jest.advanceTimersByTimeAsync(31_000);
    expect(statuses[statuses.length - 1]?.state).toBe('connected');
  });
});

describe('battery level during a long case (DOC-N1)', () => {
  it('native: re-reads the battery periodically while streaming', async () => {
    const m = createFakeManager();
    const statuses: SensorStatus[] = [];
    const src = await started(m, statuses);
    m.monitors[0]!.cb(null, { value: NOTIFICATION });
    expect(statuses[statuses.length - 1]).toEqual(expect.objectContaining({ state: 'streaming', battery: 87 }));

    m.batteryLevel = 12;
    await jest.advanceTimersByTimeAsync(BATTERY_REFRESH_MS);
    expect(statuses[statuses.length - 1]).toEqual(expect.objectContaining({ state: 'streaming', battery: 12 }));

    await src.stop();
    const reads = (m.readCharacteristicForDevice as jest.Mock).mock.calls.length;
    await jest.advanceTimersByTimeAsync(3 * BATTERY_REFRESH_MS);
    expect((m.readCharacteristicForDevice as jest.Mock).mock.calls.length).toBe(reads); // stopped with the source
  });

  it('web: re-reads the battery periodically while streaming', async () => {
    class Characteristic extends EventTarget {
      value: DataView | null = null;
      constructor(public bytes: number[] = []) {
        super();
      }
      async readValue() {
        return new DataView(new Uint8Array(this.bytes).buffer);
      }
      async startNotifications() {
        return this;
      }
      async stopNotifications() {
        return this;
      }
      notify(bytes: number[]) {
        this.value = new DataView(new Uint8Array(bytes).buffer);
        this.dispatchEvent(new Event('characteristicvaluechanged'));
      }
    }
    const hrm = new Characteristic();
    const battery = new Characteristic([64]);
    const server: { connected: boolean; connect: jest.Mock; disconnect: jest.Mock; getPrimaryService: jest.Mock } = {
      connected: false,
      connect: jest.fn(async () => {
        server.connected = true;
        return server;
      }),
      disconnect: jest.fn(),
      getPrimaryService: jest.fn(async (name: string) => ({
        getCharacteristic: async (c: string) => {
          if (name === 'heart_rate' && c === 'heart_rate_measurement') return hrm;
          if (name === 'battery_service' && c === 'battery_level') return battery;
          throw new Error('NotFoundError');
        },
      })),
    };
    const device = Object.assign(new EventTarget(), { id: 'web-1', name: 'Polar H10 1234', gatt: server });
    const bt = { requestDevice: jest.fn(async () => device), getAvailability: async () => true };
    const src = createWebBleSource({
      bluetooth: (() => bt) as unknown as NonNullable<WebBleSourceOptions['bluetooth']>,
    });
    const statuses: SensorStatus[] = [];
    await src.connect();
    await src.start({ onData: () => undefined, onStatus: (s) => statuses.push(s) });
    hrm.notify([0x16, 72, 0x00, 0x04]);
    expect(statuses[statuses.length - 1]).toEqual(expect.objectContaining({ state: 'streaming', battery: 64 }));

    battery.bytes = [9];
    await jest.advanceTimersByTimeAsync(BATTERY_REFRESH_MS);
    expect(statuses[statuses.length - 1]).toEqual(expect.objectContaining({ state: 'streaming', battery: 9 }));
    await src.disconnect();
  });
});
