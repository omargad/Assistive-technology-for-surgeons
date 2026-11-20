import { describe, expect, it } from 'vitest';
import {
  linearTrend,
  mean,
  median,
  movingAverage,
  pearsonCorrelation,
  percentile,
  sampleSd,
  stableSortBy,
} from '../src/analytics/stats';

describe('mean', () => {
  it('averages values', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(mean([7])).toBe(7);
  });
  it('returns null for no values', () => {
    expect(mean([])).toBeNull();
  });
  it('ignores non-finite values and never returns NaN', () => {
    expect(mean([1, Number.NaN, 3, Number.POSITIVE_INFINITY])).toBe(2);
    expect(mean([Number.NaN])).toBeNull();
  });
});

describe('median', () => {
  it('takes the middle value for odd n', () => {
    expect(median([3, 1, 2])).toBe(2);
  });
  it('averages the two middle values for even n', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
  it('returns null for no values', () => {
    expect(median([])).toBeNull();
  });
  it('does not mutate its input', () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe('sampleSd', () => {
  it('uses the n−1 denominator', () => {
    // mean 5; squared deviations 9,1,1,1,0,0,4,16 → Σ = 32; 32/7 = 4.571428…; √ = 2.138089935…
    expect(sampleSd([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(Math.sqrt(32 / 7), 12);
  });
  it('is 0 for a single value and null for none', () => {
    expect(sampleSd([5])).toBe(0);
    expect(sampleSd([])).toBeNull();
  });
});

describe('percentile (NumPy "linear")', () => {
  const xs = [15, 20, 35, 40, 50];
  it('interpolates between closest ranks', () => {
    // rank = 0.4·4 = 1.6 → 20 + (35 − 20)·0.6 = 29 (np.percentile(xs, 40) == 29.0)
    expect(percentile(xs, 40)).toBeCloseTo(29, 12);
    // rank = 0.95·4 = 3.8 → 40 + 10·0.8 = 48
    expect(percentile(xs, 95)).toBeCloseTo(48, 12);
    // rank = 0.25·3 = 0.75 → 1 + 1·0.75
    expect(percentile([1, 2, 3, 4], 25)).toBe(1.75);
  });
  it('hits the extremes and the median exactly', () => {
    expect(percentile(xs, 0)).toBe(15);
    expect(percentile(xs, 50)).toBe(35);
    expect(percentile(xs, 100)).toBe(50);
  });
  it('sorts a copy of unsorted input', () => {
    const unsorted = [50, 15, 40, 20, 35];
    expect(percentile(unsorted, 40)).toBeCloseTo(29, 12);
    expect(unsorted).toEqual([50, 15, 40, 20, 35]);
  });
  it('clamps p to [0, 100] and handles edge inputs', () => {
    expect(percentile(xs, 150)).toBe(50);
    expect(percentile(xs, -5)).toBe(15);
    expect(percentile(xs, Number.NaN)).toBeNull();
    expect(percentile([], 50)).toBeNull();
    expect(percentile([7], 95)).toBe(7);
  });
});

describe('linearTrend', () => {
  it('fits an exact line', () => {
    expect(linearTrend([
      { x: 0, y: 1 },
      { x: 1, y: 3 },
      { x: 2, y: 5 },
    ])).toEqual({ slope: 2, intercept: 1, r2: 1, n: 3 });
  });
  it('computes slope, intercept and r² by OLS', () => {
    // x̄ = ȳ = 1.5; Sxx = 5, Sxy = 1, Syy = 1 → slope 0.2, intercept 1.2, r² = 1/(5·1) = 0.2
    const fit = linearTrend([
      { x: 0, y: 1 },
      { x: 1, y: 2 },
      { x: 2, y: 1 },
      { x: 3, y: 2 },
    ]);
    expect(fit).not.toBeNull();
    expect(fit!.slope).toBeCloseTo(0.2, 12);
    expect(fit!.intercept).toBeCloseTo(1.2, 12);
    expect(fit!.r2).toBeCloseTo(0.2, 12);
    expect(fit!.n).toBe(4);
  });
  it('returns null for n < 2 or no variance in x', () => {
    expect(linearTrend([])).toBeNull();
    expect(linearTrend([{ x: 1, y: 2 }])).toBeNull();
    expect(linearTrend([
      { x: 0.1, y: 1 },
      { x: 0.1, y: 2 },
      { x: 0.1, y: 3 },
    ])).toBeNull();
  });
  it('gives r² = 0 (and a flat line) when y has no variance', () => {
    expect(linearTrend([
      { x: 0, y: 3 },
      { x: 1, y: 3 },
      { x: 2, y: 3 },
    ])).toEqual({ slope: 0, intercept: 3, r2: 0, n: 3 });
  });
  it('ignores points with non-finite coordinates', () => {
    const fit = linearTrend([
      { x: 0, y: 1 },
      { x: 1, y: Number.NaN },
      { x: 2, y: 5 },
    ]);
    expect(fit).toEqual({ slope: 2, intercept: 1, r2: 1, n: 2 });
  });
});

describe('pearsonCorrelation', () => {
  it('is ±1 for perfectly linear data', () => {
    expect(pearsonCorrelation([
      { x: 1, y: 2 },
      { x: 2, y: 4 },
      { x: 3, y: 6 },
    ])).toBeCloseTo(1, 12);
    expect(pearsonCorrelation([
      { x: 1, y: 6 },
      { x: 2, y: 4 },
      { x: 3, y: 2 },
    ])).toBeCloseTo(-1, 12);
  });
  it('matches a hand-computed value', () => {
    // Same data as the OLS example: r = Sxy/√(Sxx·Syy) = 1/√5
    expect(pearsonCorrelation([
      { x: 0, y: 1 },
      { x: 1, y: 2 },
      { x: 2, y: 1 },
      { x: 3, y: 2 },
    ])).toBeCloseTo(1 / Math.sqrt(5), 12);
  });
  it('is null without variance or with fewer than 2 points', () => {
    expect(pearsonCorrelation([{ x: 1, y: 1 }])).toBeNull();
    expect(pearsonCorrelation([
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ])).toBeNull();
  });
});

describe('movingAverage', () => {
  it('uses a trailing window with partial windows at the start', () => {
    expect(movingAverage([1, 2, 3, 4, 5], 3)).toEqual([1, 1.5, 2, 3, 4]);
  });
  it('returns the input for window 1 and cumulative means for a window longer than the input', () => {
    expect(movingAverage([4, 8, 6], 1)).toEqual([4, 8, 6]);
    expect(movingAverage([4, 8, 6], 10)).toEqual([4, 6, 6]);
    expect(movingAverage([4, 8, 6], Number.POSITIVE_INFINITY)).toEqual([4, 6, 6]);
  });
  it('keeps the input length and treats invalid windows as 1', () => {
    expect(movingAverage([], 3)).toEqual([]);
    expect(movingAverage([1, 2], 0)).toEqual([1, 2]);
    expect(movingAverage([1, 2], Number.NaN)).toEqual([1, 2]);
  });
  it('skips non-finite values and never emits NaN', () => {
    // windows (w=2): [1] → 1; [1,NaN] → 1; [NaN,3] → 3; [3,5] → 4
    expect(movingAverage([1, Number.NaN, 3, 5], 2)).toEqual([1, 1, 3, 4]);
    // a window with only missing values repeats the previous output; leading gaps take the first average
    expect(movingAverage([Number.NaN, 2, Number.NaN, Number.NaN], 1)).toEqual([2, 2, 2, 2]);
    expect(movingAverage([Number.NaN, Number.NaN], 2)).toEqual([0, 0]);
  });
});

describe('stableSortBy', () => {
  it('sorts by key and keeps input order for ties', () => {
    const xs = [
      { k: 2, id: 'a' },
      { k: 1, id: 'b' },
      { k: 2, id: 'c' },
      { k: 1, id: 'd' },
    ];
    expect(stableSortBy(xs, (x) => x.k).map((x) => x.id)).toEqual(['b', 'd', 'a', 'c']);
    expect(xs.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('puts non-finite keys last in input order', () => {
    expect(stableSortBy([Number.NaN, 3, 1, Number.POSITIVE_INFINITY], (x) => x)).toEqual([
      1,
      3,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]);
  });
});

describe('overflow never yields NaN or Infinity (SPEC ground rule)', () => {
  const MAX = Number.MAX_VALUE;
  it('normal inputs take the ordinary path (bit-identical results)', () => {
    expect(mean([0.1, 0.2, 0.3])).toBe((0.1 + 0.2 + 0.3) / 3);
    expect(sampleSd([1, 2, 3, 4])).toBe(Math.sqrt(5 / 3));
  });
  it('sampleSd rescales when squares overflow, and is null when the SD is not representable', () => {
    const sd = sampleSd([0, 1e200]);
    expect(sd).not.toBeNull();
    expect(sd! / (1e200 / Math.SQRT2)).toBeCloseTo(1, 12);
    expect(sampleSd([-MAX, MAX])).toBeNull();
  });
  it('linearTrend rescales instead of returning r² = NaN', () => {
    const fit = linearTrend([
      { x: 0, y: -MAX },
      { x: 1, y: MAX },
      { x: 2, y: 0 },
    ]);
    expect(fit).not.toBeNull();
    expect(Number.isFinite(fit!.slope) && Number.isFinite(fit!.intercept)).toBe(true);
    expect(fit!.r2).toBeCloseTo(0.25, 12);
    const big = linearTrend([
      { x: 0, y: 0 },
      { x: 1, y: 1e300 },
      { x: 2, y: 2e300 },
    ]);
    expect(big!.r2).toBeCloseTo(1, 12);
    expect(big!.slope / 1e300).toBeCloseTo(1, 12);
  });
  it('pearsonCorrelation stays within [-1, 1] for huge values', () => {
    expect(pearsonCorrelation([
      { x: 0, y: -MAX },
      { x: 1, y: 0 },
      { x: 2, y: MAX },
    ])).toBeCloseTo(1, 12);
  });
  it('movingAverage recovers after an overflowing window', () => {
    expect(movingAverage([MAX, MAX, MAX, 1, 1], 2)).toEqual([MAX, MAX, MAX, MAX / 2 + 0.5, 1]);
  });
});
