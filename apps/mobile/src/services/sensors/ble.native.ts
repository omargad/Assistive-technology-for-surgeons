/**
 * Bluetooth LE Heart Rate Profile source for iOS and Android
 * (react-native-ble-plx). Metro picks this file for native builds; the web
 * bundle gets `ble.web.ts` and never imports react-native-ble-plx.
 *
 * Behaviour (SPEC "BLE native"):
 * - One shared, lazily created `BleManager` for the whole app.
 * - Android runtime permissions: BLUETOOTH_SCAN + BLUETOOTH_CONNECT on API ≥ 31,
 *   ACCESS_FINE_LOCATION on API ≤ 30.
 * - Waits for the adapter to be `PoweredOn` and reports "Bluetooth is off".
 * - Scan filters on the Heart Rate service unless `showAll` (some straps do
 *   not advertise service UUIDs); results are de-duplicated by id.
 * - On connect: discover services, read Body Sensor Location and Battery
 *   Level when present, then subscribe to Heart Rate Measurement notifications.
 * - Unexpected disconnects are retried with exponential back-off
 *   (1 s → 30 s cap) while started, re-subscribing after each reconnect.
 * - Subscriptions are removed on stop/disconnect; callbacks never throw.
 */
import {
  BATTERY_LEVEL,
  BATTERY_SERVICE,
  BODY_SENSOR_LOCATION,
  HEART_RATE_MEASUREMENT,
  HEART_RATE_SERVICE,
  base64ToBytes,
  parseBatteryLevel,
  parseBodySensorLocation,
} from '@surgeonpulse/core';
import type { SensorInfo } from '@surgeonpulse/core';
import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, State } from 'react-native-ble-plx';
import type { Subscription } from 'react-native-ble-plx';
import { backoffDelayMs } from './backoff';
import { BATTERY_REFRESH_MS, measurementToData, normalizeUuid } from './measurement';
import type { DiscoveredDevice, HeartRateSource, SensorListener, SensorState, SensorStatus, SourceChoice } from './types';

/** The source choice this platform's BLE implementation provides. */
export const BLE_CHOICE: SourceChoice = 'ble';

/** The subset of `BleManager` this source uses (lets tests inject a fake). */
export type BleManagerLike = Pick<
  BleManager,
  | 'state'
  | 'onStateChange'
  | 'startDeviceScan'
  | 'stopDeviceScan'
  | 'connectToDevice'
  | 'cancelDeviceConnection'
  | 'onDeviceDisconnected'
  | 'discoverAllServicesAndCharacteristicsForDevice'
  | 'readCharacteristicForDevice'
  | 'monitorCharacteristicForDevice'
>;

export interface BleSourceOptions {
  /** Returns the BLE manager (default: the shared app-wide instance). */
  manager?: () => BleManagerLike;
  /** Wall clock for sample timestamps (default `Date.now`). */
  now?: () => number;
  /** Android permission request (default: PermissionsAndroid, by API level). */
  requestAndroidPermissions?: () => Promise<boolean>;
  /** Default scan duration in ms (default 15 000). */
  scanTimeoutMs?: number;
  /** How long to wait for an adapter in an "unknown" state, e.g. while the iOS permission prompt is shown. */
  adapterTimeoutMs?: number;
}

const CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_SCAN_TIMEOUT_MS = 15_000;
const DEFAULT_ADAPTER_TIMEOUT_MS = 15_000;
/** Grace period for an adapter reported as off (it may be turning on). */
const POWERED_OFF_GRACE_MS = 2_000;
const HR_SERVICE_NORMALIZED = normalizeUuid(HEART_RATE_SERVICE);

let sharedManager: BleManager | null = null;

/** The single BleManager for the whole app, created on first use. */
function getSharedManager(): BleManagerLike {
  if (!sharedManager) sharedManager = new BleManager();
  return sharedManager;
}

function noop(): void {}

/** Call something that may return a promise or throw, ignoring any failure. */
function safely(fn: () => unknown): void {
  try {
    const result = fn();
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      (result as Promise<unknown>).catch(noop);
    }
  } catch {
    // ignore
  }
}

function androidApiLevel(): number {
  const v = Platform.Version;
  return typeof v === 'number' ? v : Number.parseInt(String(v), 10) || 0;
}

async function defaultAndroidPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const granted = PermissionsAndroid.RESULTS.GRANTED;
  if (androidApiLevel() >= 31) {
    const result = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    return (
      result[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] === granted &&
      result[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] === granted
    );
  }
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
  return result === granted;
}

