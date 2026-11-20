/**
 * RR-interval (inter-beat interval) cleaning and time-domain heart-rate variability.
 *
 * References:
 * - Task Force of the European Society of Cardiology and the North American Society of Pacing and
 *   Electrophysiology (1996). Heart rate variability: standards of measurement, physiological interpretation and
 *   clinical use. Circulation 93(5):1043–1065. (SDNN, RMSSD, pNN50 definitions.)
 * - Baevsky RM, Chernikova AG (2017). Heart rate variability analysis: physiological foundations and main
 *   methods. Cardiometry 10:66–76. (Stress index, SI = AMo / (2·Mo·MxDMn).)
 */
import type { ArtifactReport, EpochMs, HrvTimeDomain, RRInterval } from '../types';
import { buildHrv, hrvFromValidity, medianInPlace } from './internal';
import { stableSortBy } from './stats';

/** Upper limit on the number of windows {@link rollingHrv} will produce (guards against e.g. `start: 0`). */
export const MAX_ROLLING_HRV_WINDOWS = 1_000_000;

/** Options for {@link cleanRr}. */
export interface CleanRrOptions {
  /** Shortest plausible interval, ms (inclusive). Default 300 (200 bpm). */
  minMs?: number;
  /** Longest plausible interval, ms (inclusive). Default 2000 (30 bpm). */
  maxMs?: number;
  /** Largest allowed relative deviation from the local median. Default 0.2 (20 %). */
  maxDeviation?: number;
  /** Size of the centred local-median window, in beats. Default 11. */
  window?: number;
}

/** Options for {@link computeHrv}. */
export interface ComputeHrvOptions extends CleanRrOptions {
  /** Extra time (beyond the interval itself) between deliveries that marks a data dropout. Default 3000 ms. */
  gapMs?: number;
  /** Minimum number of valid intervals required to report HRV. Default 30. */
  minIntervals?: number;
}

/** Options for {@link rollingHrv}. */
export interface RollingHrvOptions extends ComputeHrvOptions {
  /** Window length. Default 60000 ms. */
  windowMs?: number;
  /** Step between consecutive window ends. Default 30000 ms. */
  stepMs?: number;
  /** Default: the first RR `t`. */
  start?: EpochMs;
  /** Default: the last RR `t`. */
  end?: EpochMs;
}

/** One window of {@link rollingHrv}. */
export interface RollingHrvPoint {
  /** Window end time. */
  t: EpochMs;
  rmssd: number | null;
  sdnn: number | null;
  meanHr: number | null;
  /** Number of valid (artefact-free) intervals in the window; reported even when the HRV values are null. */
  n: number;
}

/**
 * Flags artefacts and ectopic beats in an RR series.
 *
 * An interval is invalid if
 * 1. `ms` is not finite or lies outside `[minMs, maxMs]`; or
 * 2. `|ms − localMedian| / localMedian > maxDeviation`, where `localMedian` is the median of the rule-1-valid
 *    intervals at indices `max(0, i − ⌊w/2⌋) … min(n − 1, i + ⌊w/2⌋)` excluding `i` itself. Rule 2 is skipped
 *    for a beat with fewer than 3 such neighbours.
 *
 * This is a local-median ("moving median") filter in the spirit of the ESC/NASPE Task Force (1996)
 * recommendation to exclude ectopic beats and artefacts before computing HRV.
 *
 * @returns `valid[i]` for every `rr[i]`, and an {@link ArtifactReport} with `removed = count(!valid)`.
 */
export function cleanRr(
  rr: readonly RRInterval[],
  opts: CleanRrOptions = {},
): { valid: boolean[]; report: ArtifactReport } {
  const minMs = opts.minMs ?? 300;
  const maxMs = opts.maxMs ?? 2000;
  const maxDeviation = opts.maxDeviation ?? 0.2;
  const window = opts.window ?? 11;
  const half = Number.isFinite(window) ? Math.max(0, Math.floor(window / 2)) : 0;
  const n = rr.length;

  const inRange: boolean[] = new Array<boolean>(n);
  for (let i = 0; i < n; i++) {
    const ms = rr[i]!.ms;
    inRange[i] = Number.isFinite(ms) && ms >= minMs && ms <= maxMs;
  }

  const valid: boolean[] = new Array<boolean>(n);
  // Reused neighbour buffer: no per-beat allocation (cleaning is the hot loop of every HRV computation).
  const neighbours: number[] = [];
  let removed = 0;
  for (let i = 0; i < n; i++) {
    if (!inRange[i]) {
      valid[i] = false;
      removed++;
      continue;
    }
    let count = 0;
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    for (let j = lo; j <= hi; j++) {
      if (j !== i && inRange[j]) neighbours[count++] = rr[j]!.ms;
    }
    let ok = true;
    if (count >= 3) {
      const localMedian = medianInPlace(neighbours, count);
      if (localMedian > 0) {
        // Literal SPEC rule: invalid iff deviation > maxDeviation (so a NaN maxDeviation never rejects a beat).
        ok = !(Math.abs(rr[i]!.ms - localMedian) / localMedian > maxDeviation);
      }
    }
    valid[i] = ok;
    if (!ok) removed++;
  }
  return { valid, report: { total: n, removed, ratio: n > 0 ? removed / n : 0 } };
}

