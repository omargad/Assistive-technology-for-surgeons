/**
 * Post-operative workload questionnaires.
 *
 * References:
 * - Wilson MR, Poolton JM, Malhotra N, Ngo K, Bright E, Masters RSW (2011). Development and validation of a
 *   surgical workload measure: the Surgery Task Load Index (SURG-TLX). World J Surg 35(9):1961–1969.
 * - Hart SG, Staveland LE (1988). Development of NASA-TLX (Task Load Index): results of empirical and
 *   theoretical research. In: Hancock PA, Meshkati N (eds) Human Mental Workload. North-Holland, 139–183.
 *
 * Ratings use the 0–100 digital convention (step 5). The optional weighting step uses the 15 pairwise
 * comparisons of the six dimensions; a dimension's weight is the number of times it was chosen (0–5, Σ = 15).
 */
import type {
  NasaTlxDimension,
  SurgTlxDimension,
  WorkloadInstrument,
  WorkloadResponse,
  WorkloadScore,
} from '../types';

/** Display metadata for one workload dimension. */
export interface TlxDimensionInfo<Id extends string = string> {
  id: Id;
  /** Dimension name, e.g. "Mental Demands". */
  label: string;
  /** Question shown above the rating slider. */
  question: string;
  /** Anchor for a rating of 0. */
  low: string;
  /** Anchor for a rating of 100. */
  high: string;
}

function dim<Id extends string>(
  id: Id,
  label: string,
  question: string,
  low = 'Very low',
  high = 'Very high',
): Readonly<TlxDimensionInfo<Id>> {
  return Object.freeze({ id, label, question, low, high });
}

/** The six SURG-TLX dimensions (Wilson et al., 2011), in questionnaire order. */
export const SURG_TLX_DIMENSIONS: readonly Readonly<TlxDimensionInfo<SurgTlxDimension>>[] = Object.freeze([
  dim('mental', 'Mental Demands', 'How mentally fatiguing was the procedure?'),
  dim('physical', 'Physical Demands', 'How physically fatiguing was the procedure?'),
  dim('temporal', 'Temporal Demands', 'How hurried or rushed was the pace of the procedure?'),
  dim('complexity', 'Task Complexity', 'How complex was the procedure?'),
  dim('stress', 'Situational Stress', 'How anxious did you feel while performing the procedure?'),
  dim('distraction', 'Distractions', 'How distracting was the operating environment?'),
]);

/** The six NASA-TLX dimensions (Hart & Staveland, 1988), in questionnaire order. */
export const NASA_TLX_DIMENSIONS: readonly Readonly<TlxDimensionInfo<NasaTlxDimension>>[] = Object.freeze([
  dim('mental', 'Mental Demand', 'How mentally demanding was the task?'),
  dim('physical', 'Physical Demand', 'How physically demanding was the task?'),
  dim('temporal', 'Temporal Demand', 'How hurried or rushed was the pace of the task?'),
  dim(
    'performance',
    'Performance',
    'How successful were you in accomplishing what you were asked to do?',
    'Perfect',
    'Failure',
  ),
  dim('effort', 'Effort', 'How hard did you have to work to accomplish your level of performance?'),
  dim('frustration', 'Frustration', 'How insecure, discouraged, irritated, stressed, and annoyed were you?'),
]);

function dimensionsOf(instrument: WorkloadInstrument): readonly Readonly<TlxDimensionInfo>[] {
  return instrument === 'nasa-tlx' ? NASA_TLX_DIMENSIONS : SURG_TLX_DIMENSIONS;
}

/**
 * The 15 unordered pairs of dimension ids for the pairwise-comparison weighting step, in a fixed order:
 * `(d0,d1), (d0,d2), …, (d0,d5), (d1,d2), …, (d4,d5)` following the questionnaire order.
 */
export function tlxPairs(instrument: WorkloadInstrument): [string, string][] {
  const ids = dimensionsOf(instrument).map((d) => d.id);
  const pairs: [string, string][] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) pairs.push([ids[i]!, ids[j]!]);
  }
  return pairs;
}

/** Clamps a rating to [0, 100]; a missing or `NaN` rating counts as 0 so scores are always finite. */
function clampRating(x: number | undefined): number {
  if (x === undefined || Number.isNaN(x)) return 0;
  return Math.min(100, Math.max(0, x));
}

/**
 * Scores a SURG-TLX (Wilson et al., 2011) or NASA-TLX (Hart & Staveland, 1988) response.
 *
 * - `dimensions`: each rating clamped to [0, 100] (a missing/`NaN` rating counts as 0).
 * - `raw`: mean of the six clamped ratings ("Raw TLX").
 * - `weighted`: `Σ(rating × weight) / 15`, only when weights exist for every dimension, each weight is an
 *   integer in 0–5 and they sum to 15; otherwise `null`.
 */
export function scoreWorkload(resp: WorkloadResponse): WorkloadScore {
  const dims = dimensionsOf(resp.instrument);
  const ratings = resp.ratings as Readonly<Record<string, number | undefined>>;
  const dimensions: Record<string, number> = {};
  let sum = 0;
  for (const d of dims) {
    const r = clampRating(ratings[d.id]);
    dimensions[d.id] = r;
    sum += r;
  }
  const raw = sum / dims.length;

  let weighted: number | null = null;
  const weights = resp.weights as Readonly<Record<string, number | undefined>> | undefined;
  if (weights != null) {
    let total = 0;
    let acc = 0;
    let ok = true;
    for (const d of dims) {
      const w = weights[d.id];
      if (w === undefined || !Number.isInteger(w) || w < 0 || w > 5) {
        ok = false;
        break;
      }
      total += w;
      acc += dimensions[d.id]! * w;
    }
    if (ok && total === 15) weighted = acc / 15;
  }
  return { instrument: resp.instrument, raw, weighted, dimensions };
}
