import { describe, expect, it } from 'vitest';
import { detectGaps, hrStats, isValidBpm, resampleHr, sliceByTime } from '../src/analytics/hr';
import type { HeartRateSample } from '../src/types';

const hr = (pairs: [number, number][]): HeartRateSample[] => pairs.map(([t, bpm]) => ({ t, bpm }));

describe('isValidBpm', () => {
  it('accepts [25, 250] inclusive', () => {
    expect(isValidBpm(25)).toBe(true);
    expect(isValidBpm(250)).toBe(true);
    expect(isValidBpm(24.9)).toBe(false);
    expect(isValidBpm(250.1)).toBe(false);
    expect(isValidBpm(0)).toBe(false);
    expect(isValidBpm(Number.NaN)).toBe(false);
    expect(isValidBpm(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('hrStats', () => {
  it('ignores out-of-range and non-finite samples', () => {
    const s = hrStats(
      hr([
        [0, 60],
        [1000, 70],
        [2000, 0],
        [3000, 80],
        [4000, 300],
        [5000, 90],
        [6000, Number.NaN],
      ]),
    );
    // valid: 60,70,80,90 → mean 75, median 75, SD √((225+25+25+225)/3) = √(500/3)
    // p95: rank 0.95·3 = 2.85 → 80 + 10·0.85 = 88.5
    expect(s).not.toBeNull();
    expect(s!.count).toBe(4);
    expect(s!.mean).toBe(75);
    expect(s!.median).toBe(75);
    expect(s!.min).toBe(60);
    expect(s!.max).toBe(90);
    expect(s!.sd).toBeCloseTo(Math.sqrt(500 / 3), 12);
    expect(s!.p95).toBeCloseTo(88.5, 12);
  });
  it('is not time-weighted', () => {
    // 60 bpm held for a long time still counts as one sample
    const s = hrStats(hr([
      [0, 60],
      [100000, 90],
      [101000, 90],
    ]));
    expect(s!.mean).toBe(80);
  });
  it('handles a single sample and no valid samples', () => {
    expect(hrStats(hr([[0, 72]]))).toEqual({ count: 1, mean: 72, median: 72, min: 72, max: 72, sd: 0, p95: 72 });
    expect(hrStats([])).toBeNull();
    expect(hrStats(hr([[0, 0], [1000, 20]]))).toBeNull();
  });
});

describe('sliceByTime', () => {
  it('keeps start ≤ t < end', () => {
    const xs = [{ t: 0 }, { t: 10 }, { t: 20 }, { t: 30 }];
    expect(sliceByTime(xs, 10, 30)).toEqual([{ t: 10 }, { t: 20 }]);
    expect(sliceByTime(xs, 31, 40)).toEqual([]);
  });
  it('preserves the element type', () => {
    const rr = [{ t: 5, ms: 800 }];
    const out: { t: number; ms: number }[] = sliceByTime(rr, 0, 10);
    expect(out).toEqual(rr);
    expect(out).not.toBe(rr);
  });
});

describe('detectGaps', () => {
  it('reports pairs further apart than maxGapMs', () => {
    const samples = hr([
      [0, 70],
      [1000, 70],
      [2000, 70],
      [8000, 70],
      [9000, 70],
      [15000, 70],
    ]);
    expect(detectGaps(samples)).toEqual([
      { start: 2000, end: 8000, durationMs: 6000 },
      { start: 9000, end: 15000, durationMs: 6000 },
    ]);
    expect(detectGaps(samples, 6000)).toEqual([]);
  });
  it('does not count a spacing exactly equal to maxGapMs', () => {
    expect(detectGaps(hr([[0, 70], [5000, 70]]))).toEqual([]);
    expect(detectGaps(hr([[0, 70], [5001, 70]]))).toEqual([{ start: 0, end: 5001, durationMs: 5001 }]);
  });
  it('handles empty and single-sample input', () => {
    expect(detectGaps([])).toEqual([]);
    expect(detectGaps(hr([[0, 70]]))).toEqual([]);
  });
});

describe('resampleHr', () => {
  it('averages valid samples per bucket', () => {
    const samples = hr([
      [0, 60],
      [400, 70],
      [1200, 80],
      [2600, 90],
    ]);
    expect(resampleHr(samples, 1000)).toEqual([
      { t: 0, bpm: 65 },
      { t: 1000, bpm: 80 },
      { t: 2000, bpm: 90 },
    ]);
  });
  it('gives null for empty buckets and buckets with only invalid samples', () => {
    const samples = hr([
      [0, 60],
      [1500, 0],
      [2500, 80],
    ]);
    expect(resampleHr(samples, 1000)).toEqual([
      { t: 0, bpm: 60 },
      { t: 1000, bpm: null },
      { t: 2000, bpm: 80 },
    ]);
  });
  it('honours explicit start and end (the last bucket contains end)', () => {
    const samples = hr([
      [1000, 60],
      [2000, 70],
      [3000, 80],
    ]);
    expect(resampleHr(samples, 1000, { start: 0, end: 4500 })).toEqual([
      { t: 0, bpm: null },
      { t: 1000, bpm: 60 },
      { t: 2000, bpm: 70 },
      { t: 3000, bpm: 80 },
      { t: 4000, bpm: null },
    ]);
    // samples outside the requested range are ignored
    expect(resampleHr(samples, 1000, { start: 2000, end: 2000 })).toEqual([{ t: 2000, bpm: 70 }]);
    expect(resampleHr(samples, 1000, { start: 3000, end: 2000 })).toEqual([]);
  });
  it('returns [] for an empty input', () => {
    expect(resampleHr([], 1000)).toEqual([]);
    expect(resampleHr([], 1000, { start: 0, end: 10000 })).toEqual([]);
  });
  it('rejects a non-positive interval', () => {
    expect(() => resampleHr(hr([[0, 60]]), 0)).toThrow(RangeError);
    expect(() => resampleHr(hr([[0, 60]]), Number.NaN)).toThrow(RangeError);
  });
});

describe('review fixes', () => {
  it('resampleHr refuses an absurd number of buckets', () => {
    expect(() => resampleHr([{ t: 1.7e12, bpm: 70 }], 1000, { start: 0 })).toThrow(RangeError);
  });
  it('resampleHr ignores the deprecated maxGapMs option', () => {
    const xs: HeartRateSample[] = [
      { t: 0, bpm: 60 },
      { t: 60000, bpm: 100 },
    ];
    expect(resampleHr(xs, 10000, { maxGapMs: 1000 })).toEqual(resampleHr(xs, 10000));
  });
  it('detectGaps treats a NaN maxGapMs as the 5000 ms default', () => {
    const xs: HeartRateSample[] = [0, 1000, 8000].map((t) => ({ t, bpm: 70 }));
    expect(detectGaps(xs, Number.NaN)).toEqual(detectGaps(xs));
  });
});
