/**
 * Bluetooth LE Heart Rate Profile helpers.
 *
 * Pure parsing of GATT characteristic values, shared by the native BLE stack
 * (react-native-ble-plx, which hands values over as base64 strings), Web
 * Bluetooth (`DataView`/`Uint8Array`) and server-side imports. No `Buffer`,
 * `atob`/`btoa` or `DataView` dependency, so it runs unchanged on Hermes.
 *
 * Reference: Bluetooth SIG, Heart Rate Service 1.0 and the GATT Specification
 * Supplement (Heart Rate Measurement 0x2A37, Body Sensor Location 0x2A38,
 * Battery Level 0x2A19).
 */

/** Heart Rate service (0x180D). */
export const HEART_RATE_SERVICE = '0000180d-0000-1000-8000-00805f9b34fb';
/** Heart Rate Measurement characteristic (0x2A37, notify). */
export const HEART_RATE_MEASUREMENT = '00002a37-0000-1000-8000-00805f9b34fb';
/** Body Sensor Location characteristic (0x2A38, read). */
export const BODY_SENSOR_LOCATION = '00002a38-0000-1000-8000-00805f9b34fb';
/** Battery service (0x180F). */
export const BATTERY_SERVICE = '0000180f-0000-1000-8000-00805f9b34fb';
/** Battery Level characteristic (0x2A19, read/notify). */
export const BATTERY_LEVEL = '00002a19-0000-1000-8000-00805f9b34fb';
/** Device Information service (0x180A). */
export const DEVICE_INFORMATION_SERVICE = '0000180a-0000-1000-8000-00805f9b34fb';

/** Decoded Heart Rate Measurement (0x2A37) notification. */
export interface HeartRateMeasurement {
  /** Heart rate, bpm (uint8 or uint16 on the wire). */
  bpm: number;
  /** Whether the sensor supports skin-contact detection (flags bit 2). */
  contactSupported: boolean;
  /** Skin contact detected (flags bit 1). Only defined when `contactSupported`. */
  contact?: boolean;
  /** Cumulative energy expended since last reset, kJ. Only defined when present (flags bit 3). */
  energyExpendedKj?: number;
  /** RR intervals in this notification, in beat order, milliseconds rounded to 3 decimals. */
  rrMs: number[];
}

/** Values of the Body Sensor Location characteristic (0x2A38). */
export type BodySensorLocation = 'other' | 'chest' | 'wrist' | 'finger' | 'hand' | 'ear-lobe' | 'foot' | 'unknown';

const BODY_SENSOR_LOCATIONS: readonly BodySensorLocation[] = [
  'other',
  'chest',
  'wrist',
  'finger',
  'hand',
  'ear-lobe',
  'foot',
];

/** Read one byte, validating that the value really is a byte. */
function byteAt(data: ArrayLike<number>, index: number): number {
  const v = data[index];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255) {
    throw new RangeError(`Byte ${index} is not an integer in 0–255: ${String(v)}`);
  }
  return v;
}

/** Read a little-endian uint16 at `offset`, throwing if the payload is too short. */
function uint16At(data: ArrayLike<number>, offset: number, field: string): number {
  if (offset + 2 > data.length) {
    throw new RangeError(
      `Truncated payload: ${field} needs bytes ${offset}–${offset + 1} but only ${data.length} byte(s) received`,
    );
  }
  return byteAt(data, offset) | (byteAt(data, offset + 1) << 8);
}

/** Convert a raw RR value (units of 1/1024 s) to milliseconds, rounded to 3 decimals. */
function rrRawToMs(raw: number): number {
  return Math.round((raw * 1000 * 1000) / 1024) / 1000;
}

