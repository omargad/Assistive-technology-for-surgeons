/**
 * Internal helpers shared by the analytics modules.
 *
 * This file is deliberately **not** re-exported from `src/index.ts`: nothing here is public API, so it can change
 * without a SPEC.md update. Everything is plain ES2022 (no platform APIs), like the rest of the package.
 */
import type { HrvTimeDomain, RRInterval } from '../types';
import { mean, sampleSd } from './stats';

/** Default largest sample spacing treated as continuous data (SPEC: `maxGapMs = 5000`). */
export const DEFAULT_MAX_GAP_MS = 5000;

/**
 * Normalises a `maxGapMs` option: `undefined` and `NaN` (e.g. `Number('')` from an empty settings field) fall back
 * to the 5000 ms default, so a bad option can never turn dwell times into `NaN` (SPEC ground rule). Any other number,
 * including `Infinity` ("never cap") and values ≤ 0 ("no dwell"), is used as given.
 */
export function resolveMaxGapMs(maxGapMs: number | undefined): number {
  return typeof maxGapMs === 'number' && !Number.isNaN(maxGapMs) ? maxGapMs : DEFAULT_MAX_GAP_MS;
}

/**
 * Median of the first `n` (≥ 1) entries of `buf`, which must all be finite. Sorts that prefix in place: insertion
 * sort for the short neighbour lists of `cleanRr` (≤ 10 values by default), so there is no allocation and no
 * comparator call per beat — the dominant cost of artefact screening on Hermes, which has no JIT. Same arithmetic
 * as `median()` (mean of the two middle values for even n), so results are bit-identical.
 */
export function medianInPlace(buf: number[], n: number): number {
  if (n <= 64) {
    for (let i = 1; i < n; i++) {
      const v = buf[i]!;
      let j = i - 1;
      while (j >= 0 && buf[j]! > v) {
        buf[j + 1] = buf[j]!;
        j--;
      }
      buf[j + 1] = v;
    }
  } else {
    const head = buf.slice(0, n).sort((a, b) => a - b);
    for (let i = 0; i < n; i++) buf[i] = head[i]!;
  }
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return buf[mid]!;
  const m = (buf[mid - 1]! + buf[mid]!) / 2;
  return Number.isFinite(m) ? m : buf[mid - 1]! / 2 + buf[mid]! / 2;
}

/**
 * Builds the time-domain HRV record (Task Force of ESC/NASPE, 1996) from pooled valid intervals and the successive
 * differences of valid same-run pairs; `null` when it cannot be computed.
 */
export function buildHrv(values: readonly number[], diffs: readonly number[]): HrvTimeDomain | null {
  if (values.length < 2 || diffs.length === 0) return null;
  const meanRr = mean(values);
  const sdnn = sampleSd(values);
  if (meanRr === null || sdnn === null || !(meanRr > 0)) return null;
  let sumSq = 0;
  let nn50 = 0;
  for (const d of diffs) {
    sumSq += d * d;
    if (Math.abs(d) > 50) nn50++;
  }
  const pairs = diffs.length;
  const rmssd = Math.sqrt(sumSq / pairs);
  const meanHr = 60000 / meanRr;
  if (!Number.isFinite(rmssd) || !Number.isFinite(meanHr)) return null;
  return { n: values.length, pairs, meanRr, sdnn, rmssd, pnn50: (100 * nn50) / pairs, meanHr };
}

/**
 * Steps 2–5 of `computeHrv` (SPEC.md › analytics/rr.ts) for validity flags that were already computed by `cleanRr`:
 * run splitting at `t[i] − t[i−1] > gapMs + ms[i]`, pooled valid intervals, successive differences only for valid
 * pairs in the same run, and the `minIntervals` / zero-pairs null rule.
 *
 * `indices` (ascending positions into `rr`/`valid`) restricts the computation to a subsequence, e.g. one
 * `rollingHrv` window; consecutive entries of the subsequence form the candidate pairs. Without it the whole series
 * is used.
 *
 * @returns the HRV (or null) and `nValid`, the number of valid intervals considered.
 */
export function hrvFromValidity(
  rr: readonly RRInterval[],
  valid: readonly boolean[],
  gapMs: number,
  minIntervals: number,
  indices?: readonly number[],
): { hrv: HrvTimeDomain | null; nValid: number } {
  const values: number[] = [];
  const diffs: number[] = [];
  const count = indices === undefined ? rr.length : indices.length;
  let prev = -1;
  for (let k = 0; k < count; k++) {
    const i = indices === undefined ? k : indices[k]!;
    const isValid = valid[i] === true;
    if (isValid) {
      const cur = rr[i]!;
      values.push(cur.ms);
      if (prev >= 0 && valid[prev] === true) {
        const before = rr[prev]!;
        const dt = cur.t - before.t;
        // A non-finite time difference is treated as a dropout (new run).
        if (Number.isFinite(dt) && !(dt > gapMs + cur.ms)) diffs.push(cur.ms - before.ms);
      }
    }
    prev = i;
  }
  const nValid = values.length;
  if (nValid < minIntervals || diffs.length === 0) return { hrv: null, nValid };
  return { hrv: buildHrv(values, diffs), nValid };
}