/** Human-readable explanation of a non-ready adapter state. */
function adapterMessage(state: State): string {
  switch (state) {
    case State.PoweredOff:
      return 'Bluetooth is off. Turn it on and try again.';
    case State.Unauthorized:
      return 'Bluetooth permission was denied. Allow it in Settings to use a heart-rate sensor.';
    case State.Unsupported:
      return 'This device does not support Bluetooth Low Energy.';
    default:
      return 'Bluetooth is not ready yet. Please try again.';
  }
}

/** Reconnect status while the adapter itself is unavailable (Bluetooth switched off mid-case, permission withdrawn). */
function adapterLostMessage(state: State): string | undefined {
  switch (state) {
    case State.PoweredOff:
      return 'Bluetooth is off. Turn it on to resume heart-rate recording.';
    case State.Unauthorized:
      return 'Bluetooth permission was withdrawn. Allow it in Settings to resume heart-rate recording.';
    default:
      return undefined;
  }
}

/**
 * BleErrorCode values (installed `react-native-ble-plx/src/index.d.ts`) that a monitor reports when its
 * subscription is cancelled or the link drops: OperationCancelled (2), DeviceDisconnected (201) and
 * DeviceNotConnected (205). The disconnect watcher handles those, so they are not shown as errors.
 * (Numbers, not the enum, so the module also works with a partial mock.)
 */
const MONITOR_CANCEL_CODES: ReadonlySet<number> = new Set([2, 201, 205]);

/**
 * Resolve with the adapter state once it settles: immediately for
 * PoweredOn / Unauthorized / Unsupported, after a short grace period for
 * PoweredOff, or with the last seen state after `timeoutMs`.
 */
function waitForAdapter(manager: BleManagerLike, timeoutMs: number): Promise<State> {
  return new Promise<State>((resolve) => {
    let current: State = State.Unknown;
    let done = false;
    let sub: Subscription | null = null;
    let offTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (state: State): void => {
      if (done) return;
      done = true;
      clearTimeout(overall);
      if (offTimer) clearTimeout(offTimer);
      safely(() => sub?.remove());
      resolve(state);
    };
    const overall = setTimeout(() => finish(current), timeoutMs);
    try {
      sub = manager.onStateChange((state) => {
        current = state;
        if (state === State.PoweredOn || state === State.Unauthorized || state === State.Unsupported) {
          finish(state);
        } else if (state === State.PoweredOff) {
          if (!offTimer) offTimer = setTimeout(() => finish(State.PoweredOff), POWERED_OFF_GRACE_MS);
        } else if (offTimer) {
          clearTimeout(offTimer);
          offTimer = null;
        }
      }, true);
      // The listener may have fired synchronously before `sub` was assigned.
      if (done) safely(() => sub?.remove());
    } catch {
      finish(State.Unsupported);
    }
  });
}

function deviceDisplayName(device: { name: string | null; localName: string | null }): string | null {
  const name = device.name ?? device.localName;
  return name && name.trim() !== '' ? name.trim() : null;
}

