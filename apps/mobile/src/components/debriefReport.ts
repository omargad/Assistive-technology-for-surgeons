/**
 * Pure helpers for the post-op debrief: pairwise-weight tallies and building
 * the `PostOpReport` (scoring itself is core `scoreWorkload`).
 *
 * SURG-TLX ratings start unanswered (`null`): a rating is only ever stored when
 * the participant gave it. The workload response is included in the report only
 * when all six dimensions were rated (core requires all six); otherwise it is
 * left out rather than filled with midpoint defaults.
 */
import { SURG_TLX_DIMENSIONS } from '@surgeonpulse/core';
import type { CaseOutcome, PostOpReport, SurgTlxDimension, SurgTlxResponse } from '@surgeonpulse/core';

export type Ratings = Record<SurgTlxDimension, number>;
/** Ratings while the form is being filled in (`null` = not rated yet). */
export type DraftRatings = Record<SurgTlxDimension, number | null>;

export const EMPTY_RATINGS: DraftRatings = {
  mental: null,
  physical: null,
  temporal: null,
  complexity: null,
  stress: null,
  distraction: null,
};

/** Dimensions not rated yet, in questionnaire order. */
export function missingRatings(ratings: DraftRatings): SurgTlxDimension[] {
  return SURG_TLX_DIMENSIONS.map((d) => d.id).filter((id) => ratings[id] == null);
}

/** All six ratings when complete, otherwise `null`. */
export function completeRatings(ratings: DraftRatings): Ratings | null {
  if (missingRatings(ratings).length > 0) return null;
  return { ...ratings } as Ratings;
}

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
  ratings: DraftRatings;
  weights: Ratings | null;
  performance: number | null;
  perceivedStress: number | null;
  sleepHours: number | null;
  caffeine: boolean | null;
  outcome: CaseOutcome | null;
  notes: string;
}

/**
 * Build the PostOpReport from the form. Unanswered optional items are omitted, and the
 * SURG-TLX response is omitted unless all six ratings were given.
 */
export function buildPostOpReport(draft: DebriefDraft, completedAt: number): PostOpReport {
  const report: PostOpReport = {};
  const ratings = completeRatings(draft.ratings);
  if (ratings) {
    const workload: SurgTlxResponse = { instrument: 'surg-tlx', ratings, completedAt };
    if (draft.weights) workload.weights = { ...draft.weights };
    report.workload = workload;
  }
  if (draft.performance != null) report.performance = draft.performance;
  if (draft.perceivedStress != null) report.perceivedStress = draft.perceivedStress;
  if (draft.sleepHours != null) report.sleepHours = draft.sleepHours;
  if (draft.caffeine != null) report.caffeine = draft.caffeine;
  if (draft.outcome != null) report.outcome = draft.outcome;
  const notes = draft.notes.trim();
  if (notes) report.notes = notes;
  return report;
}
