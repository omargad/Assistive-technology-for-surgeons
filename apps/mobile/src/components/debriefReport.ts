/**
 * Pure helpers for the post-op debrief: pairwise-weight tallies and building
 * the `PostOpReport` (scoring itself is core `scoreWorkload`).
 */
import type { CaseOutcome, PostOpReport, SurgTlxDimension, SurgTlxResponse } from '@surgeonpulse/core';

export type Ratings = Record<SurgTlxDimension, number>;

export const DEFAULT_RATINGS: Ratings = { mental: 50, physical: 50, temporal: 50, complexity: 50, stress: 50, distraction: 50 };

/** Pairwise tallies: each chosen dimension gets one point; complete when all 15 pairs are answered. */
export function weightsFromChoices(pairs: readonly [string, string][], choices: Readonly<Record<number, string>>): Ratings | null {
  if (pairs.some((_, i) => choices[i] == null)) return null;
  const w: Ratings = { mental: 0, physical: 0, temporal: 0, complexity: 0, stress: 0, distraction: 0 };
  for (const pick of Object.values(choices)) {
    if (pick in w) w[pick as SurgTlxDimension] += 1;
  }
  return w;
}

export interface DebriefDraft {
  ratings: Ratings;
  weights: Ratings | null;
  performance: number | null;
  perceivedStress: number | null;
  sleepHours: number | null;
  caffeine: boolean | null;
  outcome: CaseOutcome | null;
  notes: string;
}

/** Build the PostOpReport from the form (unanswered optional items are omitted). */
export function buildPostOpReport(draft: DebriefDraft, completedAt: number): PostOpReport {
  const workload: SurgTlxResponse = { instrument: 'surg-tlx', ratings: { ...draft.ratings }, completedAt };
  if (draft.weights) workload.weights = { ...draft.weights };
  const report: PostOpReport = { workload };
  if (draft.performance != null) report.performance = draft.performance;
  if (draft.perceivedStress != null) report.perceivedStress = draft.perceivedStress;
  if (draft.sleepHours != null) report.sleepHours = draft.sleepHours;
  if (draft.caffeine != null) report.caffeine = draft.caffeine;
  if (draft.outcome != null) report.outcome = draft.outcome;
  const notes = draft.notes.trim();
  if (notes) report.notes = notes;
  return report;
}
