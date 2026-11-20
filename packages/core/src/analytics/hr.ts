/**
 * Heart-rate sample statistics, slicing, gap detection and resampling.
 *
 * All functions are pure: inputs are never mutated and results are new arrays/objects.
 */
import type { EpochMs, HeartRateSample, HrStats } from '../types';
import { resolveMaxGapMs } from './internal';
import { mean, median, percentile, sampleSd } from './stats';

/** Upper limit on the number of buckets {@link resampleHr} will produce (a chart never needs more). */
export const MAX_RESAMPLE_BUCKETS = 1_000_000;

/** Lowest physiologically plausible heart rate accepted by the analytics (bpm, inclusive). */
export const HR_VALID_MIN_BPM = 25;
/** Highest physiologically plausible heart rate accepted by the analytics (bpm, inclusive). */
export const HR_VALID_MAX_BPM = 250;

/**
 * True when `bpm` is a finite number within [{@link HR_VALID_MIN_BPM}, {@link HR_VALID_MAX_BPM}].
 * Values outside this range are sensor artefacts (e.g. 0 bpm reported while the strap has no skin contact).
 */
export function isValidBpm(bpm: number): boolean {
  return Number.isFinite(bpm) && bpm >= HR_VALID_MIN_BPM && bpm <= HR_VALID_MAX_BPM;
}

/** A period without heart-rate samples, see {@link detectGaps}. */
export interface HrGap {
  start: EpochMs;
  end: EpochMs;
  durationMs: number;
}

/** Options for {@link resampleHr}. */
export interface ResampleHrOptions {
  /** First bucket start. Default: the first sample's `t`. */
  start?: EpochMs;
  /** The last emitted bucket is the one containing `end`. Default: the last sample's `t`. */
  end?: EpochMs;
  /**
   * @deprecated Ignored. A bucket's value is defined purely by the samples inside it (an empty bucket is `null`,
   * which already breaks a chart line at a data gap), so there is nothing for a gap threshold to change. Kept only
   * so existing callers still type-check; it will be removed in a future version.
   */
  maxGapMs?: number;
}

/** One bucket of {@link resampleHr}. */
export interface ResampledHrPoint {
  /** Bucket start time. */
  t: EpochMs;
  /** Mean bpm of the valid samples in the bucket, or `null` when the bucket has none. */
  bpm: number | null;
}

/**
 * Summary statistics of heart-rate samples.
 *
 * Samples whose `bpm` is not finite or lies outside [25, 250] are ignored. Statistics are computed over sample
 * values (not time-weighted); `sd` is the sample SD (n − 1, 0 for one sample) and `p95` uses
 * {@link percentile}(…, 95) (NumPy "linear").
 *
 * @returns `null` when no valid sample remains.
 */
export function hrStats(samples: readonly HeartRateSample[]): HrStats | null {
  const values: number[] = [];
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const s of samples) {
    if (!isValidBpm(s.bpm)) continue;
    values.push(s.bpm);
    if (s.bpm < min) min = s.bpm;
    if (s.bpm > max) max = s.bpm;
  }
  if (values.length === 0) return null;
  return {
    count: values.length,
    mean: mean(values)!,
    median: median(values)!,
    min,
    max,
    sd: sampleSd(values)!,
    p95: percentile(values, 95)!,
  };
}

/**
 * Items with `start ≤ t < end`, in input order (a new array; the input is not modified).
 */
export function sliceByTime<T extends { t: number }>(xs: readonly T[], start: EpochMs, end: EpochMs): T[] {
  const out: T[] = [];
  for (const x of xs) if (x.t >= start && x.t < end) out.push(x);
  return out;
}

/**
 * Data gaps: every pair of consecutive samples (in array order) with `next.t − prev.t > maxGapMs`.
 * The gap runs from `prev.t` to `next.t`.
 *
 * @param maxGapMs Largest spacing still considered continuous (default 5000 ms; `NaN` also means the default).
 */
export function detectGaps(samples: readonly HeartRateSample[], maxGapMs = 5000): HrGap[] {
  const gap = resolveMaxGapMs(maxGapMs);
  const out: HrGap[] = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]!;
    const next = samples[i]!;
    const d = next.t - prev.t;
    if (Number.isFinite(d) && d > gap) out.push({ start: prev.t, end: next.t, durationMs: d });
  }
  return out;
}

/**
 * Resamples heart rate onto a regular grid for charting.
 *
 * Bucket `k` covers `[start + k·intervalMs, start + (k+1)·intervalMs)` and its `t` is the bucket start. Its
 * value is the mean bpm of the valid samples (see {@link isValidBpm}) in the bucket, or `null` when the bucket is
 * empty, so data gaps break a chart line. Buckets run from `start` (default: first sample t) up to and including
 * the bucket that contains `end` (default: last sample t).
 *
 * @returns `[]` for an empty input or when `end < start`.
 * @throws RangeError when `intervalMs` is not a positive finite number, or when more than
 *   {@link MAX_RESAMPLE_BUCKETS} buckets would be produced (e.g. `intervalMs: 1` over hours, or `start: 0`).
 */
export function resampleHr(
  samples: readonly HeartRateSample[],
  intervalMs: number,
  opts: ResampleHrOptions = {},
): ResampledHrPoint[] {
  if (!(intervalMs > 0) || !Number.isFinite(intervalMs)) {
    throw new RangeError(`resampleHr: intervalMs must be a positive finite number, got ${String(intervalMs)}`);
  }
  if (samples.length === 0) return [];
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const s of samples) {
    if (!Number.isFinite(s.t)) continue;
    if (s.t < first) first = s.t;
    if (s.t > last) last = s.t;
  }
  const start = opts.start ?? first;
  const end = opts.end ?? last;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const count = Math.floor((end - start) / intervalMs) + 1;
  if (!(count <= MAX_RESAMPLE_BUCKETS)) {
    throw new RangeError(
      `resampleHr: ${count} buckets requested (limit ${MAX_RESAMPLE_BUCKETS}); use a larger intervalMs or a narrower start/end`,
    );
  }
  const sums = new Array<number>(count).fill(0);
  const counts = new Array<number>(count).fill(0);
  for (const s of samples) {
    if (!Number.isFinite(s.t) || !isValidBpm(s.bpm)) continue;
    const k = Math.floor((s.t - start) / intervalMs);
    if (k < 0 || k >= count) continue;
    sums[k]! += s.bpm;
    counts[k]! += 1;
  }
  const out: ResampledHrPoint[] = new Array<ResampledHrPoint>(count);
  for (let k = 0; k < count; k++) {
    const c = counts[k]!;
    out[k] = { t: start + k * intervalMs, bpm: c > 0 ? sums[k]! / c : null };
  }
  return out;
}
