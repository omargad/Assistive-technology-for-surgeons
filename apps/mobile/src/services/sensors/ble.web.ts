/**
 * Web Bluetooth Heart Rate Profile source (Chrome, Edge, Opera and Android
 * browsers). Metro picks this file for the web bundle.
 *
 * - `connect()` opens the browser's device chooser, so it must run from a user
 *   gesture (a button press) — call it without awaiting other work first.
 * - `characteristicvaluechanged` events are parsed with the core parser.
 * - `gattserverdisconnected` triggers reconnects with exponential back-off
 *   (1 s → 30 s cap) while started.
 * - `canScan` is false: the browser chooser replaces scanning.
 *
 * Web Bluetooth is not part of TypeScript's DOM lib, so the minimal surface
 * used here is declared locally.
 */
import { parseBatteryLevel, parseBodySensorLocation } from '@surgeonpulse/core';
import type { SensorInfo } from '@surgeonpulse/core';
import { backoffDelayMs } from './backoff';
import { BATTERY_REFRESH_MS, measurementToData } from './measurement';
import type { DiscoveredDevice, HeartRateSource, SensorListener, SensorState, SensorStatus, SourceChoice } from './types';

/** The source choice this platform's BLE implementation provides. */
export const BLE_CHOICE: SourceChoice = 'web-bluetooth';

// ---------------------------------------------------------------------------
// Minimal Web Bluetooth typings
// ---------------------------------------------------------------------------

interface WbCharacteristic extends EventTarget {
  value?: DataView | null;
  readValue(): Promise<DataView>;
  startNotifications(): Promise<WbCharacteristic>;
  stopNotifications(): Promise<WbCharacteristic>;
}

interface WbService {
  getCharacteristic(name: string): Promise<WbCharacteristic>;
}

interface WbServer {
  readonly connected: boolean;
  connect(): Promise<WbServer>;
  disconnect(): void;
  getPrimaryService(name: string): Promise<WbService>;
}

interface WbDevice extends EventTarget {
  readonly id: string;
  readonly name?: string | null;
  readonly gatt?: WbServer | null;
}

interface WbBluetooth {
  getAvailability?(): Promise<boolean>;
  requestDevice(options: {
    filters: { services: string[] }[];
    optionalServices?: string[];
  }): Promise<WbDevice>;
}

/** `navigator.bluetooth` when the browser supports Web Bluetooth. */
export function getWebBluetooth(): WbBluetooth | null {
  if (typeof navigator === 'undefined') return null;
  const bt = (navigator as Navigator & { bluetooth?: WbBluetooth }).bluetooth;
  return bt ?? null;
}

function dataViewBytes(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : '';
}

export interface WebBleSourceOptions {
  /** Override `navigator.bluetooth` (tests). */
  bluetooth?: () => WbBluetooth | null;
  now?: () => number;
}