export function createBleSource(options: BleSourceOptions = {}): HeartRateSource {
  const getManager = options.manager ?? getSharedManager;
  const now = options.now ?? Date.now;
  const requestAndroid = options.requestAndroidPermissions ?? defaultAndroidPermissions;
  const scanTimeoutDefault = options.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
  const adapterTimeout = options.adapterTimeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;

  let connection: { id: string; name: string; location?: string } | null = null;
  let listener: SensorListener | null = null;
  let started = false;
  let intentionalDisconnect = false;
  let monitorSub: Subscription | null = null;
  let disconnectSub: Subscription | null = null;
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
    if (connection) status.deviceName = connection.name;
    if (battery !== undefined) status.battery = battery;
    if (contact !== undefined) status.contact = contact;
    if (lastSampleAt !== undefined) status.lastSampleAt = lastSampleAt;
    try {
      listener?.onStatus(status);
    } catch {
      // A listener error must never break the BLE pipeline.
    }
  }

  async function ensureReady(): Promise<void> {
    const state = await waitForAdapter(getManager(), adapterTimeout);
    if (state !== State.PoweredOn) throw new Error(adapterMessage(state));
  }

  async function readBattery(id: string): Promise<number | undefined> {
    try {
      const ch = await getManager().readCharacteristicForDevice(id, BATTERY_SERVICE, BATTERY_LEVEL);
      return ch.value ? parseBatteryLevel(base64ToBytes(ch.value)) : undefined;
    } catch {
      return undefined; // Battery Service is optional.
    }
  }

  async function readLocation(id: string): Promise<string | undefined> {
    try {
      const ch = await getManager().readCharacteristicForDevice(id, HEART_RATE_SERVICE, BODY_SENSOR_LOCATION);
      if (!ch.value) return undefined;
      const location = parseBodySensorLocation(base64ToBytes(ch.value));
      return location === 'unknown' ? undefined : location;
    } catch {
      return undefined; // Body Sensor Location is optional.
    }
  }

  function removeMonitor(): void {
    const sub = monitorSub;
    monitorSub = null;
    safely(() => sub?.remove());
  }

  function removeDisconnectWatch(): void {
    const sub = disconnectSub;
    disconnectSub = null;
    safely(() => sub?.remove());
  }

  function clearReconnect(): void {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function stopBatteryRefresh(): void {
    if (batteryTimer !== null) clearInterval(batteryTimer);
    batteryTimer = null;
  }

  /** Re-read the battery level periodically while started, so a strap running flat is visible in time. */
  function startBatteryRefresh(): void {
    stopBatteryRefresh();
    batteryTimer = setInterval(() => {
      const conn = connection;
      if (!started || !conn || !streaming) return;
      void readBattery(conn.id).then((level) => {
        if (level === undefined || level === battery || !started || connection !== conn) return;
        battery = level;
        emit(lastState, lastMessage);
      });
    }, BATTERY_REFRESH_MS);
  }

  function subscribe(id: string): void {
    removeMonitor();
    streaming = false;
    let self: Subscription | null = null;
    try {
      self = getManager().monitorCharacteristicForDevice(
        id,
        HEART_RATE_SERVICE,
        HEART_RATE_MEASUREMENT,
        (error, characteristic) => {
          try {
            if (error) {
              // A removed subscription reports its cancellation afterwards, and a link loss reports
              // DeviceDisconnected: both are handled by the disconnect watcher (which may already be
              // reconnecting), so only an error on the live subscription is shown.
              const code = (error as { errorCode?: unknown }).errorCode;
              if (self === null || monitorSub !== self) return;
              if (typeof code === 'number' && MONITOR_CANCEL_CODES.has(code)) return;
              if (started && !intentionalDisconnect && connection) {
                emit('error', 'Heart-rate notifications were interrupted.');
              }
              return;
            }
            if (!characteristic?.value || !started) return;
            const t = now();
            const data = measurementToData(base64ToBytes(characteristic.value), t);
            if (!data) return;
            lastSampleAt = t;
            if (!streaming || data.contact !== contact) {
              streaming = true;
              contact = data.contact;
              emit('streaming');
            }
            listener?.onData([data.sample], data.rr);
          } catch {
            // Never throw out of a BLE callback.
          }
        },
      );
      monitorSub = self;
    } catch {
      emit('error', 'Could not subscribe to heart-rate notifications.');
    }
  }

  function watchDisconnect(id: string): void {
    removeDisconnectWatch();
    try {
      disconnectSub = getManager().onDeviceDisconnected(id, () => {
        try {
          removeMonitor();
          streaming = false;
          if (intentionalDisconnect || !started) {
            emit('disconnected');
            return;
          }
          scheduleReconnect();
        } catch {
          // ignore
        }
      });
    } catch {
      // ignore: reconnect will not be automatic, but data flow is unaffected
    }
  }

  function scheduleReconnect(reason?: string): void {
    clearReconnect();
    attempt += 1;
    emit('reconnecting', reason ?? `Connection lost. Reconnecting (attempt ${attempt})…`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void tryReconnect();
    }, backoffDelayMs(attempt));
  }

  async function tryReconnect(): Promise<void> {
    const conn = connection;
    if (!started || intentionalDisconnect || !conn) return;
    try {
      const manager = getManager();
      const state = await manager.state();
      if (state !== State.PoweredOn) {
        // Say why (e.g. Bluetooth switched off) instead of a generic reconnect loop; keep retrying.
        if (started && !intentionalDisconnect) scheduleReconnect(adapterLostMessage(state));
        return;
      }
      await manager.connectToDevice(conn.id, { timeout: CONNECT_TIMEOUT_MS });
      await manager.discoverAllServicesAndCharacteristicsForDevice(conn.id);
      if (!started || intentionalDisconnect) return;
      battery = (await readBattery(conn.id)) ?? battery;
      watchDisconnect(conn.id);
      subscribe(conn.id);
      attempt = 0;
      emit('connected');
    } catch {
      if (started && !intentionalDisconnect) scheduleReconnect();
    }
  }

  const source: HeartRateSource = {
    kind: 'ble',
    label: 'Bluetooth heart-rate sensor',
    canScan: true,

    async isSupported() {
      if (Platform.OS !== 'ios' && Platform.OS !== 'android') return false;
      try {
        // Throws when the native module is missing (e.g. Expo Go).
        const state = await getManager().state();
        return state !== State.Unsupported;
      } catch {
        return false;
      }
    },

    async requestPermissions() {
      if (!(await requestAndroid())) return false;
      const state = await waitForAdapter(getManager(), adapterTimeout);
      if (state === State.Unauthorized) return false;
      if (state !== State.PoweredOn) throw new Error(adapterMessage(state));
      return true;
    },

    scan(onDevice: (device: DiscoveredDevice) => void, opts?: { timeoutMs?: number; showAll?: boolean }) {
      const timeoutMs = opts?.timeoutMs ?? scanTimeoutDefault;
      const showAll = opts?.showAll ?? false;
      const seen = new Set<string>();
      let stopped = false;
      let scanning = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        if (timer !== null) clearTimeout(timer);
        if (scanning) safely(() => getManager().stopDeviceScan());
      };

      void (async () => {
        try {
          const state = await waitForAdapter(getManager(), adapterTimeout);
          if (stopped || state !== State.PoweredOn) {
            stop();
            return;
          }
          timer = setTimeout(stop, timeoutMs);
          scanning = true;
          await getManager().startDeviceScan(
            showAll ? null : [HEART_RATE_SERVICE],
            { allowDuplicates: false },
            (error, device) => {
              try {
                if (stopped) return;
                if (error) {
                  stop();
                  return;
                }
                if (!device || seen.has(device.id)) return;
                const advertisesHeartRate = (device.serviceUUIDs ?? []).some(
                  (u) => normalizeUuid(u) === HR_SERVICE_NORMALIZED,
                );
                const name = deviceDisplayName(device);
                // In "show all" mode, skip anonymous non-HR devices (beacons, headphones…).
                if (!name && !advertisesHeartRate) return;
                seen.add(device.id);
                const found: DiscoveredDevice = {
                  id: device.id,
                  name: name ?? 'Heart-rate sensor',
                  advertisesHeartRate: advertisesHeartRate || !showAll,
                };
                if (device.rssi !== null && device.rssi !== undefined) found.rssi = device.rssi;
                onDevice(found);
              } catch {
                // Never throw out of a BLE callback.
              }
            },
          );
        } catch {
          stop();
        }
      })();

      return stop;
    },

    async connect(deviceId?: string): Promise<SensorInfo> {
      const id = deviceId ?? connection?.id;
      if (!id) throw new Error('Choose a heart-rate sensor to connect to.');
      if (connection && connection.id === id && !intentionalDisconnect) {
        // Already connected (or auto-reconnecting) to this device.
        const current: SensorInfo = { source: 'ble', name: connection.name, id };
        if (connection.location) current.location = connection.location;
        return current;
      }
      if (connection && connection.id !== id) await source.disconnect();
      await ensureReady();
      intentionalDisconnect = false;
      const manager = getManager();
      let device;
      try {
        device = await manager.connectToDevice(id, { timeout: CONNECT_TIMEOUT_MS });
        await manager.discoverAllServicesAndCharacteristicsForDevice(id);
      } catch {
        safely(() => manager.cancelDeviceConnection(id));
        throw new Error('Could not connect to the sensor. Make sure it is worn (moistened chest strap) and nearby.');
      }
      const name = deviceDisplayName(device) ?? 'Heart-rate sensor';
      const location = await readLocation(id);
      battery = await readBattery(id);
      contact = undefined;
      lastSampleAt = undefined;
      connection = location ? { id, name, location } : { id, name };
      watchDisconnect(id);
      const info: SensorInfo = { source: 'ble', name, id };
      if (location) info.location = location;
      return info;
    },

    async start(next: SensorListener) {
      if (!connection) throw new Error('Connect to a sensor before starting.');
      listener = next;
      started = true;
      attempt = 0;
      subscribe(connection.id);
      startBatteryRefresh();
      emit('connected');
    },

    async stop() {
      started = false;
      clearReconnect();
      stopBatteryRefresh();
      removeMonitor();
      streaming = false;
      attempt = 0;
    },

    async disconnect() {
      await source.stop();
      intentionalDisconnect = true;
      removeDisconnectWatch();
      const conn = connection;
      if (conn) {
        try {
          await getManager().cancelDeviceConnection(conn.id);
        } catch {
          // Already disconnected.
        }
      }
      emit('disconnected');
      connection = null;
      listener = null;
      battery = undefined;
      contact = undefined;
    },
  };
  return source;
}
