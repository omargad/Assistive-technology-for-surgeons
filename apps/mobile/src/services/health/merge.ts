/**
 * Merge a health-store import into a session without duplicating data that is
 * already present (re-importing the same window is a no-op).
 */
import { appendRr, appendSamples } from '@surgeonpulse/core';
import type { ExternalHrvReading, SurgicalSession } from '@surgeonpulse/core';
import type { HealthImportResult } from './types';

export interface MergeResult {
  session: SurgicalSession;
  /** Number of new heart-rate samples added. */
  addedSamples: number;
  addedRr: number;
  addedHrv: number;
}

export function mergeHealthImport(session: SurgicalSession, result: HealthImportResult): MergeResult {
  const sampleTimes = new Set(session.samples.map((s) => s.t));
  const newSamples = result.samples.filter((s) => !sampleTimes.has(s.t));

  const rrKeys = new Set(session.rr.map((r) => `${r.t}:${r.ms}`));
  const newRr = result.rr.filter((r) => !rrKeys.has(`${r.t}:${r.ms}`));

  const existingHrv = session.externalHrv ?? [];
  const hrvKeys = new Set(existingHrv.map((h) => `${h.t}:${h.metric}`));
  const newHrv = result.externalHrv.filter((h) => !hrvKeys.has(`${h.t}:${h.metric}`));

  let next = session;
  if (newSamples.length > 0) next = appendSamples(next, newSamples);
  if (newRr.length > 0) next = appendRr(next, newRr);
  if (newHrv.length > 0) {
    const externalHrv: ExternalHrvReading[] = [...existingHrv, ...newHrv].sort((a, b) => a.t - b.t);
    next = { ...next, externalHrv };
  }
  return { session: next, addedSamples: newSamples.length, addedRr: newRr.length, addedHrv: newHrv.length };
}
