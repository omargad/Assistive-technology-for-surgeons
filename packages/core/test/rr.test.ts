import { describe, expect, it } from 'vitest';
import { baevskyStressIndex, cleanRr, computeHrv, hrvTimeDomain, rollingHrv } from '../src/analytics/rr';
import type { RRInterval } from '../src/types';

/** RR series whose delivery times are the cumulative sum of the intervals (no dropouts). */
function contiguous(ms: number[], t0 = 0): RRInterval[] {
  let t = t0;
  return ms.map((m) => {
    t += Number.isFinite(m) ? m : 1000;
    return { t, ms: m };
  });
}

function alternating(count: number, a: number, b: number): number[] {
  return Array.from({ length: count }, (_, i) => (i % 2 === 0 ? a : b));
}

describe('cleanRr', () => {
  it('rule 1: rejects non-finite and out-of-range intervals (bounds inclusive)', () => {
    // Each valid beat has only 2 rule-1-valid neighbours, so rule 2 is skipped everywhere.
    const { valid, report } = cleanRr(contiguous([800, 250, 810, 2100, 790, Number.NaN]));
    expect(valid).toEqual([true, false, true, false, true, false]);
    expect(report).toEqual({ total: 6, removed: 3, ratio: 0.5 });
    expect(cleanRr(contiguous([300, 2000])).valid).toEqual([true, true]);
    expect(cleanRr(contiguous([299.9, 2000.1])).valid).toEqual([false, false]);
  });

  it('rule 2: rejects a beat deviating > 20 % from the local median', () => {
    // idx 4: neighbours 790,795,800,800,805,810,810 → median 800; |1200 − 800|/800 = 0.5 > 0.2
    // idx 0: neighbours incl. 1200 → median 805; |800 − 805|/805 ≈ 0.006 → valid
    const { valid, report } = cleanRr(contiguous([800, 810, 790, 805, 1200, 795, 800, 810]));
    expect(valid).toEqual([true, true, true, true, false, true, true, true]);
    expect(report.removed).toBe(1);
    expect(report.ratio).toBe(1 / 8);
  });

  it('rule 2: a deviation of exactly maxDeviation is still valid', () => {
    // idx 3: neighbours 1000,1000,1000 → |1200 − 1000|/1000 = 0.2 (not > 0.2)
    expect(cleanRr(contiguous([1000, 1000, 1000, 1200])).valid).toEqual([true, true, true, true]);
    expect(cleanRr(contiguous([1000, 1000, 1000, 1201])).valid).toEqual([true, true, true, false]);
  });

  it('clamps the window at the ends and skips rule 2 with fewer than 3 neighbours', () => {
    // window 5 → ±2 beats. idx 0 has neighbours {800, 1200} (2) → skipped; idx 1 has {800,1200,800} → median 800;
    // idx 2 has {800,800,800,800} → 1200 is 50 % off → invalid; idx 4 has {1200, 800} (2) → skipped.
    expect(cleanRr(contiguous([800, 800, 1200, 800, 800]), { window: 5 }).valid).toEqual([
      true,
      true,
      false,
      true,
      true,
    ]);
    // window 3 → at most 2 neighbours → rule 2 never applies
    expect(cleanRr(contiguous([800, 800, 1200, 800, 800]), { window: 3 }).valid).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it('builds the local median only from rule-1-valid neighbours', () => {
    // idx 2 (1000), window 5: neighbours 1000, 2500 (fails rule 1), 700, 700 → median of {1000,700,700} = 700
    // → |1000 − 700|/700 ≈ 0.43 → invalid. (Had 2500 been used, the median would be 850 and 1000 would pass.)
    // idx 0: only one valid neighbour (idx 2) → skipped. idx 3: {1000, 700} → skipped. idx 4: {1000, 700} → skipped.
    const { valid, report } = cleanRr(contiguous([1000, 2500, 1000, 700, 700]), { window: 5 });
    expect(valid).toEqual([true, false, false, true, true]);
    expect(report).toEqual({ total: 5, removed: 2, ratio: 0.4 });
  });

  it('honours custom limits', () => {
    const rr = contiguous([800, 810, 790, 805, 1200, 795, 800, 810]);
    expect(cleanRr(rr, { maxDeviation: 0.6 }).valid.every(Boolean)).toBe(true);
    expect(cleanRr(rr, { maxMs: 1100 }).valid).toEqual([true, true, true, true, false, true, true, true]);
    expect(cleanRr(rr, { minMs: 801, maxDeviation: 1 }).valid).toEqual([
      false,
      true,
      false,
      true,
      true,
      false,
      false,
      true,
    ]);
  });

  it('handles empty input', () => {
    expect(cleanRr([])).toEqual({ valid: [], report: { total: 0, removed: 0, ratio: 0 } });
  });
});

describe('hrvTimeDomain', () => {
  it('computes the Task Force time-domain measures', () => {
    // x = 800, 850, 820, 900: mean 842.5; deviations −42.5, 7.5, −22.5, 57.5 → Σd² = 5675 → SDNN = √(5675/3)
    // successive differences 50, −30, 80 → RMSSD = √((2500 + 900 + 6400)/3) = √(9800/3)
    // |d| > 50: only 80 (50 is not > 50) → pNN50 = 100/3
    const h = hrvTimeDomain([800, 850, 820, 900]);
    expect(h).not.toBeNull();
    expect(h!.n).toBe(4);
    expect(h!.pairs).toBe(3);
    expect(h!.meanRr).toBe(842.5);
    expect(h!.sdnn).toBeCloseTo(Math.sqrt(5675 / 3), 10);
    expect(h!.rmssd).toBeCloseTo(Math.sqrt(9800 / 3), 10);
    expect(h!.pnn50).toBeCloseTo(100 / 3, 10);
    expect(h!.meanHr).toBeCloseTo(60000 / 842.5, 10);
  });
  it('returns null with fewer than 2 intervals or non-finite values', () => {
    expect(hrvTimeDomain([])).toBeNull();
    expect(hrvTimeDomain([800])).toBeNull();
    expect(hrvTimeDomain([800, Number.NaN])).toBeNull();
  });
});

describe('computeHrv', () => {
  it('computes HRV over a clean series', () => {
    // 15 × (800, 850): mean 825; every deviation is ±25 → SDNN = √(30·625/29); |d| = 50 → RMSSD 50, pNN50 0
    const { hrv, artifacts } = computeHrv(contiguous(alternating(30, 800, 850)));
    expect(artifacts).toEqual({ total: 30, removed: 0, ratio: 0 });
    expect(hrv).not.toBeNull();
    expect(hrv!.n).toBe(30);
    expect(hrv!.pairs).toBe(29);
    expect(hrv!.meanRr).toBe(825);
    expect(hrv!.sdnn).toBeCloseTo(Math.sqrt((30 * 625) / 29), 10);
    expect(hrv!.rmssd).toBe(50);
    expect(hrv!.pnn50).toBe(0);
    expect(hrv!.meanHr).toBeCloseTo(60000 / 825, 10);
  });

  it('an invalid beat breaks a pair instead of joining its neighbours', () => {
    // valid = [T, F, T, T]; only the pair (900, 905) is used → RMSSD 5.
    // (Joining 800 → 900 across the artefact would give RMSSD √((100² + 5²)/2) ≈ 70.8.)
    // SDNN pools 800, 900, 905: mean 2605/3, deviations −205/3, 95/3, 110/3 → Σd² = 63150/9 → SDNN = √(63150/18)
    const { hrv, artifacts } = computeHrv(contiguous([800, 2500, 900, 905]), { minIntervals: 2 });
    expect(artifacts).toEqual({ total: 4, removed: 1, ratio: 0.25 });
    expect(hrv).not.toBeNull();
    expect(hrv!.n).toBe(3);
    expect(hrv!.pairs).toBe(1);
    expect(hrv!.rmssd).toBe(5);
    expect(hrv!.pnn50).toBe(0);
    expect(hrv!.meanRr).toBeCloseTo(2605 / 3, 10);
    expect(hrv!.sdnn).toBeCloseTo(Math.sqrt(63150 / 18), 10);
  });

  it('splits runs at data dropouts (t gap > gapMs + ms)', () => {
    // 1800 → 10000 is 8200 ms > 3000 + 900 → new run, so the 810 → 900 pair is not used.
    const rr: RRInterval[] = [
      { t: 1000, ms: 800 },
      { t: 1800, ms: 810 },
      { t: 10000, ms: 900 },
      { t: 10910, ms: 910 },
    ];
    const split = computeHrv(rr, { minIntervals: 2 }).hrv;
    expect(split!.pairs).toBe(2);
    expect(split!.rmssd).toBe(10);
    expect(split!.n).toBe(4);
    expect(split!.meanRr).toBe(855); // SDNN/meanRr still pool all valid beats across runs
    // With a huge gapMs it is one run: differences 10, 90, 10 → RMSSD √(8300/3)
    const joined = computeHrv(rr, { minIntervals: 2, gapMs: 100000 }).hrv;
    expect(joined!.pairs).toBe(3);
    expect(joined!.rmssd).toBeCloseTo(Math.sqrt(8300 / 3), 10);
  });

  it('a delivery gap of exactly gapMs + ms stays in the same run', () => {
    const same = computeHrv(
      [
        { t: 0, ms: 800 },
        { t: 3900, ms: 900 },
      ],
      { minIntervals: 2 },
    ).hrv;
    expect(same!.pairs).toBe(1);
    expect(same!.rmssd).toBe(100);
    const broken = computeHrv(
      [
        { t: 0, ms: 800 },
        { t: 3901, ms: 900 },
      ],
      { minIntervals: 2 },
    ).hrv;
    expect(broken).toBeNull(); // 0 valid pairs
  });

  it('returns null below minIntervals (default 30) but still reports artefacts', () => {
    const r = computeHrv(contiguous(alternating(29, 800, 850)));
    expect(r.hrv).toBeNull();
    expect(r.artifacts).toEqual({ total: 29, removed: 0, ratio: 0 });
    expect(computeHrv(contiguous(alternating(29, 800, 850)), { minIntervals: 29 }).hrv).not.toBeNull();
  });

  it('returns null when no valid pair exists', () => {
    const r = computeHrv(contiguous([800, 2500, 800, 2500, 800]), { minIntervals: 2 });
    expect(r.hrv).toBeNull();
    expect(r.artifacts.removed).toBe(2);
  });

  it('handles empty input', () => {
    expect(computeHrv([])).toEqual({ hrv: null, artifacts: { total: 0, removed: 0, ratio: 0 } });
  });
});

describe('rollingHrv', () => {
  // One beat per second, t = 0 … 124000, alternating 1000 / 1040 ms.
  const rr: RRInterval[] = Array.from({ length: 125 }, (_, i) => ({ t: i * 1000, ms: i % 2 === 0 ? 1000 : 1040 }));

  it('emits complete windows ending at start + windowMs + k·stepMs', () => {
    const out = rollingHrv(rr);
    // window ends 60000, 90000, 120000 (150000 > last t = 124000)
    expect(out.map((p) => p.t)).toEqual([60000, 90000, 120000]);
    for (const p of out) {
      // 60 beats per window (30 × 1000, 30 × 1040): mean 1020, |d| = 40 → RMSSD 40, SDNN √(60·400/59)
      expect(p.n).toBe(60);
      expect(p.rmssd).toBe(40);
      expect(p.sdnn).toBeCloseTo(Math.sqrt(24000 / 59), 10);
      expect(p.meanHr).toBeCloseTo(60000 / 1020, 10);
    }
  });

  it('uses minIntervals 20 by default and reports n with null values for sparse windows', () => {
    const sparse: RRInterval[] = Array.from({ length: 10 }, (_, i) => ({ t: i * 1000, ms: 1000 }));
    expect(rollingHrv(sparse, { start: 0, end: 60000 })).toEqual([
      { t: 60000, rmssd: null, sdnn: null, meanHr: null, n: 10 },
    ]);
    expect(rollingHrv(sparse, { start: 0, end: 60000, minIntervals: 5 })).toEqual([
      { t: 60000, rmssd: 0, sdnn: 0, meanHr: 60, n: 10 },
    ]);
    const nineteen = rr.slice(0, 19);
    expect(rollingHrv(nineteen, { start: 0, end: 60000 })[0]!.rmssd).toBeNull();
    const twenty = rr.slice(0, 20);
    expect(rollingHrv(twenty, { start: 0, end: 60000 })[0]!.rmssd).toBe(40);
  });

  it('honours custom window and step', () => {
    const out = rollingHrv(rr, { windowMs: 30000, stepMs: 60000 });
    expect(out.map((p) => p.t)).toEqual([30000, 90000]);
    expect(out.map((p) => p.n)).toEqual([30, 30]);
  });

  it('gives the same values for unsorted input', () => {
    const reversed = rr.slice().reverse();
    const out = rollingHrv(reversed);
    expect(out.map((p) => p.t)).toEqual([60000, 90000, 120000]);
    expect(out[0]!.rmssd).toBe(40);
    expect(out[0]!.n).toBe(60);
  });

  it('returns [] for empty input or when no complete window fits', () => {
    expect(rollingHrv([])).toEqual([]);
    expect(rollingHrv(rr.slice(0, 41))).toEqual([]); // span 0 … 40000 < 60000
  });

  it('rejects non-positive window or step', () => {
    expect(() => rollingHrv(rr, { stepMs: 0 })).toThrow(RangeError);
    expect(() => rollingHrv(rr, { windowMs: -1 })).toThrow(RangeError);
  });
});

describe('baevskyStressIndex', () => {
  const repeat = (value: number, count: number): number[] => Array.from({ length: count }, () => value);

  it('computes SI = AMo / (2·Mo·MxDMn) on a crafted histogram', () => {
    // 20 × 800 (bin [800,850) → Mo = 0.825 s), 5 × 700, 5 × 900:
    // AMo = 20/30·100 = 66.67 %, MxDMn = 0.2 s → SI = 66.67 / (2·0.825·0.2) = 66.67 / 0.33 ≈ 202.02
    const xs = [...repeat(700, 5), ...repeat(800, 20), ...repeat(900, 5)];
    expect(baevskyStressIndex(xs)).toBeCloseTo(200 / 3 / 0.33, 9);
    // order does not matter
    expect(baevskyStressIndex(xs.slice().reverse())).toBeCloseTo(200 / 3 / 0.33, 9);
  });

  it('breaks ties towards the lowest bin', () => {
    // 15 × 700 and 15 × 900 → Mo = 0.725 s, AMo = 50 % → SI = 50 / (2·0.725·0.2) = 50 / 0.29
    const xs = [...repeat(900, 15), ...repeat(700, 15)];
    expect(baevskyStressIndex(xs)).toBeCloseTo(50 / 0.29, 9);
  });

  it('honours a custom bin width', () => {
    // binMs 100: 800 → [800, 900) → Mo = 0.85 s → SI = 66.67 / (2·0.85·0.2) = 66.67 / 0.34
    const xs = [...repeat(700, 5), ...repeat(800, 20), ...repeat(900, 5)];
    expect(baevskyStressIndex(xs, 100)).toBeCloseTo(200 / 3 / 0.34, 9);
  });

  it('returns null with fewer than 30 intervals or zero range', () => {
    expect(baevskyStressIndex(repeat(800, 29).concat([900]).slice(0, 29))).toBeNull();
    expect(baevskyStressIndex(repeat(800, 30))).toBeNull();
    expect(baevskyStressIndex([])).toBeNull();
  });

  it('ignores non-finite values', () => {
    const xs = [...repeat(700, 5), ...repeat(800, 20), ...repeat(900, 5)];
    expect(baevskyStressIndex([...xs, Number.NaN])).toBeCloseTo(200 / 3 / 0.33, 9);
    expect(baevskyStressIndex([...repeat(800, 29), Number.NaN])).toBeNull();
  });

  it('rejects a non-positive bin width', () => {
    expect(() => baevskyStressIndex([800], 0)).toThrow(RangeError);
  });
});
