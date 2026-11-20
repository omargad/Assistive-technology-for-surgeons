import type {
  HeartRateSample,
  MarkerKind,
  PhaseKind,
  RRInterval,
  SensorInfo,
  SensorSourceKind,
} from '@surgeonpulse/core';

/** Connection lifecycle of a live heart-rate source. */
export type SensorState =
  | 'idle'
  | 'unsupported'
  | 'permission-denied'
  | 'scanning'
  | 'connecting'
  | 'connected'
  | 'streaming'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

export interface SensorStatus {
  state: SensorState;
  /** Human-readable detail for the UI (e.g. "Bluetooth is off", "Reconnecting (attempt 3)"). */
  message?: string;
  deviceName?: string;
  /** Battery level 0–100 when the device exposes the Battery Service. */
  battery?: number;
  /** Skin contact from the HR measurement flags (undefined when unsupported). */
  contact?: boolean;
  /** Time of the most recent sample (epoch ms). */
  lastSampleAt?: number;
}

export interface DiscoveredDevice {
  id: string;
  name: string;
  rssi?: number;
  /** True when the advertisement included the Heart Rate service UUID. */
  advertisesHeartRate: boolean;
}

export interface SensorListener {
  /** Called with newly received data. `t` values are wall-clock epoch ms. */
  onData(samples: HeartRateSample[], rr: RRInterval[]): void;
  onStatus(status: SensorStatus): void;
}

/**
 * A live heart-rate source. Implementations:
 * - `ble`            — react-native-ble-plx (iOS/Android), file `ble.native.ts`
 * - `web-bluetooth`  — Web Bluetooth API (Chrome/Edge/Android browsers), file `ble.web.ts`
 * - `simulated`      — core `createLiveSimulator`, all platforms, file `simulated.ts`
 *
 * Platform health stores (Apple Health / Health Connect) are not live sources;
 * they are imported after the case — see `services/health`.
 */
export interface HeartRateSource {
  readonly kind: SensorSourceKind;
  /** Short label for pickers, e.g. "Bluetooth heart-rate sensor". */
  readonly label: string;
  /** Whether the platform/runtime supports this source at all. */
  isSupported(): Promise<boolean>;
  /** Request runtime permissions (Android BLE perms, etc.). Resolves false if denied. */
  requestPermissions(): Promise<boolean>;
  /** True when `scan` is meaningful (native BLE). Web Bluetooth uses the browser chooser in `connect`. */
  readonly canScan: boolean;
  /**
   * Scan for devices. Calls `onDevice` for each unique device. Stops automatically after `timeoutMs`.
   * Returns a function that stops the scan early.
   */
  scan(onDevice: (device: DiscoveredDevice) => void, opts?: { timeoutMs?: number; showAll?: boolean }): () => void;
  /** Connect (to `deviceId` when given; Web Bluetooth shows a chooser). Resolves with sensor metadata. */
  connect(deviceId?: string): Promise<SensorInfo>;
  /**
   * Begin delivering data to `listener`. Must survive transient disconnections by
   * reconnecting automatically (exponential back-off, capped at 30 s) until `stop()`.
   */
  start(listener: SensorListener): Promise<void>;
  /** Stop delivering data (keeps the connection when possible). */
  stop(): Promise<void>;
  /** Tear down the connection and release resources. Safe to call multiple times. */
  disconnect(): Promise<void>;
  /** Simulator only: reflect operative context so the demo responds realistically. */
  onPhase?(phase: PhaseKind): void;
  onMarker?(marker: MarkerKind): void;
}

/** Sources offered on the current platform, in display order. */
export type SourceChoice = Extract<SensorSourceKind, 'ble' | 'web-bluetooth' | 'simulated' | 'healthkit' | 'health-connect'>;