/**
 * Parse a Heart Rate Measurement (GATT 0x2A37) characteristic value.
 *
 * Layout (little-endian), per the Bluetooth SIG Heart Rate Service spec:
 * - byte 0 – flags
 *   - bit 0: HR value format (0 → uint8, 1 → uint16)
 *   - bit 1: sensor contact detected
 *   - bit 2: sensor contact supported (`contact` is only reported when set)
 *   - bit 3: Energy Expended present (uint16, kJ)
 *   - bit 4: RR-Interval present
 * - HR value (1 or 2 bytes)
 * - Energy Expended (2 bytes) if bit 3
 * - RR-Intervals: uint16 values in units of 1/1024 s until the payload ends.
 *   Each is converted to ms as `raw · 1000 / 1024`, rounded to 3 decimals.
 *   A trailing odd byte is ignored, as is an RR flag with no complete value
 *   (some sensors set bit 4 on notifications in which no beat occurred).
 *
 * Example (Polar H10): `[0x10, 0x48, 0x2c, 0x03]` → `{ bpm: 72, contactSupported: false, rrMs: [792.969] }`.
 *
 * @param data Raw bytes (`Uint8Array`, `number[]`, …). Use {@link base64ToBytes} for react-native-ble-plx values.
 * @throws RangeError if the payload is shorter than the mandatory fields its flags announce, or contains non-byte values.
 */
export function parseHeartRateMeasurement(data: ArrayLike<number>): HeartRateMeasurement {
  if (data.length < 1) throw new RangeError('Truncated payload: Heart Rate Measurement is empty');
  const flags = byteAt(data, 0);
  const hrIsUint16 = (flags & 0x01) !== 0;
  const contactDetected = (flags & 0x02) !== 0;
  const contactSupported = (flags & 0x04) !== 0;
  const energyPresent = (flags & 0x08) !== 0;
  const rrPresent = (flags & 0x10) !== 0;

  let offset = 1;
  let bpm: number;
  if (hrIsUint16) {
    bpm = uint16At(data, offset, 'uint16 heart rate');
    offset += 2;
  } else {
    if (offset + 1 > data.length) {
      throw new RangeError('Truncated payload: uint8 heart rate missing (only the flags byte received)');
    }
    bpm = byteAt(data, offset);
    offset += 1;
  }

  const result: HeartRateMeasurement = { bpm, contactSupported, rrMs: [] };
  if (contactSupported) result.contact = contactDetected;

  if (energyPresent) {
    result.energyExpendedKj = uint16At(data, offset, 'energy expended');
    offset += 2;
  }

  if (rrPresent) {
    for (; offset + 1 < data.length; offset += 2) {
      result.rrMs.push(rrRawToMs(uint16At(data, offset, 'RR interval')));
    }
  }
  return result;
}

/**
 * Parse a Body Sensor Location (GATT 0x2A38) value: 0 other, 1 chest,
 * 2 wrist, 3 finger, 4 hand, 5 ear lobe, 6 foot. Reserved values (7–255) and
 * an empty payload give `'unknown'`.
 */
export function parseBodySensorLocation(data: ArrayLike<number>): BodySensorLocation {
  if (data.length < 1) return 'unknown';
  const v = data[0];
  if (typeof v !== 'number' || !Number.isInteger(v)) return 'unknown';
  return BODY_SENSOR_LOCATIONS[v] ?? 'unknown';
}

/**
 * Parse a Battery Level (GATT 0x2A19) value: a uint8 percentage. Values above
 * 100 are reserved by the spec and are clamped to 100.
 *
 * @throws RangeError on an empty payload or a non-byte value.
 */
export function parseBatteryLevel(data: ArrayLike<number>): number {
  if (data.length < 1) throw new RangeError('Truncated payload: Battery Level is empty');
  return Math.min(100, byteAt(data, 0));
}

// ---------------------------------------------------------------------------
// Base64 (RFC 4648) — pure JS
// ---------------------------------------------------------------------------

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Reverse lookup for both the standard (`+/`) and URL-safe (`-_`) alphabets; -1 = invalid. */
const B64_LOOKUP: Int16Array = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) table[B64_ALPHABET.charCodeAt(i)] = i;
  table['-'.charCodeAt(0)] = 62;
  table['_'.charCodeAt(0)] = 63;
  return table;
})();

function isBase64Whitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;
}

