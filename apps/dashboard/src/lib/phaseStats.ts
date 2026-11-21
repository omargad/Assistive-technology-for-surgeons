/**
 * Per-phase aggregation across sessions, built on core statistics
 * (`mean`, `sampleSd`, `median`) and the per-phase values core computes in
 * each `SessionSummary.phases`.
 */
import { PHASE_ORDER, mean, median, sampleSd } from '@surgeonpulse/core';
import type { PhaseKind, PhaseSummary, SessionSummary } from '@surgeonpulse/core';

/** Which per-phase value to aggregate. */
export type PhaseValueKey = 'meanHrDelta' | 'meanHr' | 'rmssd';

function pick(p: PhaseSummary, key: PhaseValueKey): number | null {
  const v = key === 'meanHrDelta' ? p.meanHrDelta : key === 'meanHr' ? (p.hr?.mean ?? null) : (p.hrv?.rmssd ?? null);
  return v !== null && Number.isFinite(v) ? v : null;
}

/**
 * One session's value for a phase. A phase that occurs in several segments is
 * combined as a duration-weighted mean (the same rule core uses for the
 * summary CSV), so each session contributes one value per phase.
 */
export function sessionPhaseValue(s: SessionSummary, phase: PhaseKind, key: PhaseValueKey): number | null {
  let w = 0;
  let acc = 0;
  const plain: number[] = [];
  for (const p of s.phases) {
    if (p.phase !== phase) continue;
    const v = pick(p, key);
    if (v === null) continue;
    plain.push(v);
    if (p.durationSec > 0) {
      w += p.durationSec;
      acc += v * p.durationSec;
    }
  }
  if (plain.length === 0) return null;
  if (plain.length === 1) return plain[0]!;
  return w > 0 ? acc / w : mean(plain);
}

/** Descriptive statistics of one phase across sessions. */
export interface PhaseAggregate {
  phase: PhaseKind;
  /** Sessions contributing a value. */
  n: number;
  mean: number | null;
  sd: number | null;
  median: number | null;
}

/** Collect per-session values for every phase in `PHASE_ORDER`. */
export function phaseValues(summaries: readonly SessionSummary[], key: PhaseValueKey): Map<PhaseKind, number[]> {
  const out = new Map<PhaseKind, number[]>(PHASE_ORDER.map((p) => [p, []]));
  for (const s of summaries) {
    for (const phase of PHASE_ORDER) {
      const v = sessionPhaseValue(s, phase, key);
      if (v !== null) out.get(phase)!.push(v);
    }
  }
  return out;
}

/** Mean ± SD and median per phase (phases without data have n = 0 and null stats). */
export function phaseProfile(summaries: readonly SessionSummary[], key: PhaseValueKey): PhaseAggregate[] {
  const values = phaseValues(summaries, key);
  return PHASE_ORDER.map((phase) => {
    const xs = values.get(phase) ?? [];
    return { phase, n: xs.length, mean: mean(xs), sd: sampleSd(xs), median: median(xs) };
  });
}

/** Fewest distinct other participants whose sessions may form a cohort comparison value. */
export const MIN_COHORT_PARTICIPANTS = 5;

/** A cohort comparison value for one phase. */
export interface CohortPhaseValue {
  /** Median over other participants' sessions, or null when suppressed or without data. */
  median: number | null;
  /** Distinct other participants contributing a value for this phase. */
  participants: number;
}

/**
 * Per-phase cohort medians for a participant's feedback page, computed from **other**
 * participants' sessions only, and suppressed (`median: null`) for a phase that fewer than
 * `minParticipants` distinct other participants contribute to. Including the viewer's own
 * sessions, or showing a median of very few colleagues, would let the viewer work out a
 * colleague's exact value (e.g. with one other participant: other = 2 × median − own).
 */
export function cohortPhaseMedians(
  summaries: readonly SessionSummary[],
  viewerCode: string,
  key: PhaseValueKey,
  minParticipants: number = MIN_COHORT_PARTICIPANTS,
): Map<PhaseKind, CohortPhaseValue> {
  const values = new Map<PhaseKind, number[]>(PHASE_ORDER.map((p) => [p, []]));
  const codes = new Map<PhaseKind, Set<string>>(PHASE_ORDER.map((p) => [p, new Set<string>()]));
  for (const s of summaries) {
    if (s.participantCode === viewerCode) continue;
    for (const phase of PHASE_ORDER) {
      const v = sessionPhaseValue(s, phase, key);
      if (v === null) continue;
      values.get(phase)!.push(v);
      codes.get(phase)!.add(s.participantCode);
    }
  }
  const k = Math.max(1, Math.floor(minParticipants));
  return new Map(
    PHASE_ORDER.map((phase) => {
      const participants = codes.get(phase)!.size;
      return [phase, { median: participants >= k ? median(values.get(phase)!) : null, participants }];
    }),
  );
}