/**
 * Time-domain HRV of one contiguous, already-clean RR series (Task Force of ESC/NASPE, 1996):
 * `meanRr` = mean, `sdnn` = sample SD (n − 1), `d_i = x_{i+1} − x_i`, `rmssd = √mean(d²)`,
 * `pnn50 = 100·count(|d| > 50 ms)/len(d)`, `meanHr = 60000/meanRr`, `n` = intervals, `pairs` = len(d).
 *
 * @returns `null` with fewer than 2 intervals, or if any interval is non-finite or the mean is not positive.
 */
export function hrvTimeDomain(intervalsMs: readonly number[]): HrvTimeDomain | null {
  if (intervalsMs.length < 2) return null;
  for (const x of intervalsMs) if (!Number.isFinite(x)) return null;
  const diffs: number[] = [];
  for (let i = 0; i + 1 < intervalsMs.length; i++) diffs.push(intervalsMs[i + 1]! - intervalsMs[i]!);
  return buildHrv(intervalsMs, diffs);
}

/**
 * Robust HRV pipeline used by every summary:
 * 1. {@link cleanRr}.
 * 2. Split into runs: a new run starts where `rr[i].t − rr[i−1].t > gapMs + rr[i].ms` (a data dropout).
 *    A non-finite time difference is also treated as a dropout.
 * 3. `sdnn` and `meanRr` pool all valid intervals across runs.
 * 4. Successive differences use only pairs `(i, i+1)` that are both valid and in the same run, so an invalid
 *    beat breaks a pair instead of joining its neighbours (which would fabricate a large difference).
 * 5. `hrv = null` when fewer than `minIntervals` (default 30) intervals are valid or no valid pair exists.
 *
 * @returns the HRV (or null) and the artefact report from {@link cleanRr}.
 */
export function computeHrv(
  rr: readonly RRInterval[],
  opts: ComputeHrvOptions = {},
): { hrv: HrvTimeDomain | null; artifacts: ArtifactReport } {
  const { valid, report } = cleanRr(rr, opts);
  const { hrv } = hrvFromValidity(rr, valid, opts.gapMs ?? 3000, opts.minIntervals ?? 30);
  return { hrv, artifacts: report };
}

function isSortedByT(rr: readonly RRInterval[]): boolean {
  for (let i = 1; i < rr.length; i++) if (!(rr[i]!.t >= rr[i - 1]!.t)) return false;
  return true;
}

