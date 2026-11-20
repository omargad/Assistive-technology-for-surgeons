import { describe, expect, it } from 'vitest';
import {
  BATTERY_LEVEL,
  BATTERY_SERVICE,
  BODY_SENSOR_LOCATION,
  DEVICE_INFORMATION_SERVICE,
  HEART_RATE_MEASUREMENT,
  HEART_RATE_SERVICE,
  base64ToBytes,
  bytesToBase64,
  parseBatteryLevel,
  parseBodySensorLocation,
  parseHeartRateMeasurement,
} from '../src/ble/heartRate';

describe('GATT UUIDs', () => {
  it('are full 128-bit lowercase UUIDs on the Bluetooth base', () => {
    const expected: Record<string, string> = {
      '180d': HEART_RATE_SERVICE,
      '2a37': HEART_RATE_MEASUREMENT,
      '2a38': BODY_SENSOR_LOCATION,
      '180f': BATTERY_SERVICE,
      '2a19': BATTERY_LEVEL,
      '180a': DEVICE_INFORMATION_SERVICE,
    };
    for (const [short, full] of Object.entries(expected)) {
      expect(full).toBe(`0000${short}-0000-1000-8000-00805f9b34fb`);
    }
  });
});

describe('parseHeartRateMeasurement', () => {
  it('parses a typical Polar H10 notification: uint8 HR + one RR (flags 0x10)', () => {
    const m = parseHeartRateMeasurement([0x10, 0x48, 0x2c, 0x03]);
    // 0x032c = 812 / 1024 s = 792.96875 ms → 792.969
    expect(m).toStrictEqual({ bpm: 72, contactSupported: false, rrMs: [792.969] });
    expect('contact' in m).toBe(false);
    expect('energyExpendedKj' in m).toBe(false);
  });

  it('parses the same payload delivered as base64 by react-native-ble-plx', () => {
    // Polar H10 normally reports contact supported + detected: flags 0x16.
    expect(bytesToBase64([0x16, 0x48, 0x2c, 0x03])).toBe('FkgsAw==');
    expect(parseHeartRateMeasurement(base64ToBytes('FkgsAw=='))).toStrictEqual({
      bpm: 72,
      contactSupported: true,
      contact: true,
      rrMs: [792.969],
    });
  });

  it('reads a uint16 heart-rate value (flags bit 0)', () => {
    expect(parseHeartRateMeasurement([0x01, 0x48, 0x00]).bpm).toBe(72);
    expect(parseHeartRateMeasurement([0x01, 0x00, 0x01]).bpm).toBe(256);
    expect(parseHeartRateMeasurement(new Uint8Array([0x01, 0xb4, 0x00])).bpm).toBe(180);
  });

  it('reports sensor contact only when the sensor supports it (bits 1–2)', () => {
    expect(parseHeartRateMeasurement([0x06, 0x50])).toStrictEqual({
      bpm: 80,
      contactSupported: true,
      contact: true,
      rrMs: [],
    });
    expect(parseHeartRateMeasurement([0x04, 0x00])).toStrictEqual({
      bpm: 0,
      contactSupported: true,
      contact: false,
      rrMs: [],
    });
    // Not supported: bit 1 must be ignored and `contact` left undefined.
    for (const flags of [0x00, 0x02]) {
      const m = parseHeartRateMeasurement([flags, 0x50]);
      expect(m.contactSupported).toBe(false);
      expect('contact' in m).toBe(false);
    }
  });

  it('reads Energy Expended (bit 3) before the RR intervals', () => {
    // flags 0x18: energy + RR; HR 80; energy 0x2710 = 10000 kJ; RR 0x0400 = 1024/1024 s = 1000 ms
    expect(parseHeartRateMeasurement([0x18, 0x50, 0x10, 0x27, 0x00, 0x04])).toStrictEqual({
      bpm: 80,
      contactSupported: false,
      energyExpendedKj: 10000,
      rrMs: [1000],
    });
    // uint16 HR + contact + energy + RR all together (flags 0x1f)
    expect(parseHeartRateMeasurement([0x1f, 0x48, 0x00, 0x34, 0x12, 0x00, 0x04])).toStrictEqual({
      bpm: 72,
      contactSupported: true,
      contact: true,
      energyExpendedKj: 0x1234,
      rrMs: [1000],
    });
  });

  it('reads several RR intervals in beat order and rounds to 3 decimals', () => {
    const m = parseHeartRateMeasurement([0x10, 0x40, 0x00, 0x04, 0x00, 0x02, 0xff, 0x03, 0x01, 0x00]);
    // 1024 → 1000; 512 → 500; 1023 → 999.0234375; 1 → 0.9765625
    expect(m.rrMs).toEqual([1000, 500, 999.023, 0.977]);
  });

  it('ignores a trailing odd byte in the RR field', () => {
    expect(parseHeartRateMeasurement([0x10, 0x48, 0x00, 0x04, 0x07]).rrMs).toEqual([1000]);
    expect(parseHeartRateMeasurement([0x10, 0x48, 0x2c]).rrMs).toEqual([]);
  });

  it('accepts an RR flag with no RR value (sensor saw no beat in this notification)', () => {
    expect(parseHeartRateMeasurement([0x10, 0x48])).toStrictEqual({ bpm: 72, contactSupported: false, rrMs: [] });
  });

  it('ignores RR bytes when the RR flag is clear', () => {
    expect(parseHeartRateMeasurement([0x00, 0x48, 0x00, 0x04]).rrMs).toEqual([]);
  });

  it('throws RangeError on truncated payloads', () => {
    expect(() => parseHeartRateMeasurement([])).toThrow(RangeError);
    expect(() => parseHeartRateMeasurement(new Uint8Array(0))).toThrow(RangeError);
    expect(() => parseHeartRateMeasurement([0x00])).toThrow(RangeError); // uint8 HR missing
    expect(() => parseHeartRateMeasurement([0x01, 0x48])).toThrow(RangeError); // uint16 HR half missing
    expect(() => parseHeartRateMeasurement([0x08, 0x48])).toThrow(RangeError); // energy missing
    expect(() => parseHeartRateMeasurement([0x08, 0x48, 0x10])).toThrow(RangeError); // energy half missing
    expect(() => parseHeartRateMeasurement([0x19, 0x48, 0x00, 0x10])).toThrow(/energy/);
  });

  it('throws RangeError on values that are not bytes', () => {
    expect(() => parseHeartRateMeasurement([0x00, 300])).toThrow(RangeError);
    expect(() => parseHeartRateMeasurement([0x00, -1])).toThrow(RangeError);
    expect(() => parseHeartRateMeasurement([0x00, 1.5])).toThrow(RangeError);
  });
});

