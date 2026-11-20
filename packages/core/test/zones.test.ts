import { describe, expect, it } from 'vitest';
import { estimateMaxHr, timeInZones, zonesFromBaseline, zonesFromMaxHr } from '../src/analytics/zones';
import type { HeartRateSample } from '../src/types';

const hr = (pairs: [number, number][]): HeartRateSample[] => pairs.map(([t, bpm]) => ({ t, bpm }));

describe('estimateMaxHr (Tanaka 2001)', () => {
  it('computes 208 − 0.7·age rounded to an integer', () => {
    expect(estimateMaxHr(1986, 2026)).toBe(180); // age 40 → 208 − 28
    expect(estimateMaxHr(1980, 2026)).toBe(176); // age 46 → 175.8
    expect(estimateMaxHr(1996, 2026)).toBe(187); // age 30 → 187
  });
  it('rounds halves up', () => {
    expect(estimateMaxHr(1990, 2025)).toBe(184); // age 35 → 183.5
    expect(estimateMaxHr(2001, 2026)).toBe(191); // age 25 → 190.5
  });
  it('rejects non-finite years', () => {
    expect(() => estimateMaxHr(Number.NaN, 2026)).toThrow(RangeError);
  });
});

describe('zonesFromMaxHr', () => {
  it('builds five %HRmax zones with unrounded bounds', () => {
    expect(zonesFromMaxHr(175)).toEqual([
      { id: 'z1', label: 'Very light', minBpm: 0, maxBpm: 105 },
      { id: 'z2', label: 'Light', minBpm: 105, maxBpm: 122.5 },
      { id: 'z3', label: 'Moderate', minBpm: 122.5, maxBpm: 140 },
      { id: 'z4', label: 'Hard', minBpm: 140, maxBpm: 157.5 },
      { id: 'z5', label: 'Maximum', minBpm: 157.5, maxBpm: Number.POSITIVE_INFINITY },
    ]);
  });
  it('has exact decimal bounds (no binary error from 0.7)', () => {
    const z = zonesFromMaxHr(180);
    expect(z.map((x) => x.minBpm)).toEqual([0, 108, 126, 144, 162]);
  });
});

describe('zonesFromBaseline', () => {
  it('builds four zones relative to resting HR', () => {
    expect(zonesFromBaseline(65)).toEqual([
      { id: 'rest', label: 'At rest', minBpm: 0, maxBpm: 75 },
      { id: 'elevated', label: 'Elevated', minBpm: 75, maxBpm: 85 },
      { id: 'high', label: 'High', minBpm: 85, maxBpm: 95 },
      { id: 'very-high', label: 'Very high', minBpm: 95, maxBpm: Number.POSITIVE_INFINITY },
    ]);
  });
});

describe('timeInZones', () => {
  const zones = zonesFromBaseline(65); // rest <75, elevated <85, high <95, very-high ≥95

  it('weights each sample by its dwell time; the last sample uses the median dwell', () => {
    // dwells 1000, 1000, 1000; last = median(1000,1000,1000) = 1000 → 1 s per zone
    const out = timeInZones(
      hr([
        [0, 70],
        [1000, 80],
        [2000, 90],
        [3000, 100],
      ]),
      zones,
    );
    expect(out).toEqual([
      { id: 'rest', label: 'At rest', seconds: 1, fraction: 0.25 },
      { id: 'elevated', label: 'Elevated', seconds: 1, fraction: 0.25 },
      { id: 'high', label: 'High', seconds: 1, fraction: 0.25 },
      { id: 'very-high', label: 'Very high', seconds: 1, fraction: 0.25 },
    ]);
  });

  it('uses the median of the other dwells for the last sample', () => {
    // dwells 1000, 2000, 4000; last = median(1000, 2000, 4000) = 2000 → rest 7 s, very-high 2 s
    const out = timeInZones(
      hr([
        [0, 70],
        [1000, 70],
        [3000, 70],
        [7000, 100],
      ]),
      zones,
    );
    expect(out.map((z) => z.seconds)).toEqual([7, 0, 0, 2]);
    expect(out[0]!.fraction).toBeCloseTo(7 / 9, 12);
    expect(out[3]!.fraction).toBeCloseTo(2 / 9, 12);
  });

  it('caps dwell at maxGapMs so gaps are not credited to a zone', () => {
    // dwells 1000, min(10000, 5000) = 5000, 1000; last = median(1000, 5000, 1000) = 1000
    // rest: 1 + 5 = 6 s; high: 1 + 1 = 2 s → fractions 0.75 / 0.25
    const out = timeInZones(
      hr([
        [0, 70],
        [1000, 70],
        [11000, 90],
        [12000, 90],
      ]),
      zones,
    );
    expect(out.map((z) => z.seconds)).toEqual([6, 0, 2, 0]);
    expect(out.map((z) => z.fraction)).toEqual([0.75, 0, 0.25, 0]);
    // custom cap: two samples 10 s apart with maxGapMs 3000 → 3 s each (last = min(median([3000]), 3000))
    expect(
      timeInZones(
        hr([
          [0, 70],
          [10000, 70],
        ]),
        zones,
        3000,
      )[0]!.seconds,
    ).toBe(6);
  });

  it('gives zero time for a single sample and for no samples', () => {
    expect(timeInZones(hr([[0, 70]]), zones).map((z) => [z.seconds, z.fraction])).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
    expect(timeInZones([], zones).map((z) => z.id)).toEqual(['rest', 'elevated', 'high', 'very-high']);
  });

  it('ignores invalid samples and sorts by time', () => {
    // valid sorted: (0,70), (1000,100), (2000,70); the 0-bpm sample is dropped before dwells are computed
    const out = timeInZones(
      hr([
        [2000, 70],
        [0, 70],
        [1500, 0],
        [1000, 100],
      ]),
      zones,
    );
    expect(out.map((z) => z.seconds)).toEqual([2, 0, 0, 1]);
  });

  it('assigns bounds as minBpm ≤ bpm < maxBpm', () => {
    const out = timeInZones(
      hr([
        [0, 75],
        [1000, 75],
      ]),
      zones,
    );
    expect(out.map((z) => z.seconds)).toEqual([0, 2, 0, 0]);
  });
});
