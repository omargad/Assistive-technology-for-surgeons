/**
 * Descriptive statistics shared by every analytics module.
 *
 * Portability notes (Hermes / browsers / Node):
 * - Plain ES2022 only. Loops are used instead of `Math.min(...xs)` / `Math.max(...xs)` because spreading
 *   long arrays can exceed the argument limit of some engines (notably Hermes).
 * - Sorting never relies on the engine's `Array.prototype.sort` being stable: {@link stableSortBy} breaks ties
 *   on the original index, so results are identical on every runtime.
 * - Squares are computed as `x * x` (never `Math.pow` / `**`) and roots with `Math.sqrt`, which IEEE 754
 *   requires to be correctly rounded, so outputs are bit-for-bit reproducible across engines.
 *
 * Every reducer ignores non-finite inputs (`NaN`, `±Infinity`) and returns `null` when no finite value remains,
 * so these functions never return `NaN` or `Infinity`.
 *
 * Overflow (SPEC ground rule "never return NaN or Infinity"): finite inputs near `Number.MAX_VALUE` can overflow
 * an intermediate sum, square or difference. Each function first computes the result the ordinary way (so normal
 * inputs give exactly the same bits as the Python port and NumPy); only when that result is not finite does it
 * recompute on values rescaled by their largest magnitude. A result that is still not representable (e.g. the SD of
 * `[-MAX_VALUE, MAX_VALUE]`, which is `MAX_VALUE·√2`) is `null`.
 */

/** Result of an ordinary-least-squares fit, see {@link linearTrend}. */
export interface LinearTrend {
  slope: number;
  intercept: number;
  /** Coefficient of determination, 0–1 (0 when y has no variance). */
  r2: number;
  /** Number of points used in the fit. */
  n: number;
}

function finiteValues(xs: readonly number[]): number[] {
  const out: number[] = [];
  for (const x of xs) if (Number.isFinite(x)) out.push(x);
  return out;
}

function sortedFinite(xs: readonly number[]): number[] {
  return finiteValues(xs).sort((a, b) => a - b);
}

/** Largest magnitude among `xs` (all finite); 0 for an empty list. */
function maxAbs(xs: readonly number[]): number {
  let m = 0;
  for (const x of xs) {
    const a = Math.abs(x);
    if (a > m) m = a;
  }
  return m;
}

/** `xs` divided by `scale` (> 0), so every value is in [−1, 1] and sums of squares cannot overflow. */
function rescaled(xs: readonly number[], scale: number): number[] {
  return xs.map((x) => x / scale);
}

/** Mean of finite `values` computed on rescaled values, for when the plain sum overflowed. */
function scaledMean(values: readonly number[]): number | null {
  const scale = maxAbs(values);
  if (scale === 0) return 0;
  let acc = 0;
  for (const x of values) acc += x / scale;
  const m = (acc / values.length) * scale;
  return Number.isFinite(m) ? m : null;
}

/** Midpoint of two finite numbers without overflow (`(a + b) / 2` is used whenever it is finite). */
function midpoint(a: number, b: number): number {
  const m = (a + b) / 2;
  return Number.isFinite(m) ? m : a / 2 + b / 2;
}

/**
 * Returns a sorted copy of `xs`, ordered by ascending `key(x)`. Elements with equal keys keep their input order
 * (stable) on every JavaScript engine, independent of the engine's sort implementation.
 * Elements whose key is not a finite number are placed last, in input order.
 */
export function stableSortBy<T>(xs: readonly T[], key: (x: T) => number): T[] {
  const decorated = xs.map((value, index) => {
    const k = key(value);
    return { value, index, k: Number.isFinite(k) ? k : Number.POSITIVE_INFINITY, bad: !Number.isFinite(k) };
  });
  decorated.sort((a, b) => {
    if (a.bad !== b.bad) return a.bad ? 1 : -1;
    if (!a.bad && a.k !== b.k) return a.k < b.k ? -1 : 1;
    return a.index - b.index;
  });
  return decorated.map((d) => d.value);
}

/**
 * Arithmetic mean of the finite values (left-to-right sum / n); `null` when there are none.
 * If the sum overflows, the mean is recomputed on rescaled values (the mean of finite numbers always lies between
 * their min and max, so it is representable).
 */
export function mean(xs: readonly number[]): number | null {
  let sum = 0;
  let n = 0;
  for (const x of xs) {
    if (!Number.isFinite(x)) continue;
    sum += x;
    n++;
  }
  if (n === 0) return null;
  const m = sum / n;
  return Number.isFinite(m) ? m : scaledMean(finiteValues(xs));
}

/**
 * Median of the finite values (mean of the two middle values for even n); `null` when there are none.
 * The two middle values are averaged without overflow.
 */
