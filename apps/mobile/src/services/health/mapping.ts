/**
 * Pure helpers that turn platform health-store records into SurgeonPulse
 * signals. Kept free of native imports so they can be unit-tested anywhere.
 */
import type { ExternalHrvReading, HeartRateSample, RRInterval, SensorSourceKind } from '@surgeonpulse/core';
import type { HealthImportResult } from './types';

/** Plausible physiological ranges; anything outside is a recording artefact. */
const MIN_BPM = 20;
const MAX_BPM = 260;
const MIN_RR_MS = 250;
const MAX_RR_MS = 3000;

function inWindow(t: number, start: number, end: number): boolean {
  return Number.isFinite(t) && t >= start && t <= end;
}

function byTime<T extends { t: number }>(a: T, b: T): number {
  return a.t - b.t;
}

/** Keep valid HR samples inside [start, end], sorted and de-duplicated by timestamp. */
export function cleanHeartRate(samples: readonly HeartRateSample[], start: number, end: number): HeartRateSample[] {
  const seen = new Set<number>();
  const out: HeartRateSample[] = [];
  for (const s of [...samples].sort(byTime)) {
    if (!inWindow(s.t, start, end) || !Number.isFinite(s.bpm) || s.bpm < MIN_BPM || s.bpm > MAX_BPM) continue;
    if (seen.has(s.t)) continue;
    seen.add(s.t);
    out.push({ t: s.t, bpm: s.bpm });
  }
  return out;
}

/** Keep external HRV readings inside [start, end], sorted. */
export function cleanExternalHrv(readings: readonly ExternalHrvReading[], start: number, end: number): ExternalHrvReading[] {
  return readings
    .filter((r) => inWindow(r.t, start, end) && Number.isFinite(r.ms) && r.ms > 0 && r.ms < 1000)
    .sort(byTime);
}

export interface Heartbeat {
  /** Seconds since the start of the series. */
  timeSinceSeriesStart: number;
  /** True when beats were missed before this one (no valid interval). */
  precededByGap: boolean;
}

/**
 * Convert an Apple Watch heartbeat series into RR intervals. Each interval is
 * the time between consecutive beats not separated by a gap; its `t` is the
 * time of the later beat.
 */
export function heartbeatsToRr(seriesStartMs: number, beats: readonly Heartbeat[], start: number, end: number): RRInterval[] {
  const out: RRInterval[] = [];
  for (let i = 1; i < beats.length; i++) {
    const prev = beats[i - 1] as Heartbeat;
    const cur = beats[i] as Heartbeat;
    if (cur.precededByGap) continue;
    const ms = (cur.timeSinceSeriesStart - prev.timeSinceSeriesStart) * 1000;
    const t = Math.round(seriesStartMs + cur.timeSinceSeriesStart * 1000);
    if (!inWindow(t, start, end) || !(ms >= MIN_RR_MS && ms <= MAX_RR_MS)) continue;
    out.push({ t, ms: Math.round(ms * 1000) / 1000 });
  }
  return out;
}

/** Parse an ISO-8601 timestamp to epoch ms (NaN when invalid). */
export function isoToMs(iso: string): number {
  return Date.parse(iso);
}

export interface HealthConnectHeartRateRecord {
  samples: readonly { time: string; beatsPerMinute: number }[];
}

export function healthConnectHeartRate(records: readonly HealthConnectHeartRateRecord[]): HeartRateSample[] {
  const out: HeartRateSample[] = [];
  for (const record of records) {
    for (const s of record.samples) out.push({ t: isoToMs(s.time), bpm: s.beatsPerMinute });
  }
  return out;
}

export interface HealthConnectRmssdRecord {
  time: string;
  heartRateVariabilityMillis: number;
}

export function healthConnectRmssd(
  records: readonly HealthConnectRmssdRecord[],
  source: SensorSourceKind = 'health-connect',
): ExternalHrvReading[] {
  return records.map((r) => ({ t: isoToMs(r.time), metric: 'rmssd', ms: r.heartRateVariabilityMillis, source }));
}

/** Assemble a cleaned, window-restricted import result. */
export function buildImportResult(
  source: HealthImportResult['source'],
  start: number,
  end: number,
  parts: { samples: readonly HeartRateSample[]; rr?: readonly RRInterval[]; externalHrv?: readonly ExternalHrvReading[] },
): HealthImportResult {
  return {
    source,
    samples: cleanHeartRate(parts.samples, start, end),
    rr: [...(parts.rr ?? [])].filter((r) => inWindow(r.t, start, end)).sort(byTime),
    externalHrv: cleanExternalHrv(parts.externalHrv ?? [], start, end),
  };
}