export function createBleSource(options: WebBleSourceOptions = {}): HeartRateSource {
  const getBluetooth = options.bluetooth ?? getWebBluetooth;
  const now = options.now ?? Date.now;

  let device: WbDevice | null = null;
  let measurement: WbCharacteristic | null = null;
  let listener: SensorListener | null = null;
  let started = false;
  let intentionalDisconnect = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let batteryTimer: ReturnType<typeof setInterval> | null = null;
  let lastState: SensorState = 'idle';
  let lastMessage: string | undefined;
  let attempt = 0;
  let streaming = false;
  let battery: number | undefined;
  let contact: boolean | undefined;
  let lastSampleAt: number | undefined;

  function emit(state: SensorState, message?: string): void {
    lastState = state;
    lastMessage = message;
    const status: SensorStatus = { state };
    if (message !== undefined) status.message = message;
    if (device?.name) status.deviceName = device.name;
    if (battery !== undefined) status.battery = battery;
    if (contact !== undefined) status.contact = contact;
    if (lastSampleAt !== undefined) status.lastSampleAt = lastSampleAt;
    try {
      listener?.onStatus(status);
    } catch {
      // ignore listener failures
    }
  }

  const onValue = (event: Event): void => {
    try {
      if (!started) return;
      const view = (event.target as WbCharacteristic | null)?.value;
      if (!view) return;
      const t = now();
      const data = measurementToData(dataViewBytes(view), t);
      if (!data) return;
      lastSampleAt = t;
      if (!streaming || data.contact !== contact) {
        streaming = true;
        contact = data.contact;
        emit('streaming');
      }
      listener?.onData([data.sample], data.rr);
    } catch {
      // never throw from an event handler
    }
  };

  const onDisconnected = (): void => {
    try {
      measurement = null;
      streaming = false;
      if (intentionalDisconnect || !started) {
        emit('disconnected');
        return;
      }
      scheduleReconnect();
    } catch {
      // ignore
    }
  };

  async function readOptional(server: WbServer): Promise<{ location?: string }> {
    const out: { location?: string } = {};
    try {
      const svc = await server.getPrimaryService('heart_rate');
      const ch = await svc.getCharacteristic('body_sensor_location');
      const loc = parseBodySensorLocation(dataViewBytes(await ch.readValue()));
      if (loc !== 'unknown') out.location = loc;
    } catch {
      // optional characteristic
    }
    battery = (await readBattery(server)) ?? battery;
    return out;
  }

  async function readBattery(server: WbServer): Promise<number | undefined> {
    try {
      const svc = await server.getPrimaryService('battery_service');
      const ch = await svc.getCharacteristic('battery_level');
      return parseBatteryLevel(dataViewBytes(await ch.readValue()));
    } catch {
      return undefined; // optional service
    }
  }

  function stopBatteryRefresh(): void {
    if (batteryTimer !== null) clearInterval(batteryTimer);
    batteryTimer = null;
  }

  /** Re-read the battery level periodically while started, so a strap running flat is visible in time. */
  function startBatteryRefresh(): void {
    stopBatteryRefresh();
    batteryTimer = setInterval(() => {
      const target = device;
      const server = target?.gatt;
      if (!started || !streaming || !server?.connected) return;
      void readBattery(server).then((level) => {
        if (level === undefined || level === battery || !started || device !== target) return;
        battery = level;
        emit(lastState, lastMessage);
      });
    }, BATTERY_REFRESH_MS);
  }

  async function connectGatt(target: WbDevice): Promise<WbServer> {
    if (!target.gatt) throw new Error('This device does not expose GATT services.');
    const server = target.gatt.connected ? target.gatt : await target.gatt.connect();
    const svc = await server.getPrimaryService('heart_rate');
    const ch = await svc.getCharacteristic('heart_rate_measurement');
    if (measurement && measurement !== ch) measurement.removeEventListener('characteristicvaluechanged', onValue);
    measurement = ch;
    return server;
  }

  async function subscribe(): Promise<void> {
    if (!measurement) return;
    streaming = false;
    measurement.removeEventListener('characteristicvaluechanged', onValue);
    measurement.addEventListener('characteristicvaluechanged', onValue);
    await measurement.startNotifications();
  }

  function clearReconnect(): void {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect(): void {
    clearReconnect();
    attempt += 1;
    emit('reconnecting', `Connection lost. Reconnecting (attempt ${attempt})…`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void tryReconnect();
    }, backoffDelayMs(attempt));
  }

  async function tryReconnect(): Promise<void> {
    const target = device;
    if (!started || intentionalDisconnect || !target) return;
    try {
      const server = await connectGatt(target);
      if (!started || intentionalDisconnect) return;
      await subscribe();
      battery = (await readBattery(server)) ?? battery;
      attempt = 0;
      emit('connected');
    } catch {
      if (started && !intentionalDisconnect) scheduleReconnect();
    }
  }

  const source: HeartRateSource = {
    kind: 'web-bluetooth',
    label: 'Bluetooth heart-rate sensor (browser)',
    canScan: false,

    async isSupported() {
      const bt = getBluetooth();
      if (!bt) return false;
      try {
        return typeof bt.getAvailability === 'function' ? await bt.getAvailability() : true;
      } catch {
        return true; // availability check is advisory
      }
    },

    async requestPermissions() {
      // The browser chooser shown by `connect()` is the permission prompt.
      return getBluetooth() !== null;
    },

    scan(_onDevice: (device: DiscoveredDevice) => void) {
      // Not available on the web: the browser chooser in `connect()` replaces scanning.
      return () => undefined;
    },

    async connect(): Promise<SensorInfo> {
      const bt = getBluetooth();
      if (!bt) throw new Error('This browser does not support Web Bluetooth. Use Chrome or Edge, or the mobile app.');
      let chosen: WbDevice;
      try {
        chosen = await bt.requestDevice({
          filters: [{ services: ['heart_rate'] }],
          optionalServices: ['battery_service'],
        });
      } catch (error) {
        if (errorName(error) === 'NotFoundError') throw new Error('No sensor was selected.');
        if (errorName(error) === 'SecurityError') {
          throw new Error('Bluetooth access was blocked. Open the app over https and allow Bluetooth.');
        }
        throw new Error('Could not open the Bluetooth device chooser.');
      }
      if (device && device !== chosen) await source.disconnect();
      intentionalDisconnect = false;
      device = chosen;
      device.removeEventListener('gattserverdisconnected', onDisconnected);
      device.addEventListener('gattserverdisconnected', onDisconnected);
      let server: WbServer;
      try {
        server = await connectGatt(chosen);
      } catch {
        throw new Error('Could not connect to the sensor. Make sure it is worn and nearby.');
      }
      const { location } = await readOptional(server);
      const info: SensorInfo = { source: 'web-bluetooth', name: chosen.name ?? 'Heart-rate sensor', id: chosen.id };
      if (location) info.location = location;
      return info;
    },

    async start(next: SensorListener) {
      if (!device || !measurement) throw new Error('Connect to a sensor before starting.');
      listener = next;
      started = true;
      attempt = 0;
      startBatteryRefresh();
      try {
        await subscribe();
        emit('connected');
      } catch {
        emit('error', 'Could not start heart-rate notifications.');
      }
    },

    async stop() {
      started = false;
      clearReconnect();
      stopBatteryRefresh();
      attempt = 0;
      streaming = false;
      const ch = measurement;
      if (ch) {
        ch.removeEventListener('characteristicvaluechanged', onValue);
        try {
          await ch.stopNotifications();
        } catch {
          // already stopped / disconnected
        }
      }
    },

    async disconnect() {
      await source.stop();
      intentionalDisconnect = true;
      const target = device;
      if (target) {
        target.removeEventListener('gattserverdisconnected', onDisconnected);
        try {
          if (target.gatt?.connected) target.gatt.disconnect();
        } catch {
          // ignore
        }
      }
      emit('disconnected');
      device = null;
      measurement = null;
      listener = null;
      battery = undefined;
      contact = undefined;
    },
  };
  return source;
}