/**
 * Decode a base64 string (RFC 4648) to bytes without `atob` or `Buffer`.
 *
 * Accepts the standard and URL-safe alphabets, with full, partial or no `=`
 * padding, and ignores ASCII whitespace (line-wrapped input). Used to decode
 * characteristic values delivered by react-native-ble-plx.
 *
 * @throws SyntaxError on characters outside the alphabet, `=` before the end,
 * or a length that cannot encode whole bytes (one leftover character).
 */
export function base64ToBytes(b64: string): Uint8Array {
  const sextets: number[] = [];
  let padding = 0;
  for (let i = 0; i < b64.length; i++) {
    const code = b64.charCodeAt(i);
    if (isBase64Whitespace(code)) continue;
    if (code === 0x3d /* '=' */) {
      padding++;
      continue;
    }
    if (padding > 0) throw new SyntaxError(`Invalid base64: data after padding at index ${i}`);
    const v = code < 128 ? (B64_LOOKUP[code] ?? -1) : -1;
    if (v < 0) throw new SyntaxError(`Invalid base64 character ${JSON.stringify(b64.charAt(i))} at index ${i}`);
    sextets.push(v);
  }
  const rem = sextets.length % 4;
  if (rem === 1) throw new SyntaxError('Invalid base64: truncated input');
  // Padding is optional, but when present it may not exceed what the final quantum needs.
  const maxPadding = rem === 0 ? 0 : 4 - rem;
  if (padding > maxPadding) throw new SyntaxError('Invalid base64: too much padding');

  const outLen = Math.floor(sextets.length / 4) * 3 + (rem === 0 ? 0 : rem - 1);
  const out = new Uint8Array(outLen);
  let o = 0;
  let i = 0;
  for (; i + 3 < sextets.length; i += 4) {
    const n =
      ((sextets[i] as number) << 18) |
      ((sextets[i + 1] as number) << 12) |
      ((sextets[i + 2] as number) << 6) |
      (sextets[i + 3] as number);
    out[o++] = (n >> 16) & 0xff;
    out[o++] = (n >> 8) & 0xff;
    out[o++] = n & 0xff;
  }
  if (rem === 2) {
    const n = ((sextets[i] as number) << 18) | ((sextets[i + 1] as number) << 12);
    out[o++] = (n >> 16) & 0xff;
  } else if (rem === 3) {
    const n = ((sextets[i] as number) << 18) | ((sextets[i + 1] as number) << 12) | ((sextets[i + 2] as number) << 6);
    out[o++] = (n >> 16) & 0xff;
    out[o++] = (n >> 8) & 0xff;
  }
  return out;
}

/**
 * Encode bytes as standard, padded base64 (RFC 4648 §4) without `btoa` or
 * `Buffer`. Inverse of {@link base64ToBytes}.
 *
 * @throws RangeError if an element is not an integer in 0–255.
 */
export function bytesToBase64(bytes: ArrayLike<number>): string {
  const parts: string[] = [];
  const len = bytes.length;
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const n = (byteAt(bytes, i) << 16) | (byteAt(bytes, i + 1) << 8) | byteAt(bytes, i + 2);
    parts.push(
      B64_ALPHABET.charAt((n >> 18) & 63) +
        B64_ALPHABET.charAt((n >> 12) & 63) +
        B64_ALPHABET.charAt((n >> 6) & 63) +
        B64_ALPHABET.charAt(n & 63),
    );
  }
  const rem = len - i;
  if (rem === 1) {
    const n = byteAt(bytes, i) << 16;
    parts.push(B64_ALPHABET.charAt((n >> 18) & 63) + B64_ALPHABET.charAt((n >> 12) & 63) + '==');
  } else if (rem === 2) {
    const n = (byteAt(bytes, i) << 16) | (byteAt(bytes, i + 1) << 8);
    parts.push(
      B64_ALPHABET.charAt((n >> 18) & 63) + B64_ALPHABET.charAt((n >> 12) & 63) + B64_ALPHABET.charAt((n >> 6) & 63) + '=',
    );
  }
  return parts.join('');
}
