/// <reference types="jest" />
import {
  BATTERY_LEVEL,
  BODY_SENSOR_LOCATION,
  HEART_RATE_MEASUREMENT,
  HEART_RATE_SERVICE,
  bytesToBase64,
} from '@surgeonpulse/core';
import { createBleSource } from '../ble.native';
import type { BleManagerLike } from '../ble.native';
import type { DiscoveredDevice, SensorListener, SensorStatus } from '../types';

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
  monitors: { cb: Cb; removed: boolean }[];
  disconnectCb: (() => void) | null;
  scanCb: Cb | null;
}

function createFakeManager(): FakeManager {
  const m = { adapter: 'PoweredOn', monitors: [], disconnectCb: null, scanCb: null } as unknown as FakeManager;
  Object.assign(m, {
    state: jest.fn(async () => m.adapter),
    onStateChange: jest.fn((cb: (s: string) => void, emit?: boolean) => {
      if (emit) cb(m.adapter);
      return { remove: jest.fn() };
    }),
    startDeviceScan: jest.fn(async (_uuids: string[] | null, _opts: unknown, cb: Cb) => {
      m.scanCb = cb;
    }),
    stopDeviceScan: jest.fn(async () => undefined),
    connectToDevice: jest.fn(async (id: string) => ({ id, name: 'Polar H10 A1B2C3D4', localName: null })),
    cancelDeviceConnection: jest.fn(async (id: string) => ({ id })),
    onDeviceDisconnected: jest.fn((_id: string, cb: () => void) => {
      m.disconnectCb = cb;
      return {
        remove: jest.fn(() => {
          m.disconnectCb = null;
        }),
      };
    }),
    discoverAllServicesAndCharacteristicsForDevice: jest.fn(async (id: string) => ({ id })),
    readCharacteristicForDevice: jest.fn(async (_id: string, _svc: string, ch: string) => {
      if (ch === BATTERY_LEVEL) return { value: bytesToBase64([87]) };
      if (ch === BODY_SENSOR_LOCATION) return { value: bytesToBase64([1]) }; // chest
      throw new Error('unknown characteristic');
    }),
    monitorCharacteristicForDevice: jest.fn((_id: string, _svc: string, _ch: string, cb: Cb) => {
      const entry = { cb, removed: false };
      m.monitors.push(entry);
      return {
        remove: jest.fn(() => {
          entry.removed = true;
        }),
      };
    }),
  });
  return m;
}

function activeMonitor(m: FakeManager) {
  const live = m.monitors.filter((x) => !x.removed);
  expect(live).toHaveLength(1);
  return live[0]!;
}

/** flags 0x16: uint8 HR, contact supported + detected, RR present; 72 bpm; RR 1024/1024 s = 1000 ms. */
const NOTIFICATION = bytesToBase64([0x16, 72, 0x00, 0x04]);

function recorder(): { listener: SensorListener; data: jest.Mock; statuses: SensorStatus[] } {
  const statuses: SensorStatus[] = [];
  const data = jest.fn();
  return { listener: { onData: data, onStatus: (s) => statuses.push(s) }, data, statuses };
}

const T = new Date('2026-03-02T08:00:00.000Z');

beforeEach(() => jest.useFakeTimers({ now: T }));
afterEach(() => jest.useRealTimers());

function makeSource(m: FakeManager) {
  return createBleSource({ manager: () => m, requestAndroidPermissions: async () => true });
}