/** First index `i` with `t(i) >= target` in a list of `length` items sorted by `t`. */
function lowerBound(length: number, t: (i: number) => number, target: number): number {
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (t(mid) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Sliding-window HRV for charts (SPEC.md › analytics/rr.ts).
 *
 * - **Windows.** Window `k` ends at `start + windowMs + k·stepMs` and covers RR with
 *   `windowEnd − windowMs ≤ t < windowEnd`. Only complete windows are emitted (`windowEnd ≤ end`): SDNN grows with
 *   recording length, so only equal-length windows are comparable (Task Force of ESC/NASPE, 1996). Consequently
 *   beats after the last complete window (including one exactly at the default `end`) and recordings shorter than
 *   `windowMs` produce no window. `start` defaults to the first RR t and `end` to the last RR t.
 * - **Cleaning.** {@link cleanRr} runs **once over the whole series** (artefact screening uses each beat's
 *   neighbours even across window edges, as in whole-recording artefact correction), then each window applies
 *   steps 2–5 of {@link computeHrv} to its intervals in beat order with those validity flags; `minIntervals`
 *   defaults to 20 here. RMSSD/SDNN/meanHr are `null` when that HRV is null; `n` is the number of valid intervals in
 *   the window and is reported even then.
 * - **Cost.** One O(N) cleaning pass plus a binary search per window, also for input that is not sorted by t (an
 *   index permutation is sorted once, O(N log N)); a window then keeps its intervals in array (beat) order.
 *
 * @returns `[]` for an empty input or when no complete window fits.
 * @throws RangeError when `windowMs` or `stepMs` is not a positive finite number, or when more than
 *   {@link MAX_ROLLING_HRV_WINDOWS} windows would be produced.
 */
export function rollingHrv(rr: readonly RRInterval[], opts: RollingHrvOptions = {}): RollingHrvPoint[] {
  const windowMs = opts.windowMs ?? 60000;
  const stepMs = opts.stepMs ?? 30000;
  if (!(windowMs > 0) || !Number.isFinite(windowMs) || !(stepMs > 0) || !Number.isFinite(stepMs)) {
    throw new RangeError('rollingHrv: windowMs and stepMs must be positive finite numbers');
  }
  if (rr.length === 0) return [];
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const r of rr) {
    if (!Number.isFinite(r.t)) continue;
    if (r.t < first) first = r.t;
    if (r.t > last) last = r.t;
  }
  const start = opts.start ?? first;
  const end = opts.end ?? last;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  if (start + windowMs > end) return [];
  const expected = (end - start - windowMs) / stepMs + 1;
  if (!(expected <= MAX_ROLLING_HRV_WINDOWS)) {
    throw new RangeError(
      `rollingHrv: ${Math.floor(expected)} windows requested (limit ${MAX_ROLLING_HRV_WINDOWS}); check start/end and stepMs`,
    );
  }

  const cleanOpts: CleanRrOptions = {};
  if (opts.minMs !== undefined) cleanOpts.minMs = opts.minMs;
  if (opts.maxMs !== undefined) cleanOpts.maxMs = opts.maxMs;
  if (opts.maxDeviation !== undefined) cleanOpts.maxDeviation = opts.maxDeviation;
  if (opts.window !== undefined) cleanOpts.window = opts.window;
  const { valid } = cleanRr(rr, cleanOpts);
  const gapMs = opts.gapMs ?? 3000;
  const minIntervals = opts.minIntervals ?? 20;

  // Positions of the intervals ordered by t: the identity for sorted input, else a stable permutation computed once
  // (intervals with a non-finite t can never fall inside a window and are left out).
  const sorted = isSortedByT(rr);
  let order: number[] | null = null;
  if (!sorted) {
    const finite: number[] = [];
    for (let i = 0; i < rr.length; i++) if (Number.isFinite(rr[i]!.t)) finite.push(i);
    order = stableSortBy(finite, (i) => rr[i]!.t);
  }
  const ord = order;
  const size = ord === null ? rr.length : ord.length;
  const tAt = ord === null ? (k: number) => rr[k]!.t : (k: number) => rr[ord[k]!]!.t;

  const out: RollingHrvPoint[] = [];
  const indices: number[] = [];
  for (let k = 0; ; k++) {
    const windowEnd = start + windowMs + k * stepMs;
    if (windowEnd > end) break;
    const windowStart = windowEnd - windowMs;
    const lo = lowerBound(size, tAt, windowStart);
    const hi = lowerBound(size, tAt, windowEnd);
    indices.length = 0;
    if (ord === null) {
      for (let i = lo; i < hi; i++) indices.push(i);
    } else {
      for (let i = lo; i < hi; i++) indices.push(ord[i]!);
      indices.sort((a, b) => a - b); // back to array (beat) order within the window
    }
    const { hrv, nValid } = hrvFromValidity(rr, valid, gapMs, minIntervals, indices);
    out.push({
      t: windowEnd,
      rmssd: hrv ? hrv.rmssd : null,
      sdnn: hrv ? hrv.sdnn : null,
      meanHr: hrv ? hrv.meanHr : null,
      n: nValid,
    });
  }
  return out;
}

/**
 * Baevsky stress index (Baevsky & Chernikova, 2017): `SI = AMo / (2 · Mo · MxDMn)`.
 *
 * Intervals are binned as `[floor(x/binMs)·binMs, +binMs)`. `Mo` (mode) is the centre of the most populated bin
 * in seconds (ties go to the lowest bin), `AMo` is that bin's share of all intervals in %, and `MxDMn` is the
 * range `max − min` in seconds. Non-finite values are ignored.
 *
 * @param intervalsMs Artefact-free RR intervals in ms (e.g. the valid intervals from {@link cleanRr}).
 * @param binMs Histogram bin width (default 50 ms).
 * @returns `null` with fewer than 30 intervals, or when `MxDMn = 0` (or the mode is not positive).
 * @throws RangeError when `binMs` is not a positive finite number.
 */
export function baevskyStressIndex(intervalsMs: readonly number[], binMs = 50): number | null {
  if (!(binMs > 0) || !Number.isFinite(binMs)) {
    throw new RangeError(`baevskyStressIndex: binMs must be a positive finite number, got ${String(binMs)}`);
  }
  const counts = new Map<number, number>();
  let n = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const x of intervalsMs) {
    if (!Number.isFinite(x)) continue;
    n++;
    if (x < min) min = x;
    if (x > max) max = x;
    const bin = Math.floor(x / binMs);
    counts.set(bin, (counts.get(bin) ?? 0) + 1);
  }
  if (n < 30) return null;
  let modeBin = 0;
  let modeCount = -1;
  counts.forEach((count, bin) => {
    if (count > modeCount || (count === modeCount && bin < modeBin)) {
      modeBin = bin;
      modeCount = count;
    }
  });
  const mo = (modeBin * binMs + binMs / 2) / 1000;
  const amo = (modeCount / n) * 100;
  const mxdmn = (max - min) / 1000;
  if (!(mxdmn > 0) || !(mo > 0)) return null;
  const si = amo / (2 * mo * mxdmn);
  return Number.isFinite(si) ? si : null;
}