export function median(xs: readonly number[]): number | null {
  const s = sortedFinite(xs);
  const n = s.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? s[mid]! : midpoint(s[mid - 1]!, s[mid]!);
}

/** Two-pass sample SD of finite values (n ≥ 2); may be non-finite on overflow. */
function plainSd(v: readonly number[]): number {
  const n = v.length;
  let sum = 0;
  for (const x of v) sum += x;
  const m = sum / n;
  let ss = 0;
  for (const x of v) {
    const d = x - m;
    ss += d * d;
  }
  return Math.sqrt(ss / (n - 1));
}

/**
 * Sample standard deviation (n − 1 denominator, two-pass algorithm for numerical stability).
 * Returns 0 for a single value and `null` for no values, or when the SD itself is too large to represent
 * (intermediate overflow is avoided by rescaling).
 */
export function sampleSd(xs: readonly number[]): number | null {
  const v = finiteValues(xs);
  const n = v.length;
  if (n === 0) return null;
  if (n === 1) return 0;
  const sd = plainSd(v);
  if (Number.isFinite(sd)) return sd;
  const scale = maxAbs(v);
  const scaled = plainSd(rescaled(v, scale)) * scale;
  return Number.isFinite(scaled) ? scaled : null;
}

/**
 * Percentile with linear interpolation between closest ranks, identical to NumPy's default
 * `np.percentile(xs, p, method="linear")`: on a sorted copy, `rank = (n − 1)·p/100`, and the result
 * interpolates between `s[floor(rank)]` and `s[floor(rank) + 1]`. The interpolation uses NumPy's `_lerp`
 * formulation (`b − (b − a)(1 − g)` when the fraction `g ≥ 0.5`) so results match NumPy to the last bit.
 *
 * @param p Percentile in [0, 100]; values outside are clamped. `NaN` gives `null`.
 * @returns `null` when `xs` has no finite values.
 */
export function percentile(xs: readonly number[], p: number): number | null {
  if (Number.isNaN(p)) return null;
  const s = sortedFinite(xs);
  const n = s.length;
  if (n === 0) return null;
  const q = Math.min(100, Math.max(0, p)) / 100;
  const rank = (n - 1) * q;
  const lo = Math.floor(rank);
  const hi = Math.min(lo + 1, n - 1);
  const g = rank - lo;
  const a = s[lo]!;
  const b = s[hi]!;
  const diff = b - a;
  if (Number.isFinite(diff)) return g >= 0.5 ? b - diff * (1 - g) : a + diff * g;
  // b − a overflowed (e.g. [−MAX_VALUE, MAX_VALUE]): interpolate with the half-difference, which is finite.
  const half = b / 2 - a / 2;
  return g >= 0.5 ? b - half * (2 * (1 - g)) : a + half * (2 * g);
}

/**
 * Ordinary-least-squares fit `y = slope·x + intercept`.
 *
 * Points with a non-finite coordinate are ignored. Returns `null` when fewer than 2 points remain or when x has
 * no variance. When y has no variance the fit is exact and flat: `slope = 0`, `intercept = y`, `r2 = 0`.
 */
export function linearTrend(points: readonly { x: number; y: number }[]): LinearTrend | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of points) {
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
      xs.push(p.x);
      ys.push(p.y);
    }
  }
  const n = xs.length;
  if (n < 2) return null;
  let xMin = xs[0]!;
  let xMax = xMin;
  let yMin = ys[0]!;
  let yMax = yMin;
  for (let i = 0; i < n; i++) {
    const x = xs[i]!;
    const y = ys[i]!;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  if (xMin === xMax) return null;
  if (yMin === yMax) return { slope: 0, intercept: yMin, r2: 0, n };
  const fit = olsFit(xs, ys);
  if (fit !== null && Number.isFinite(fit.slope) && Number.isFinite(fit.intercept) && Number.isFinite(fit.r2)) {
    return { ...fit, n };
  }
  // Overflow: fit y/sy against x/sx, then undo the scaling (r² is scale invariant).
  const sx = maxAbs(xs);
  const sy = maxAbs(ys);
  const scaled = olsFit(rescaled(xs, sx), rescaled(ys, sy));
  if (scaled === null) return null;
  const slope = (scaled.slope / sx) * sy;
  const intercept = scaled.intercept * sy;
  if (!Number.isFinite(slope) || !Number.isFinite(intercept) || !Number.isFinite(scaled.r2)) return null;
  return { slope, intercept, r2: scaled.r2, n };
}

/** OLS on finite, non-constant data; null when var(x) is 0. Values may be non-finite on overflow. */
function olsFit(xs: readonly number[], ys: readonly number[]): { slope: number; intercept: number; r2: number } | null {
  const n = xs.length;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]!;
    sy += ys[i]!;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const num = sxy * sxy;
  const den = sxx * syy;
  // A non-finite numerator or denominator means overflow: report NaN so the caller rescales.
  const r2 = !(syy > 0) ? 0 : Number.isFinite(num) && Number.isFinite(den) ? Math.min(1, Math.max(0, num / den)) : Number.NaN;
  return { slope, intercept, r2 };
}

