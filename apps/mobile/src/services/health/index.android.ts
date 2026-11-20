/**
 * Health-store import for Android: Health Connect via
 * `react-native-health-connect` (v4).
 *
 * Reads `HeartRate` records (series of bpm samples) and
 * `HeartRateVariabilityRmssd` records for the session window, following page
 * tokens. Health Connect does not store raw RR intervals.
 */
import {
  SdkAvailabilityStatus,
  getGrantedPermissions,
  getSdkStatus,
  initialize,
  readRecords,
  requestPermission,
} from 'react-native-health-connect';
import type { Permission, ReadRecordsResult } from 'react-native-health-connect';
import type { ExternalHrvReading, HeartRateSample } from '@surgeonpulse/core';
import { buildImportResult, healthConnectHeartRate, healthConnectRmssd } from './mapping';
import type { HealthImportResult, HealthStore } from './types';

const PERMISSIONS: Permission[] = [
  { accessType: 'read', recordType: 'HeartRate' },
  { accessType: 'read', recordType: 'HeartRateVariabilityRmssd' },
];
const PAGE_SIZE = 1000;
/** Safety cap on pages per record type (1000 × 200 = 200k records). */
const MAX_PAGES = 200;

let initialized: Promise<boolean> | null = null;

function ensureInitialized(): Promise<boolean> {
  if (!initialized) {
    initialized = initialize().catch(() => false);
    void initialized.then((ok) => {
      if (!ok) initialized = null; // allow a retry later
    });
  }
  return initialized;
}

async function sdkAvailable(): Promise<boolean> {
  try {
    return (await getSdkStatus()) === SdkAvailabilityStatus.SDK_AVAILABLE;
  } catch {
    return false;
  }
}

async function readAll<T extends 'HeartRate' | 'HeartRateVariabilityRmssd'>(
  recordType: T,
  start: number,
  end: number,
): Promise<ReadRecordsResult<T>['records']> {
  const out: ReadRecordsResult<T>['records'] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const options = {
      timeRangeFilter: {
        operator: 'between' as const,
        startTime: new Date(start).toISOString(),
        endTime: new Date(end).toISOString(),
      },
      ascendingOrder: true,
      pageSize: PAGE_SIZE,
      ...(pageToken ? { pageToken } : {}),
    };
    const result = await readRecords(recordType, options);
    out.push(...result.records);
    if (!result.pageToken) break;
    pageToken = result.pageToken;
  }
  return out;
}

export const healthStore: HealthStore = {
  source: 'health-connect',
  label: 'Health Connect',

  async isAvailable() {
    if (!(await sdkAvailable())) return false;
    return ensureInitialized();
  },

  async requestAccess() {
    try {
      if (!(await sdkAvailable()) || !(await ensureInitialized())) return false;
      const granted = await requestPermission(PERMISSIONS);
      return granted.some((p) => p.accessType === 'read' && p.recordType === 'HeartRate');
    } catch {
      return false;
    }
  },

  async importRange(start: number, end: number): Promise<HealthImportResult> {
    if (!(end > start)) throw new Error('The session has no valid time window to import.');
    if (!(await sdkAvailable()) || !(await ensureInitialized())) {
      throw new Error('Health Connect is not available. Install or update it from the Play Store.');
    }
    const granted = await getGrantedPermissions().catch(() => []);
    const canReadHr = granted.some((p) => p.accessType === 'read' && p.recordType === 'HeartRate');
    if (!canReadHr) throw new Error('Allow SurgeonPulse to read heart rate in Health Connect, then try again.');

    let samples: HeartRateSample[];
    try {
      samples = healthConnectHeartRate(await readAll('HeartRate', start, end));
    } catch {
      throw new Error('Could not read heart rate from Health Connect.');
    }
    let externalHrv: ExternalHrvReading[] = [];
    try {
      externalHrv = healthConnectRmssd(await readAll('HeartRateVariabilityRmssd', start, end));
    } catch {
      externalHrv = []; // HRV permission is optional
    }
    return buildImportResult('health-connect', start, end, { samples, externalHrv });
  },
};
