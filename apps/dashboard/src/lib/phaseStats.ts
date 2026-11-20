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