/**
 * Pearson product-moment correlation coefficient of paired values.
 * Points with a non-finite coordinate are ignored. Returns `null` with fewer than 2 points or when either
 * variable has no variance. The result is clamped to [−1, 1] to absorb rounding.
 */
export function pearsonCorrelation(points: readonly { x: number; y: number }[]): number | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of points) {
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
      xs.push(p.x);
      ys.push(p.y);
    }
  }
  if (xs.length < 2) return null;
  let xConst = true;
  let yConst = true;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] !== xs[0]) xConst = false;
    if (ys[i] !== ys[0]) yConst = false;
  }
  if (xConst || yConst) return null;
  const r = plainPearson(xs, ys);
  if (r === null || Number.isFinite(r)) return r;
  // Overflow in the sums of squares: r is scale invariant, so recompute on rescaled values.
  const scaled = plainPearson(rescaled(xs, maxAbs(xs)), rescaled(ys, maxAbs(ys)));
  return scaled !== null && Number.isFinite(scaled) ? scaled : null;
}

/** Pearson r of finite paired values; null when a variance is 0; NaN when an intermediate overflowed. */
function plainPearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i]!;
    sumY += ys[i]!;
  }
  const mx = sumX / n;
  const my = sumY / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const denom = Math.sqrt(sxx * syy);
  if (!Number.isFinite(sxx) || !Number.isFinite(syy) || !Number.isFinite(sxy) || !Number.isFinite(denom)) {
    return Number.NaN;
  }
  if (!(sxx > 0) || !(syy > 0) || !(denom > 0)) return null;
  return Math.min(1, Math.max(-1, sxy / denom));
}

/**
 * Trailing moving average: output[i] is the mean of `xs[max(0, i − window + 1) … i]` (partial windows at the
 * start), so the output has the same length as `xs`.
 *
 * `window` is floored and at least 1 (`Infinity` gives a cumulative mean). Non-finite inputs are treated as
 * missing and skipped inside each window; a window that holds no finite value repeats the previous output
 * (positions before the first finite value take the first available average). An input with no finite value
 * at all yields zeros, so the output never contains `NaN`. The running window sum is compensated (Neumaier), so
 * values of very different magnitude do not absorb each other, and if it overflows that window's mean is recomputed
 * from its values (rescaled when needed), so huge finite inputs never produce `Infinity`.
 */
export function movingAverage(xs: readonly number[], window: number): number[] {
  const n = xs.length;
  if (n === 0) return [];
  const w = Number.isNaN(window) ? 1 : Math.max(1, Math.floor(window));
  const raw: (number | null)[] = new Array<number | null>(n);
  // Neumaier-compensated running sum: adding and later subtracting values of very different magnitude would
  // otherwise lose the small ones (1e20 + 1 − 1e20 = 0 in plain floating point).
  let sum = 0;
  let comp = 0;
  const add = (x: number): void => {
    const t = sum + x;
    comp += Math.abs(sum) >= Math.abs(x) ? sum - t + x : x - t + sum;
    sum = t;
  };
  let count = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i]!;
    if (Number.isFinite(x)) {
      add(x);
      count++;
    }
    const drop = i - w;
    if (drop >= 0) {
      const old = xs[drop]!;
      if (Number.isFinite(old)) {
        add(-old);
        count--;
      }
    }
    if (count === 0) {
      // Reset exactly when the window empties so rounding residue never leaks forward.
      sum = 0;
      comp = 0;
      raw[i] = null;
      continue;
    }
    let total = sum + comp;
    if (!Number.isFinite(sum) || !Number.isFinite(comp) || !Number.isFinite(total)) {
      // Overflow: rebuild the window sum from scratch (it may have recovered), else average rescaled values.
      const win: number[] = [];
      for (let j = Math.max(0, i - w + 1); j <= i; j++) {
        const v = xs[j]!;
        if (Number.isFinite(v)) win.push(v);
      }
      sum = 0;
      comp = 0;
      for (const v of win) add(v);
      total = sum + comp;
      raw[i] = Number.isFinite(sum) && Number.isFinite(comp) && Number.isFinite(total) ? total / count : scaledMean(win);
      continue;
    }
    raw[i] = total / count;
  }
  let fill: number | null = null;
  for (const v of raw) {
    if (v !== null) {
      fill = v;
      break;
    }
  }
  if (fill === null) return new Array<number>(n).fill(0);
  const out: number[] = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const v = raw[i];
    if (v !== null && v !== undefined) fill = v;
    out[i] = fill;
  }
  return out;
}