describe('BLE native source', () => {
  it('is supported when the adapter exists and unsupported when the native module is missing', async () => {
    const m = createFakeManager();
    await expect(makeSource(m).isSupported()).resolves.toBe(true);
    // Default shared manager: constructing BleManager throws in tests (like Expo Go).
    await expect(createBleSource().isSupported()).resolves.toBe(false);
  });

  it('scans for the Heart Rate service, de-duplicates by id and stops after the timeout', async () => {
    const m = createFakeManager();
    const found: DiscoveredDevice[] = [];
    makeSource(m).scan((d) => found.push(d), { timeoutMs: 10_000 });
    await jest.advanceTimersByTimeAsync(0);
    expect(m.startDeviceScan).toHaveBeenCalledWith([HEART_RATE_SERVICE], { allowDuplicates: false }, expect.any(Function));
    const device = { id: 'A', name: 'Polar H10', localName: null, rssi: -60, serviceUUIDs: ['180D'] };
    m.scanCb!(null, device);
    m.scanCb!(null, { ...device, rssi: -40 });
    m.scanCb!(null, { id: 'B', name: null, localName: 'TICKR', rssi: -70, serviceUUIDs: null });
    expect(found).toEqual([
      { id: 'A', name: 'Polar H10', rssi: -60, advertisesHeartRate: true },
      { id: 'B', name: 'TICKR', rssi: -70, advertisesHeartRate: true },
    ]);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(m.stopDeviceScan).toHaveBeenCalledTimes(1);
    m.scanCb!(null, { ...device, id: 'C' });
    expect(found).toHaveLength(2);
  });

  it('"show all" scans without a filter and skips anonymous non-HR devices', async () => {
    const m = createFakeManager();
    const found: DiscoveredDevice[] = [];
    const stop = makeSource(m).scan((d) => found.push(d), { showAll: true });
    await jest.advanceTimersByTimeAsync(0);
    expect(m.startDeviceScan).toHaveBeenCalledWith(null, { allowDuplicates: false }, expect.any(Function));
    m.scanCb!(null, { id: 'X', name: null, localName: null, rssi: -50, serviceUUIDs: null });
    m.scanCb!(null, { id: 'Y', name: 'Garmin HRM', localName: null, rssi: -50, serviceUUIDs: [] });
    expect(found.map((d) => [d.id, d.advertisesHeartRate])).toEqual([['Y', false]]);
    stop();
    expect(m.stopDeviceScan).toHaveBeenCalledTimes(1);
  });

  it('connects, reads battery and body location, and parses notifications into samples + RR', async () => {
    const m = createFakeManager();
    const source = makeSource(m);
    const info = await source.connect('A');
    expect(info).toEqual({ source: 'ble', name: 'Polar H10 A1B2C3D4', id: 'A', location: 'chest' });
    expect(m.discoverAllServicesAndCharacteristicsForDevice).toHaveBeenCalledWith('A');

    const r = recorder();
    await source.start(r.listener);
    expect(m.monitorCharacteristicForDevice).toHaveBeenCalledWith(
      'A',
      HEART_RATE_SERVICE,
      HEART_RATE_MEASUREMENT,
      expect.any(Function),
    );
    activeMonitor(m).cb(null, { value: NOTIFICATION });
    expect(r.data).toHaveBeenCalledWith([{ t: T.getTime(), bpm: 72, contact: true }], [{ t: T.getTime(), ms: 1000 }]);
    expect(r.statuses.at(-1)).toMatchObject({
      state: 'streaming',
      deviceName: 'Polar H10 A1B2C3D4',
      battery: 87,
      contact: true,
    });

    // Malformed payloads and errors never throw out of the callback.
    expect(() => activeMonitor(m).cb(null, { value: bytesToBase64([0x01]) })).not.toThrow();
    expect(() => activeMonitor(m).cb(new Error('gatt'), null)).not.toThrow();
    expect(r.data).toHaveBeenCalledTimes(1);
  });

  it('connecting again to the same device reuses the connection', async () => {
    const m = createFakeManager();
    const source = makeSource(m);
    const first = await source.connect('A');
    await expect(source.connect('A')).resolves.toEqual(first);
    expect(m.connectToDevice).toHaveBeenCalledTimes(1);
    await source.connect('B'); // a different device: the old one is released first
    expect(m.cancelDeviceConnection).toHaveBeenCalledWith('A');
    expect(m.connectToDevice).toHaveBeenCalledTimes(2);
  });

  it('reconnects with exponential back-off after an unexpected disconnect and re-subscribes', async () => {
    const m = createFakeManager();
    const source = makeSource(m);
    await source.connect('A');
    const r = recorder();
    await source.start(r.listener);
    const first = activeMonitor(m);

    (m.connectToDevice as jest.Mock).mockRejectedValueOnce(new Error('timeout'));
    m.disconnectCb!();
    expect(first.removed).toBe(true);
    expect(r.statuses.at(-1)).toMatchObject({ state: 'reconnecting', message: expect.stringContaining('attempt 1') });

    await jest.advanceTimersByTimeAsync(999);
    expect(m.connectToDevice).toHaveBeenCalledTimes(1); // only the initial connect
    await jest.advanceTimersByTimeAsync(1); // attempt 1 at 1 s → fails
    expect(m.connectToDevice).toHaveBeenCalledTimes(2);
    expect(r.statuses.at(-1)).toMatchObject({ state: 'reconnecting', message: expect.stringContaining('attempt 2') });

    await jest.advanceTimersByTimeAsync(1999);
    expect(m.connectToDevice).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1); // attempt 2 at +2 s → succeeds
    expect(m.connectToDevice).toHaveBeenCalledTimes(3);
    expect(r.statuses.at(-1)?.state).toBe('connected');

    const second = activeMonitor(m);
    expect(second).not.toBe(first);
    second.cb(null, { value: NOTIFICATION });
    expect(r.data).toHaveBeenCalledTimes(1);

    // Back-off resets after success: the next drop retries after 1 s again.
    m.disconnectCb!();
    expect(r.statuses.at(-1)?.message).toContain('attempt 1');
    await jest.advanceTimersByTimeAsync(1000);
    expect(m.connectToDevice).toHaveBeenCalledTimes(4);
  });

  it('caps the back-off at 30 s', async () => {
    const m = createFakeManager();
    const source = makeSource(m);
    await source.connect('A');
    await source.start(recorder().listener);
    (m.connectToDevice as jest.Mock).mockRejectedValue(new Error('out of range'));
    m.disconnectCb!();
    // 1 + 2 + 4 + 8 + 16 = 31 s for five attempts, then 30 s steps.
    await jest.advanceTimersByTimeAsync(31_000);
    expect(m.connectToDevice).toHaveBeenCalledTimes(1 + 5);
    await jest.advanceTimersByTimeAsync(29_999);
    expect(m.connectToDevice).toHaveBeenCalledTimes(6);
    await jest.advanceTimersByTimeAsync(1);
    expect(m.connectToDevice).toHaveBeenCalledTimes(7);
  });

  it('stop removes the subscription; disconnect cancels the connection without reconnecting', async () => {
    const m = createFakeManager();
    const source = makeSource(m);
    await source.connect('A');
    const r = recorder();
    await source.start(r.listener);
    await source.stop();
    expect(m.monitors.every((x) => x.removed)).toBe(true);

    await source.start(r.listener);
    await source.disconnect();
    expect(m.monitors.every((x) => x.removed)).toBe(true);
    expect(m.cancelDeviceConnection).toHaveBeenCalledWith('A');
    expect(m.disconnectCb).toBeNull();
    expect(r.statuses.at(-1)?.state).toBe('disconnected');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(m.connectToDevice).toHaveBeenCalledTimes(1);
    await expect(source.disconnect()).resolves.toBeUndefined(); // safe to call twice
  });

  it('reports "Bluetooth is off" and denied permissions', async () => {
    const m = createFakeManager();
    m.adapter = 'PoweredOff';
    const source = makeSource(m);
    const pending = source.requestPermissions();
    const assertion = expect(pending).rejects.toThrow('Bluetooth is off');
    await jest.advanceTimersByTimeAsync(2_000);
    await assertion;

    m.adapter = 'Unauthorized';
    await expect(source.requestPermissions()).resolves.toBe(false);

    const denied = createBleSource({ manager: () => m, requestAndroidPermissions: async () => false });
    await expect(denied.requestPermissions()).resolves.toBe(false);

    m.adapter = 'PoweredOn';
    await expect(source.requestPermissions()).resolves.toBe(true);
  });

  it('fails to connect with a helpful message when the device is unreachable', async () => {
    const m = createFakeManager();
    (m.connectToDevice as jest.Mock).mockRejectedValueOnce(new Error('timeout'));
    await expect(makeSource(m).connect('A')).rejects.toThrow(/Could not connect/);
    await expect(makeSource(m).connect()).rejects.toThrow(/Choose a heart-rate sensor/);
  });
});
