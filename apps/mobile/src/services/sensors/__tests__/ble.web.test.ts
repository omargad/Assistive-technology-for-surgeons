/// <reference types="jest" />
import { createBleSource } from '../ble.web';
import type { WebBleSourceOptions } from '../ble.web';
import type { SensorListener, SensorStatus } from '../types';

/** Minimal EventTarget-based fakes of the Web Bluetooth objects. */
class FakeCharacteristic extends EventTarget {
  value: DataView | null = null;
  notifying = false;
  constructor(private readonly bytes: number[] = []) {
    super();
  }
  async readValue() {
    return new DataView(new Uint8Array(this.bytes).buffer);
  }
  async startNotifications() {
    this.notifying = true;
    return this;
  }
  async stopNotifications() {
    this.notifying = false;
    return this;
  }
  notify(bytes: number[]) {
    // Use an offset view to make sure byteOffset is honoured.
    const buf = new Uint8Array([0xff, ...bytes]);
    this.value = new DataView(buf.buffer, 1, bytes.length);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

function createFakeDevice() {
  const hrm = new FakeCharacteristic();
  const location = new FakeCharacteristic([1]);
  const battery = new FakeCharacteristic([64]);
  const device = new EventTarget() as EventTarget & { id: string; name: string; gatt: unknown };
  const server: {
    connected: boolean;
    connect: jest.Mock;
    disconnect: jest.Mock;
    getPrimaryService: jest.Mock;
  } = {
    connected: false,
    connect: jest.fn(async () => {
      server.connected = true;
      return server;
    }),
    disconnect: jest.fn(() => {
      server.connected = false;
    }),
    getPrimaryService: jest.fn(async (name: string) => ({
      getCharacteristic: async (c: string) => {
        if (name === 'heart_rate' && c === 'heart_rate_measurement') return hrm;
        if (name === 'heart_rate' && c === 'body_sensor_location') return location;
        if (name === 'battery_service' && c === 'battery_level') return battery;
        throw new Error('NotFoundError');
      },
    })),
  };
  Object.assign(device, { id: 'web-1', name: 'Polar H10 1234', gatt: server });
  return { device, server, hrm };
}

/** Present a fake as `navigator.bluetooth`. */
function bluetooth(fake: unknown): NonNullable<WebBleSourceOptions['bluetooth']> {
  return () => fake as ReturnType<NonNullable<WebBleSourceOptions['bluetooth']>>;
}

function recorder() {
  const statuses: SensorStatus[] = [];
  const data = jest.fn();
  const listener: SensorListener = { onData: data, onStatus: (s) => statuses.push(s) };
  return { listener, data, statuses };
}

const T = new Date('2026-03-02T08:00:00.000Z');

beforeEach(() => jest.useFakeTimers({ now: T }));
afterEach(() => jest.useRealTimers());

describe('Web Bluetooth source', () => {
  it('is unsupported without navigator.bluetooth', async () => {
    const source = createBleSource({ bluetooth: () => null });
    await expect(source.isSupported()).resolves.toBe(false);
    await expect(source.connect()).rejects.toThrow(/does not support Web Bluetooth/);
    expect(source.canScan).toBe(false);
  });

  it('opens the chooser filtered to heart-rate devices and streams parsed notifications', async () => {
    const fake = createFakeDevice();
    const requestDevice = jest.fn(async () => fake.device);
    const source = createBleSource({ bluetooth: bluetooth({ requestDevice, getAvailability: async () => true }) });
    await expect(source.isSupported()).resolves.toBe(true);

    const info = await source.connect();
    expect(requestDevice).toHaveBeenCalledWith({
      filters: [{ services: ['heart_rate'] }],
      optionalServices: ['battery_service'],
    });
    expect(info).toEqual({ source: 'web-bluetooth', name: 'Polar H10 1234', id: 'web-1', location: 'chest' });

    const r = recorder();
    await source.start(r.listener);
    expect(fake.hrm.notifying).toBe(true);
    // flags 0x10 (uint8 HR + RR, no contact support), 65 bpm, RR 0x0300 = 768/1024 s = 750 ms
    fake.hrm.notify([0x10, 65, 0x00, 0x03]);
    expect(r.data).toHaveBeenCalledWith([{ t: T.getTime(), bpm: 65 }], [{ t: T.getTime(), ms: 750 }]);
    expect(r.statuses.at(-1)).toMatchObject({ state: 'streaming', battery: 64, deviceName: 'Polar H10 1234' });

    await source.stop();
    expect(fake.hrm.notifying).toBe(false);
    fake.hrm.notify([0x00, 70]);
    expect(r.data).toHaveBeenCalledTimes(1);
  });

  it('reconnects with back-off after gattserverdisconnected while started', async () => {
    const fake = createFakeDevice();
    const source = createBleSource({ bluetooth: bluetooth({ requestDevice: async () => fake.device }) });
    await source.connect();
    const r = recorder();
    await source.start(r.listener);

    fake.server.connected = false;
    fake.server.connect.mockRejectedValueOnce(new Error('NetworkError'));
    fake.device.dispatchEvent(new Event('gattserverdisconnected'));
    expect(r.statuses.at(-1)).toMatchObject({ state: 'reconnecting' });
    await jest.advanceTimersByTimeAsync(1000); // attempt 1 fails
    expect(fake.server.connect).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(2000); // attempt 2 succeeds
    expect(fake.server.connect).toHaveBeenCalledTimes(3);
    expect(r.statuses.at(-1)?.state).toBe('connected');
    fake.hrm.notify([0x00, 70]);
    expect(r.data).toHaveBeenCalledTimes(1);

    await source.disconnect();
    expect(fake.server.disconnect).toHaveBeenCalled();
    fake.device.dispatchEvent(new Event('gattserverdisconnected'));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(fake.server.connect).toHaveBeenCalledTimes(3);
  });

  it('turns a dismissed chooser into a friendly error', async () => {
    const err = Object.assign(new Error('User cancelled'), { name: 'NotFoundError' });
    const source = createBleSource({
      bluetooth: bluetooth({
        requestDevice: async () => {
          throw err;
        },
      }),
    });
    await expect(source.connect()).rejects.toThrow('No sensor was selected.');
  });
});
