/**
 * Convert a raw Heart Rate Measurement (GATT 0x2A37) notification into app
 * data, using the core parser. Shared by the native and Web Bluetooth sources.
 */
import { parseHeartRateMeasurement } from '@surgeonpulse/core';
import type { HeartRateSample, RRInterval } from '@surgeonpulse/core';

/** How often a live source re-reads the battery level during a recording (a strap can run flat mid-case). */
export const BATTERY_REFRESH_MS = 5 * 60_000;

export interface MeasurementData {
  sample: HeartRateSample;
  rr: RRInterval[];
  /** Sensor contact, undefined when the sensor does not report it. */
  contact: boolean | undefined;
}

/**
 * Parse `bytes` received at wall-clock time `t`. Returns `null` for a
 * malformed/truncated payload (never throws — BLE callbacks must not throw).
 */
export function measurementToData(bytes: ArrayLike<number>, t: number): MeasurementData | null {
  try {
    const m = parseHeartRateMeasurement(bytes);
    const contact = m.contactSupported ? m.contact : undefined;
    const sample: HeartRateSample = contact === undefined ? { t, bpm: m.bpm } : { t, bpm: m.bpm, contact };
    const rr: RRInterval[] = m.rrMs.map((ms) => ({ t, ms }));
    return { sample, rr, contact };
  } catch {
    return null;
  }
}

/** Normalise a 16- or 128-bit UUID string for comparison. */
export function normalizeUuid(uuid: string): string {
  const u = uuid.trim().toLowerCase();
  if (/^[0-9a-f]{4}$/.test(u)) return `0000${u}-0000-1000-8000-00805f9b34fb`;
  if (/^[0-9a-f]{8}$/.test(u)) return `${u}-0000-1000-8000-00805f9b34fb`;
  return u;
}
