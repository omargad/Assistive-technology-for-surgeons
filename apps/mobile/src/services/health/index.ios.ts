/**
 * Health-store import for iOS: Apple Health via
 * `@kingstinct/react-native-healthkit` (v16, Nitro modules).
 *
 * Reads, for the session window:
 * - heart-rate quantity samples (bpm),
 * - HRV SDNN quantity samples (Apple stores SDNN, not raw RR),
 * - heartbeat series (beat-to-beat timings recorded by Apple Watch during
 *   some measurements), converted to RR intervals when present.
 *
 * HealthKit never reveals whether *read* access was granted, so
 * `requestAccess()` resolves true once the request has been presented; an
 * import with no data is the only signal of missing access.
 */
import {
  isHealthDataAvailableAsync,
  queryHeartbeatSeriesSamples,
  queryQuantitySamples,
  requestAuthorization,
} from '@kingstinct/react-native-healthkit';
import type { ExternalHrvReading, HeartRateSample, RRInterval } from '@surgeonpulse/core';
import { buildImportResult, heartbeatsToRr } from './mapping';
import type { HealthImportResult, HealthStore } from './types';

const HEART_RATE = 'HKQuantityTypeIdentifierHeartRate';
const HRV_SDNN = 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN';
const HEARTBEAT_SERIES = 'HKDataTypeIdentifierHeartbeatSeries';

function dateFilter(start: number, end: number) {
  return { date: { startDate: new Date(start), endDate: new Date(end) } };
}

async function readHeartRate(start: number, end: number): Promise<HeartRateSample[]> {
  const rows = await queryQuantitySamples(HEART_RATE, {
    limit: 0, // 0 = all samples
    ascending: true,
    unit: 'count/min',
    filter: dateFilter(start, end),
  });
  return rows.map((r) => ({ t: r.startDate.getTime(), bpm: r.quantity }));
}

async function readSdnn(start: number, end: number): Promise<ExternalHrvReading[]> {
  try {
    const rows = await queryQuantitySamples(HRV_SDNN, {
      limit: 0,
      ascending: true,
      unit: 'ms',
      filter: dateFilter(start, end),
    });
    return rows.map((r) => ({ t: r.startDate.getTime(), metric: 'sdnn', ms: r.quantity, source: 'healthkit' }));
  } catch {
    return []; // HRV is optional
  }
}

async function readHeartbeats(start: number, end: number): Promise<RRInterval[]> {
  try {
    const series = await queryHeartbeatSeriesSamples({ limit: 0, ascending: true, filter: dateFilter(start, end) });
    const out: RRInterval[] = [];
    for (const s of series) out.push(...heartbeatsToRr(s.startDate.getTime(), s.heartbeats, start, end));
    return out;
  } catch {
    return []; // heartbeat series are rare and optional
  }
}

export const healthStore: HealthStore = {
  source: 'healthkit',
  label: 'Apple Health',

  async isAvailable() {
    try {
      return await isHealthDataAvailableAsync();
    } catch {
      return false; // native module missing (e.g. Expo Go) or iPad without Health
    }
  },

  async requestAccess() {
    try {
      if (!(await isHealthDataAvailableAsync())) return false;
      return await requestAuthorization({ toRead: [HEART_RATE, HRV_SDNN, HEARTBEAT_SERIES] });
    } catch {
      return false;
    }
  },

  async importRange(start: number, end: number): Promise<HealthImportResult> {
    if (!(end > start)) throw new Error('The session has no valid time window to import.');
    let samples: HeartRateSample[];
    try {
      samples = await readHeartRate(start, end);
    } catch {
      throw new Error('Could not read heart rate from Apple Health. Check access in Settings › Health › Data Access.');
    }
    const [externalHrv, rr] = await Promise.all([readSdnn(start, end), readHeartbeats(start, end)]);
    return buildImportResult('healthkit', start, end, { samples, rr, externalHrv });
  },
};