describe('parseBodySensorLocation', () => {
  it('maps the GATT 0x2A38 values', () => {
    const expected = ['other', 'chest', 'wrist', 'finger', 'hand', 'ear-lobe', 'foot'];
    expected.forEach((loc, value) => expect(parseBodySensorLocation([value])).toBe(loc));
  });

  it('returns unknown for reserved values and empty payloads', () => {
    expect(parseBodySensorLocation([7])).toBe('unknown');
    expect(parseBodySensorLocation([255])).toBe('unknown');
    expect(parseBodySensorLocation([])).toBe('unknown');
  });
});

describe('parseBatteryLevel', () => {
  it('reads a uint8 percentage, clamping reserved values to 100', () => {
    expect(parseBatteryLevel([87])).toBe(87);
    expect(parseBatteryLevel(new Uint8Array([0]))).toBe(0);
    expect(parseBatteryLevel([100])).toBe(100);
    expect(parseBatteryLevel([255])).toBe(100);
  });

  it('throws on an empty payload', () => {
    expect(() => parseBatteryLevel([])).toThrow(RangeError);
  });
});

describe('base64', () => {
  const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

  // RFC 4648 §10 test vectors
  const vectors: [string, string][] = [
    ['', ''],
    ['f', 'Zg=='],
    ['fo', 'Zm8='],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg=='],
    ['fooba', 'Zm9vYmE='],
    ['foobar', 'Zm9vYmFy'],
  ];

  it('encodes the RFC 4648 test vectors', () => {
    for (const [plain, b64] of vectors) expect(bytesToBase64(ascii(plain))).toBe(b64);
  });

  it('decodes padded, unpadded and partially padded input', () => {
    for (const [plain, b64] of vectors) {
      expect(Array.from(base64ToBytes(b64))).toEqual(ascii(plain));
      expect(Array.from(base64ToBytes(b64.replace(/=+$/, '')))).toEqual(ascii(plain));
    }
    expect(Array.from(base64ToBytes('Zg='))).toEqual(ascii('f'));
  });

  it('decodes the URL-safe alphabet and ignores whitespace', () => {
    expect(bytesToBase64([0xfb, 0xff, 0xbf])).toBe('+/+/');
    expect(Array.from(base64ToBytes('-_-_'))).toEqual([0xfb, 0xff, 0xbf]);
    expect(Array.from(base64ToBytes(' Zm9v\r\nYmFy\t'))).toEqual(ascii('foobar'));
  });

  it('returns a Uint8Array', () => {
    expect(base64ToBytes('AAEC')).toBeInstanceOf(Uint8Array);
    expect(Array.from(base64ToBytes('AAEC'))).toEqual([0, 1, 2]);
  });

  it('round-trips every byte value and every length up to 300', () => {
    const all = Array.from({ length: 256 }, (_, i) => i);
    expect(Array.from(base64ToBytes(bytesToBase64(all)))).toEqual(all);
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed >>> 24;
    };
    for (let len = 0; len <= 300; len++) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = next();
      const b64 = bytesToBase64(bytes);
      expect(b64.length % 4).toBe(0);
      expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(bytes));
    }
  });

  it("matches the platform's btoa where one exists", () => {
    const btoa = (globalThis as { btoa?: (s: string) => string }).btoa;
    if (typeof btoa !== 'function') return;
    const bytes = Array.from({ length: 1000 }, (_, i) => (i * 37 + 11) & 0xff);
    expect(bytesToBase64(bytes)).toBe(btoa(String.fromCharCode(...bytes)));
  });

  it('rejects malformed base64', () => {
    expect(() => base64ToBytes('Zm9v!')).toThrow(SyntaxError);
    expect(() => base64ToBytes('Zm9vé')).toThrow(SyntaxError);
    expect(() => base64ToBytes('Z')).toThrow(SyntaxError); // one leftover character cannot encode a byte
    expect(() => base64ToBytes('Zm9vY')).toThrow(SyntaxError);
    expect(() => base64ToBytes('Zg===')).toThrow(SyntaxError);
    expect(() => base64ToBytes('Zm9v=')).toThrow(SyntaxError);
    expect(() => base64ToBytes('Zg==Zg==')).toThrow(SyntaxError);
  });

  it('rejects values that are not bytes when encoding', () => {
    expect(() => bytesToBase64([256])).toThrow(RangeError);
    expect(() => bytesToBase64([-1])).toThrow(RangeError);
    expect(() => bytesToBase64([1.5])).toThrow(RangeError);
  });
});
