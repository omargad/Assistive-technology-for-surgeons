/**
 * Storage limits for heart-rate signals.
 *
 * The core session schema (`@surgeonpulse/core` io/schema.ts, SPEC.md) rejects
 * a whole session when one sample has a bpm outside 0–300 or one RR interval
 * is outside 0–5000 ms. The Heart Rate Measurement format can encode far larger
 * values (uint16 heart rate up to 65 535 bpm, RR up to ~64 s), and a glitching
 * strap can send them. Values outside these limits are therefore dropped:
 * when they arrive (recording store) and when stored signals are read back
 * (SQLite / web storage), so one bad notification can never make a session
 * unreadable. Artefact filtering for analysis stays in core (plausible ranges
 * are narrower); these limits only guarantee that a session stays valid.
 */
import type { HeartRateSample, RRInterval } from '@surgeonpulse/core';

/** Highest heart rate the session schema accepts (bpm, inclusive). */
export const STORABLE_BPM_MAX = 300;
/** Longest RR interval the session schema accepts (ms, inclusive). */
export const STORABLE_RR_MAX_MS = 5000;

/** True when the sample can be stored without invalidating its session. */
export function isStorableSample(s: HeartRateSample): boolean {
  return (
    Number.isFinite(s.t) &&
    Number.isFinite(s.bpm) &&
    s.bpm >= 0 &&
    s.bpm <= STORABLE_BPM_MAX &&
    (s.contact === undefined || typeof s.contact === 'boolean')
  );
}

/** True when the RR interval can be stored without invalidating its session. */
export function isStorableRr(r: RRInterval): boolean {
  return Number.isFinite(r.t) && Number.isFinite(r.ms) && r.ms >= 0 && r.ms <= STORABLE_RR_MAX_MS;
}

/** `samples` without values the session schema would reject (the same array when nothing is dropped). */
export function storableSamples<T extends HeartRateSample>(samples: readonly T[]): readonly T[] {
  return samples.every(isStorableSample) ? samples : samples.filter(isStorableSample);
}

/** `rr` without values the session schema would reject (the same array when nothing is dropped). */
export function storableRr<T extends RRInterval>(rr: readonly T[]): readonly T[] {
  return rr.every(isStorableRr) ? rr : rr.filter(isStorableRr);
}
