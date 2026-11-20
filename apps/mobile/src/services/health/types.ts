import type { ExternalHrvReading, HeartRateSample, RRInterval, SensorSourceKind } from '@surgeonpulse/core';

export interface HealthImportResult {
  source: Extract<SensorSourceKind, 'healthkit' | 'health-connect'>;
  samples: HeartRateSample[];
  /** Beat-to-beat intervals when the store has them (Apple Watch heartbeat series). Often empty. */
  rr: RRInterval[];
  externalHrv: ExternalHrvReading[];
}

/**
 * Retrospective import of heart-rate data recorded by a wearable into the
 * platform health store (Apple Health on iOS, Health Connect on Android) for a
 * session's time window. Implementations: `index.ios.ts` (HealthKit),
 * `index.android.ts` (Health Connect), `index.ts` (unsupported fallback / web).
 */
export interface HealthStore {
  readonly source: HealthImportResult['source'] | null;
  /** Human label, e.g. "Apple Health" / "Health Connect". */
  readonly label: string;
  isAvailable(): Promise<boolean>;
  /** Request read access to heart rate (+ HRV). Resolves false if denied/unavailable. */
  requestAccess(): Promise<boolean>;
  /** Read all heart-rate data in [start, end]. Sorted ascending. */
  importRange(start: number, end: number): Promise<HealthImportResult>;
}
