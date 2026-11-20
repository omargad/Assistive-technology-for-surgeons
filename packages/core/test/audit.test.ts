/**
 * Independent mathematical audit of @surgeonpulse/core.
 *
 * Every expected value in this file was derived by hand from SPEC.md and the
 * cited literature (and cross-checked with a throw-away numpy reference), NOT
 * from the implementation. The arithmetic is shown next to each expectation so
 * a reviewer can re-derive it without running anything.
 *
 * References
 * - Task Force of the ESC/NASPE (1996). Heart rate variability: standards of
 *   measurement, physiological interpretation and clinical use. Circulation 93:1043–1065.
 * - Tanaka H, Monahan KD, Seals DR (2001). Age-predicted maximal heart rate revisited. JACC 37:153–156.
 * - Baevsky RM et al. — stress index SI = AMo / (2·Mo·MxDMn).
 * - Wilson MR et al. (2011). Development and validation of a surgical workload measure: the SURG-TLX.
 *   World J Surg 35:1961–1969.
 * - Bluetooth SIG, Heart Rate Service / Heart Rate Measurement characteristic (0x2A37).
 * - RFC 4180 (CSV), RFC 4648 (base64).
 */
import { describe, expect, it } from 'vitest';
import {
  baevskyStressIndex,
  base64ToBytes,
  bytesToBase64,
  cleanRr,
  computeHrv,
  defaultEpisodeThreshold,
  derivePhases,
  detectStressEpisodes,
  estimateMaxHr,
  hrvTimeDomain,
  linearTrend,
  mean,
  median,
  NASA_TLX_DIMENSIONS,
  parseCsv,
  parseHeartRateMeasurement,
  percentile,
  phaseAt,
  sampleSd,
  scoreWorkload,
  sessionEnd,
  SURG_TLX_DIMENSIONS,
  timeInZones,
  tlxPairs,
  toCsv,
  zonesFromBaseline,
  zonesFromMaxHr,
} from '../src/index';
import type {
  Baseline,
  HeartRateSample,
  HrStats,
  HrvTimeDomain,
  NasaTlxResponse,
  PhaseSegment,
  RRInterval,
  SessionEvent,
  SurgicalSession,
  SurgTlxResponse,
} from '../src/index';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Assert every numeric field of an HRV result matches the expectation to `digits` decimals. */
function expectHrv(actual: HrvTimeDomain | null, expected: HrvTimeDomain, digits = 9): void {
  expect(actual).not.toBeNull();
  const a = actual as HrvTimeDomain;
  expect(a.n).toBe(expected.n);
  expect(a.pairs).toBe(expected.pairs);
  expect(a.meanRr).toBeCloseTo(expected.meanRr, digits);
  expect(a.sdnn).toBeCloseTo(expected.sdnn, digits);
  expect(a.rmssd).toBeCloseTo(expected.rmssd, digits);
  expect(a.pnn50).toBeCloseTo(expected.pnn50, digits);
  expect(a.meanHr).toBeCloseTo(expected.meanHr, digits);
}

/**
 * Build RR intervals whose reception time advances by the interval itself
 * (beat-by-beat delivery). `extra[i]` adds an additional delay before beat i,
 * which is how a data dropout is simulated.
 */
function cumulative(ms: readonly number[], t0 = 1_000_000, extra: Record<number, number> = {}): RRInterval[] {
  let t = t0;
  return ms.map((m, i) => {
    t += (Number.isFinite(m) ? m : 1000) + (extra[i] ?? 0);
    return { t, ms: m };
  });
}

/** Alternating 800/840 ms series of length n (even indices 800, odd 840). */
function alt(n: number, a = 800, b = 840): number[] {
  return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? a : b));
}

function mkSession(partial: Partial<SurgicalSession> & { startedAt: number }): SurgicalSession {
  return {
    schemaVersion: 1,
    id: 'audit-session',
    participantCode: 'AUD-01',
    procedure: { name: 'Audit procedure' },
    status: 'completed',
    sensor: { source: 'simulated' },
    app: { version: '0.0.0', platform: 'unknown' },
    samples: [],
    rr: [],
    events: [],
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

describe('audit: stats', () => {
  it('mean / median basics', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(mean([])).toBeNull();
    // sorted [1,3,7,9] -> (3+7)/2 = 5
    expect(median([9, 1, 7, 3])).toBe(5);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([])).toBeNull();
  });

  it('percentile matches numpy.percentile(method="linear") (rank = p/100·(n−1))', () => {
    // [1,2,3,4], n−1 = 3
    //  p=25 -> rank 0.75 -> 1 + 0.75·(2−1) = 1.75
    //  p=50 -> rank 1.5  -> 2 + 0.5 = 2.5
    //  p=75 -> rank 2.25 -> 3 + 0.25 = 3.25
    //  p=90 -> rank 2.7  -> 3 + 0.7 = 3.7
    const a = [1, 2, 3, 4];
    expect(percentile(a, 0)).toBeCloseTo(1, 12);
    expect(percentile(a, 25)).toBeCloseTo(1.75, 12);
    expect(percentile(a, 50)).toBeCloseTo(2.5, 12);
    expect(percentile(a, 75)).toBeCloseTo(3.25, 12);
    expect(percentile(a, 90)).toBeCloseTo(3.7, 12);
    expect(percentile(a, 100)).toBeCloseTo(4, 12);

    // unsorted [40,15,50,20,35] -> sorted [15,20,35,40,50], n−1 = 4
    //  p=5  -> rank 0.2 -> 15 + 0.2·5  = 16
    //  p=30 -> rank 1.2 -> 20 + 0.2·15 = 23
    //  p=40 -> rank 1.6 -> 20 + 0.6·15 = 29
    //  p=95 -> rank 3.8 -> 40 + 0.8·10 = 48
    const b = [40, 15, 50, 20, 35];
    const bCopy = [...b];
    expect(percentile(b, 5)).toBeCloseTo(16, 12);
    expect(percentile(b, 30)).toBeCloseTo(23, 12);
    expect(percentile(b, 40)).toBeCloseTo(29, 12);
    expect(percentile(b, 95)).toBeCloseTo(48, 12);
    expect(b).toEqual(bCopy); // sorted *copy*: input not mutated

    // [-3.5,0,2.25,10,7] -> sorted [-3.5,0,2.25,7,10]
    //  p=12.5 -> rank 0.5   -> −3.5 + 0.5·3.5 = −1.75
    //  p=66.6 -> rank 2.664 -> 2.25 + 0.664·(7−2.25) = 5.404 (numpy: 5.403999999999998)
    const c = [-3.5, 0, 2.25, 10, 7];
    expect(percentile(c, 12.5)).toBeCloseTo(-1.75, 12);
    expect(percentile(c, 66.6)).toBeCloseTo(5.404, 10);

    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 100)).toBe(42);
    expect(percentile([], 50)).toBeNull();
  });

  it('sampleSd uses the n−1 denominator; 0 for n=1; null for n=0', () => {
    // [2,4,4,4,5,5,7,9]: mean 5, Σ(x−5)² = 9+1+1+1+0+0+4+16 = 32 -> sqrt(32/7) = 2.138089935299395
    expect(sampleSd([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(Math.sqrt(32 / 7), 12);
    expect(sampleSd([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138089935299395, 12);
    // [1.5,2.5]: Σ = 0.25+0.25 = 0.5 / 1 -> sqrt(0.5)
    expect(sampleSd([1.5, 2.5])).toBeCloseTo(Math.SQRT1_2, 12);
    expect(sampleSd([5])).toBe(0);
    expect(sampleSd([])).toBeNull();
  });

  it('linearTrend matches numpy.polyfit(x, y, 1) and r² = 1 − SSres/SStot', () => {
    // x = 0..5, y = [1.0,2.9,5.2,7.1,8.8,11.3]
    // x̄ = 2.5, ȳ = 36.3/6 = 6.05, Sxx = 17.5,
    // Sxy = 12.625+4.725+0.425+0.525+4.125+13.125 = 35.55
    // slope = 35.55/17.5 = 2.031428571428571, intercept = 6.05 − 2.5·slope = 0.9714285714285709
    // numpy r² = 0.997820873427091
    const pts = [1.0, 2.9, 5.2, 7.1, 8.8, 11.3].map((y, x) => ({ x, y }));
    const r = linearTrend(pts);
    expect(r).not.toBeNull();
    expect(r!.slope).toBeCloseTo(2.031428571428571, 10);
    expect(r!.intercept).toBeCloseTo(0.9714285714285709, 10);
    expect(r!.r2).toBeCloseTo(0.997820873427091, 10);
    expect(r!.n).toBe(6);

    // Unsorted x with negatives: numpy.polyfit -> slope 0.4090909090909092,
    // intercept 0.8863636363636358, r² 0.18035933660933656
    const xs = [3, -1, 4, 10, 2.5];
    const ys = [7, 1, 2, 5, -3];
    const r2 = linearTrend(xs.map((x, i) => ({ x, y: ys[i]! })));
    expect(r2!.slope).toBeCloseTo(0.4090909090909092, 10);
    expect(r2!.intercept).toBeCloseTo(0.8863636363636358, 10);
    expect(r2!.r2).toBeCloseTo(0.18035933660933656, 10);
    expect(r2!.n).toBe(5);
  });

  it('linearTrend null / degenerate rules', () => {
    expect(linearTrend([])).toBeNull();
    expect(linearTrend([{ x: 1, y: 2 }])).toBeNull(); // n < 2
    expect(linearTrend([{ x: 3, y: 1 }, { x: 3, y: 5 }, { x: 3, y: 9 }])).toBeNull(); // var(x) = 0
    // var(y) = 0 -> flat line, r² defined as 0 (not NaN from 0/0)
    const flat = linearTrend([{ x: 0, y: 5 }, { x: 1, y: 5 }, { x: 2, y: 5 }]);
    expect(flat).not.toBeNull();
    expect(flat!.slope).toBeCloseTo(0, 12);
    expect(flat!.intercept).toBeCloseTo(5, 12);
    expect(flat!.r2).toBe(0);
    expect(flat!.n).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// HRV time domain (Task Force ESC/NASPE 1996)
// ---------------------------------------------------------------------------

describe('audit: hrvTimeDomain', () => {
  it('[800, 810, 790, 850, 800]', () => {
    // mean = 4050/5 = 810
    // deviations −10,0,−20,40,−10 -> Σ² = 100+0+400+1600+100 = 2200 -> SDNN = sqrt(2200/4) = sqrt(550) = 23.45207879911715
    // d = [10,−20,60,−50] -> Σd² = 100+400+3600+2500 = 6600 -> RMSSD = sqrt(6600/4) = sqrt(1650) = 40.620192023179804
    // |d| > 50: only 60 (50 is NOT > 50) -> pNN50 = 100·1/4 = 25
    // meanHr = 60000/810 = 74.07407407407408
    expectHrv(hrvTimeDomain([800, 810, 790, 850, 800]), {
      n: 5,
      pairs: 4,
      meanRr: 810,
      sdnn: Math.sqrt(550),
      rmssd: Math.sqrt(1650),
      pnn50: 25,
      meanHr: 60000 / 810,
    });
  });

  // 32 intervals (generated as 800 + 30·((7i) mod 5) − 25·(i mod 3) + 60·[i mod 4 = 0], written out literally)
  const S32 = [
    860, 835, 870, 830, 925, 750, 860, 895, 840, 890, 775, 810, 980, 805, 840, 800,
    895, 870, 830, 865, 810, 860, 895, 780, 950, 775, 810, 920, 865, 840, 800, 835,
  ];
  // Σx = 27165 -> meanRr = 27165/32 = 848.90625
  // Σ(x−x̄)² = 86136.71875 -> SDNN = sqrt(86136.71875/31) = 52.712463712533506
  // d = [−25,35,−40,95,−175,110,35,−55,50,−115,35,170,−175,35,−40,95,−25,−40,35,−55,50,35,−115,170,−175,35,110,−55,−25,−40,35]
  // Σd² = 250525 -> RMSSD = sqrt(250525/31) = 89.89689434515091
  // |d| > 50: 95,175,110,55,115,170,175,95,55,115,170,175,110,55 = 14 (the two 50s excluded) -> pNN50 = 1400/31 = 45.16129032258065
  // meanHr = 60000/848.90625 = 70.6791827719492
  const S32_EXPECTED: HrvTimeDomain = {
    n: 32,
    pairs: 31,
    meanRr: 848.90625,
    sdnn: 52.712463712533506,
    rmssd: 89.89689434515091,
    pnn50: 45.16129032258065,
    meanHr: 70.6791827719492,
  };

  it('32-interval series', () => {
    expect(S32.reduce((a, b) => a + b, 0)).toBe(27165); // sanity on the literal
    expectHrv(hrvTimeDomain(S32), S32_EXPECTED);
  });

  it('null with fewer than 2 intervals; minimal 2-interval case', () => {
    expect(hrvTimeDomain([])).toBeNull();
    expect(hrvTimeDomain([800])).toBeNull();
    // [800,900]: mean 850, SDNN = sqrt((50²+50²)/1) = 70.71067811865476, d=[100] -> RMSSD 100, pNN50 100
    expectHrv(hrvTimeDomain([800, 900]), {
      n: 2,
      pairs: 1,
      meanRr: 850,
      sdnn: Math.sqrt(5000),
      rmssd: 100,
      pnn50: 100,
      meanHr: 60000 / 850,
    });
  });

  it('computeHrv on a clean single-run 32-interval series equals hrvTimeDomain', () => {
    // Every beat in S32 passes rule 2: worst cases are 980 (local median 840 -> 16.7 %)
    // and 750 (local median 860 -> 12.8 %), both ≤ 20 %.
    const { hrv, artifacts } = computeHrv(cumulative(S32));
    expect(artifacts).toEqual({ total: 32, removed: 0, ratio: 0 });
    expectHrv(hrv, S32_EXPECTED);
  });
});

// ---------------------------------------------------------------------------
// cleanRr
// ---------------------------------------------------------------------------

describe('audit: cleanRr', () => {
  it('flags 250 ms, 2500 ms, NaN, a 30 % outlier and a 25 % outlier', () => {
    const ms = [800, 810, 250, 790, 805, 2500, 800, Number.NaN, 1050, 795, 810, 800, 790, 805, 800, 1000];
    const rr = ms.map((m, i) => ({ t: 1_000_000 + i * 1000, ms: m }));
    // Rule 1 (finite and in [300, 2000]): idx 2 (250), 5 (2500), 7 (NaN) fail.
    // Rule 2, window 11 -> ±5, excluding self and rule-1 failures:
    //  idx 0  : nbrs 1..5 valid = {810,790,805}            -> median 805, |800−805|/805 = 0.6 %
    //  idx 8  : nbrs 3..13 valid = {790,805,800,795,810,800,790,805}
    //           sorted 790,790,795,800,800,805,805,810    -> median 800, |1050−800|/800 = 31.25 % > 20 % -> invalid
    //  idx 15 : nbrs 10..14 = {810,800,790,805,800}        -> median 800, |1000−800|/800 = 25 % > 20 % -> invalid
    //  (idx 9's window contains the 1050, which passed rule 1 and therefore counts: {790,805,800,1050,810,800,790,805}
    //   -> median 802.5, 795 is 0.9 % away -> valid)
    // removed = 5 of 16 -> ratio 0.3125
    const { valid, report } = cleanRr(rr);
    expect(valid).toEqual([
      true, true, false, true, true, false, true, false, false, true, true, true, true, true, true, false,
    ]);
    expect(report).toEqual({ total: 16, removed: 5, ratio: 5 / 16 });
  });

  it('skips rule 2 when fewer than 3 valid neighbours exist', () => {
    // [800, 2500, 3000, 1500]: 2500 and 3000 fail rule 1.
    // idx 0: neighbours 1..3 -> only {1500} valid (1 < 3) -> rule 2 skipped -> valid
    // idx 3: neighbours 0..2 -> only {800}  valid (1 < 3) -> rule 2 skipped -> valid (even though 1500 is +87 %)
    const rr = [800, 2500, 3000, 1500].map((m, i) => ({ t: i * 1000, ms: m }));
    const { valid, report } = cleanRr(rr);
    expect(valid).toEqual([true, false, false, true]);
    expect(report).toEqual({ total: 4, removed: 2, ratio: 0.5 });
  });

  it('applies rule 2 with exactly 3 valid neighbours', () => {
    // [800,800,800,1500]: idx 3 neighbours {800,800,800} -> median 800 -> 87.5 % -> invalid
    // idx 0 neighbours {800,800,1500} -> median 800 -> 0 % -> valid
    const rr = [800, 800, 800, 1500].map((m, i) => ({ t: i * 1000, ms: m }));
    const { valid, report } = cleanRr(rr);
    expect(valid).toEqual([true, true, true, false]);
    expect(report).toEqual({ total: 4, removed: 1, ratio: 0.25 });
  });

  it('deviation exactly at maxDeviation is kept (strict >), just above is removed', () => {
    // median of the others = 1000; 1200 -> |200|/1000 = 0.2 (not > 0.2) -> valid
    const at = [1000, 1000, 1000, 1000, 1200, 1000, 1000, 1000, 1000].map((m, i) => ({ t: i * 1000, ms: m }));
    expect(cleanRr(at).valid.every(Boolean)).toBe(true);
    // 1201 -> 0.201 > 0.2 -> invalid
    const above = [1000, 1000, 1000, 1000, 1201, 1000, 1000, 1000, 1000].map((m, i) => ({ t: i * 1000, ms: m }));
    expect(cleanRr(above).valid).toEqual([true, true, true, true, false, true, true, true, true]);
    expect(cleanRr(above).report).toEqual({ total: 9, removed: 1, ratio: 1 / 9 });
  });

  it('range bounds are inclusive and options are honoured', () => {
    // 300 and 2000 are inside [minMs, maxMs]; with fewer than 3 neighbours rule 2 is skipped.
    const rr = [300, 2000].map((m, i) => ({ t: i * 1000, ms: m }));
    expect(cleanRr(rr).valid).toEqual([true, true]);
    expect(cleanRr(rr, { minMs: 301, maxMs: 1999 }).valid).toEqual([false, false]);
    // Infinity is not finite
    expect(cleanRr([{ t: 0, ms: Number.POSITIVE_INFINITY }]).valid).toEqual([false]);
  });

  it('empty input -> ratio 0, not NaN', () => {
    expect(cleanRr([])).toEqual({ valid: [], report: { total: 0, removed: 0, ratio: 0 } });
  });

  it('window and maxDeviation options', () => {
    const rr = [800, 800, 800, 800, 800, 1500, 800, 800, 800, 800, 800].map((m, i) => ({ t: i * 1000, ms: m }));
    // default window 11: idx 5 has 10 neighbours, median 800 -> 87.5 % -> invalid
    expect(cleanRr(rr).valid[5]).toBe(false);
    // window 3 -> ±1 -> at most 2 neighbours < 3 -> rule 2 always skipped -> all valid
    expect(cleanRr(rr, { window: 3 }).valid.every(Boolean)).toBe(true);
    // window 7 -> ±3 -> 6 neighbours -> rule 2 applies again
    expect(cleanRr(rr, { window: 7 }).valid[5]).toBe(false);
    // maxDeviation 1.0: 0.875 ≤ 1 -> kept
    expect(cleanRr(rr, { maxDeviation: 1 }).valid.every(Boolean)).toBe(true);
    // maxDeviation 0.05 on a 5 % / 6 % pair: neighbours all 1000 -> 1050 (5 %) kept, 1060 (6 %) removed
    const tight = [1000, 1000, 1000, 1050, 1000, 1000, 1060, 1000, 1000].map((m, i) => ({ t: i * 1000, ms: m }));
    expect(cleanRr(tight, { maxDeviation: 0.05 }).valid).toEqual([true, true, true, true, true, true, false, true, true]);
  });

  it('all-artefact series: ratio 1 and computeHrv returns null hrv (no NaN)', () => {
    const rr = [Number.NaN, 100, 5000, Number.NEGATIVE_INFINITY].map((m, i) => ({ t: i * 1000, ms: m }));
    expect(cleanRr(rr).report).toEqual({ total: 4, removed: 4, ratio: 1 });
    const r = computeHrv(rr, { minIntervals: 0 });
    expect(r.hrv).toBeNull();
    expect(r.artifacts).toEqual({ total: 4, removed: 4, ratio: 1 });
  });
});

// ---------------------------------------------------------------------------
// computeHrv (robust pipeline)
// ---------------------------------------------------------------------------

describe('audit: computeHrv', () => {
  // Run 1: 20 beats alternating 800/840; run 2: 20 beats alternating 900/940.
  const G = [...alt(20, 800, 840), ...alt(20, 900, 940)];
  // Pooled: 10×800, 10×840, 10×900, 10×940 -> mean 34800/40 = 870
  // deviations ±30, ±70 -> Σ² = 10·(4900+900+900+4900) = 116000 -> SDNN = sqrt(116000/39) = 54.53768398418633
  const POOLED_SDNN = Math.sqrt(116000 / 39);

  it('splits runs when Δt > gapMs + ms, so the cross-gap pair is not used', () => {
    // t20 − t19 = ms20 + 3001 = 3901 > 3000 + 900 -> new run.
    // Pairs: 19 in run 1 (|d| = 40) + 19 in run 2 (|d| = 40) = 38 -> RMSSD = 40, pNN50 = 0.
    // (If the 840 -> 900 pair (|d| = 60) were included: 39 pairs, RMSSD = sqrt(64400/39) = 40.636, pNN50 = 2.564.)
    const { hrv, artifacts } = computeHrv(cumulative(G, 1_000_000, { 20: 3001 }));
    expect(artifacts).toEqual({ total: 40, removed: 0, ratio: 0 });
    expectHrv(hrv, {
      n: 40,
      pairs: 38,
      meanRr: 870,
      sdnn: POOLED_SDNN,
      rmssd: 40,
      pnn50: 0,
      meanHr: 60000 / 870,
    });
  });

  it('Δt exactly equal to gapMs + ms does NOT split (strict >)', () => {
    // t20 − t19 = 900 + 3000 = 3900 = gapMs + ms -> same run -> 39 pairs:
    // RMSSD = sqrt((38·40² + 60²)/39) = sqrt(64400/39) = 40.6359699192975; pNN50 = 100·1/39 = 2.5641025641025643
    const { hrv } = computeHrv(cumulative(G, 1_000_000, { 20: 3000 }));
    expectHrv(hrv, {
      n: 40,
      pairs: 39,
      meanRr: 870,
      sdnn: POOLED_SDNN,
      rmssd: Math.sqrt(64400 / 39),
      pnn50: 100 / 39,
      meanHr: 60000 / 870,
    });
  });

  it('gapMs option is honoured', () => {
    // Δt = 900 + 3001; with gapMs 5000 the threshold is 5900 -> no split -> 39 pairs.
    const { hrv } = computeHrv(cumulative(G, 1_000_000, { 20: 3001 }), { gapMs: 5000 });
    expect(hrv!.pairs).toBe(39);
  });

  it('an invalid beat breaks a pair instead of joining its neighbours', () => {
    // 35 beats alternating 800/840, beat 10 replaced by 2500 (fails rule 1).
    // valid = 34 -> n 34; pairs = 34 − (9,10) − (10,11) = 32, all |d| = 40 -> RMSSD 40, pNN50 0.
    // (Joining 9 -> 11 would add a d = 840 − 840 = 0 pair: RMSSD sqrt(32·1600/33) = 39.389.)
    // Pooled: 17×800 + 17×840 -> mean 820, Σ² = 34·20² = 13600 -> SDNN = sqrt(13600/33) = 20.30076875690209
    const ms = alt(35);
    ms[10] = 2500;
    const { hrv, artifacts } = computeHrv(cumulative(ms));
    expect(artifacts).toEqual({ total: 35, removed: 1, ratio: 1 / 35 });
    expectHrv(hrv, {
      n: 34,
      pairs: 32,
      meanRr: 820,
      sdnn: Math.sqrt(13600 / 33),
      rmssd: 40,
      pnn50: 0,
      meanHr: 60000 / 820,
    });
  });

  it('minIntervals null rule (default 30)', () => {
    // 29 valid intervals < 30 -> hrv null, but the artefact report is still produced.
    const rr = cumulative(alt(29));
    const r = computeHrv(rr);
    expect(r.hrv).toBeNull();
    expect(r.artifacts).toEqual({ total: 29, removed: 0, ratio: 0 });
    // minIntervals 29: 15×800 + 14×840 = 23760 -> mean 819.3103448275862, 28 pairs of |40| -> RMSSD 40
    const ok = computeHrv(rr, { minIntervals: 29 });
    expect(ok.hrv).not.toBeNull();
    expect(ok.hrv!.n).toBe(29);
    expect(ok.hrv!.pairs).toBe(28);
    expect(ok.hrv!.meanRr).toBeCloseTo(23760 / 29, 9);
    expect(ok.hrv!.rmssd).toBeCloseTo(40, 9);
    // exactly 30 valid -> not null with defaults
    expect(computeHrv(cumulative(alt(30))).hrv).not.toBeNull();
  });

  it('null when there are 0 valid pairs even if minIntervals is met', () => {
    // three beats, each separated by 10 s (> 3000 + ms) -> three runs of one beat -> 0 pairs
    const rr: RRInterval[] = [
      { t: 1_000_000, ms: 800 },
      { t: 1_010_000, ms: 810 },
      { t: 1_020_000, ms: 820 },
    ];
    const r = computeHrv(rr, { minIntervals: 2 });
    expect(r.hrv).toBeNull();
    expect(r.artifacts).toEqual({ total: 3, removed: 0, ratio: 0 });
  });

  it('artefact report counts every flagged interval', () => {
    // 40 alternating beats with 4 artefacts: 250 (rule 1), NaN (rule 1), 2600 (rule 1), 1300 (rule 2: vs ~820 -> 58 %)
    const ms = alt(40);
    ms[5] = 250;
    ms[12] = Number.NaN;
    ms[20] = 2600;
    ms[30] = 1300;
    const { hrv, artifacts } = computeHrv(cumulative(ms));
    expect(artifacts.total).toBe(40);
    expect(artifacts.removed).toBe(4);
    expect(artifacts.ratio).toBeCloseTo(0.1, 12);
    // replaced beats: idx 5 (odd, was 840), idx 12/20/30 (even, were 800)
    // valid: 800s = 20 − 3 = 17, 840s = 20 − 1 = 19 -> n 36, mean = (13600 + 15960)/36 = 821.111…
    // pairs: 39 total, each artefact kills 2 (none adjacent) -> 39 − 8 = 31
    expect(hrv!.n).toBe(36);
    expect(hrv!.pairs).toBe(31);
    expect(hrv!.meanRr).toBeCloseTo((17 * 800 + 19 * 840) / 36, 9);
    expect(hrv!.rmssd).toBeCloseTo(40, 9);
  });
});

// ---------------------------------------------------------------------------
// Baevsky stress index
// ---------------------------------------------------------------------------

describe('audit: baevskyStressIndex', () => {
  it('crafted 40-interval histogram', () => {
    // bins of 50 ms: [floor(x/50)·50, +50)
    //  [700,750): 700, 749.9                            -> 2
    //  [750,800): 750, 760, 775, 790, 799.99            -> 5
    //  [800,850): 800, 802, …, 838 (step 2)             -> 20   <- modal bin
    //  [850,900): 850, 855, …, 890, 899                 -> 10   (850 lands in 850 bin)
    //  [900,950): 900, 949                              -> 2
    //  [1000,1050): 1000                                -> 1
    // n = 40. Mo = centre 825 ms = 0.825 s. AMo = 20/40·100 = 50 %.
    // MxDMn = (1000 − 700) ms = 0.3 s. SI = 50 / (2·0.825·0.3) = 50/0.495 = 101.01010101010102
    const xs = [
      700, 749.9,
      750, 760, 775, 790, 799.99,
      ...Array.from({ length: 20 }, (_, i) => 800 + 2 * i),
      850, 855, 860, 865, 870, 875, 880, 885, 890, 899,
      900, 949, 1000,
    ];
    expect(xs).toHaveLength(40);
    expect(baevskyStressIndex(xs)).toBeCloseTo(50 / (2 * 0.825 * 0.3), 9);
    expect(baevskyStressIndex(xs)).toBeCloseTo(101.01010101010102, 9);

    // binMs = 100: [700,800) 7, [800,900) 30, [900,1000) 2, [1000,1100) 1
    // Mo = 0.85 s, AMo = 75 %, SI = 75 / (2·0.85·0.3) = 147.05882352941177
    expect(baevskyStressIndex(xs, 100)).toBeCloseTo(147.05882352941177, 9);
  });

  it('ties go to the lowest bin', () => {
    // 15×810 (bin 800) and 15×910 (bin 900): tie -> lowest -> Mo = 0.825 s, AMo = 50 %, MxDMn = 0.1 s
    // SI = 50 / (2·0.825·0.1) = 303.030303030303   (highest bin would give 50/(2·0.925·0.1) = 270.27)
    const xs = [...Array<number>(15).fill(810), ...Array<number>(15).fill(910)];
    expect(baevskyStressIndex(xs)).toBeCloseTo(303.030303030303, 9);
    // order of the input must not matter
    expect(baevskyStressIndex([...xs].reverse())).toBeCloseTo(303.030303030303, 9);
  });

  it('null rules: n < 30, MxDMn = 0', () => {
    expect(baevskyStressIndex(Array.from({ length: 29 }, (_, i) => 800 + i))).toBeNull();
    expect(baevskyStressIndex(Array<number>(30).fill(800))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// zones (Tanaka 2001)
// ---------------------------------------------------------------------------

describe('audit: zones', () => {
  it('estimateMaxHr uses Tanaka 208 − 0.7·age, rounded', () => {
    expect(estimateMaxHr(1980, 2026)).toBe(176); // age 46: 208 − 32.2 = 175.8 -> 176
    expect(estimateMaxHr(1992, 2026)).toBe(184); // age 34: 208 − 23.8 = 184.2 -> 184
    expect(estimateMaxHr(1986, 2026)).toBe(180); // age 40: 208 − 28   = 180
    expect(estimateMaxHr(1993, 2026)).toBe(185); // age 33: 208 − 23.1 = 184.9 -> 185
  });

  it('zonesFromMaxHr bounds are maxHr·pct, unrounded', () => {
    // 185: 60 % 111, 70 % 129.5, 80 % 148, 90 % 166.5
    const z = zonesFromMaxHr(185);
    expect(z.map((x) => x.id)).toEqual(['z1', 'z2', 'z3', 'z4', 'z5']);
    expect(z.map((x) => x.label)).toEqual(['Very light', 'Light', 'Moderate', 'Hard', 'Maximum']);
    expect(z[0]!.minBpm).toBe(0);
    const bounds = [111, 129.5, 148, 166.5];
    for (let i = 0; i < 4; i++) {
      expect(z[i]!.maxBpm).toBeCloseTo(bounds[i]!, 9);
      expect(z[i + 1]!.minBpm).toBeCloseTo(bounds[i]!, 9);
    }
    expect(z[4]!.maxBpm).toBe(Number.POSITIVE_INFINITY);
  });

  it('zonesFromBaseline', () => {
    expect(zonesFromBaseline(60)).toEqual([
      { id: 'rest', label: 'At rest', minBpm: 0, maxBpm: 70 },
      { id: 'elevated', label: 'Elevated', minBpm: 70, maxBpm: 80 },
      { id: 'high', label: 'High', minBpm: 80, maxBpm: 90 },
      { id: 'very-high', label: 'Very high', minBpm: 90, maxBpm: Number.POSITIVE_INFINITY },
    ]);
  });

  it('timeInZones dwell: capped gaps, last sample = median of other dwells, invalid bpm skipped', () => {
    // zones for maxHr 180: z1 [0,108) z2 [108,126) z3 [126,144) z4 [144,162) z5 [162,∞)
    const zones = zonesFromMaxHr(180);
    const samples: HeartRateSample[] = [
      { t: 0, bpm: 100 }, //       z1, dwell 1000
      { t: 1000, bpm: 108 }, //    z2 (lower bound inclusive), dwell 1000
      { t: 2000, bpm: 130 }, //    z3, dwell to next VALID sample: 6000 − 2000 = 4000
      { t: 5000, bpm: Number.NaN }, // invalid -> ignored
      { t: 6000, bpm: 170 }, //    z5, dwell min(14000, 5000) = 5000
      { t: 20000, bpm: 150 }, //   z4, last: min(median{1000,1000,4000,5000} = 2500, 5000) = 2500
    ];
    // seconds: z1 1, z2 1, z3 4, z4 2.5, z5 5 -> Σ 13.5
    const r = timeInZones(samples, zones);
    expect(r.map((x) => x.id)).toEqual(['z1', 'z2', 'z3', 'z4', 'z5']);
    const secs = [1, 1, 4, 2.5, 5];
    r.forEach((z, i) => {
      expect(z.seconds).toBeCloseTo(secs[i]!, 9);
      expect(z.fraction).toBeCloseTo(secs[i]! / 13.5, 9);
    });
    expect(r.reduce((a, z) => a + z.fraction, 0)).toBeCloseTo(1, 12);
  });

  it('timeInZones: last-sample dwell is capped by maxGapMs; zero-time zones included', () => {
    // all gaps 8000 ms, maxGapMs 5000 -> dwells 5000,5000,5000 and last min(5000, 5000) = 5000
    const zones = zonesFromMaxHr(200); // z1 [0,120)
    const samples: HeartRateSample[] = [0, 8000, 16000, 24000].map((t) => ({ t, bpm: 100 }));
    const r = timeInZones(samples, zones);
    expect(r[0]!.seconds).toBeCloseTo(20, 9);
    expect(r[0]!.fraction).toBeCloseTo(1, 12);
    expect(r.slice(1).every((z) => z.seconds === 0 && z.fraction === 0)).toBe(true);
    // custom maxGapMs 3000 -> 4 × 3000 = 12 s
    expect(timeInZones(samples, zones, 3000)[0]!.seconds).toBeCloseTo(12, 9);
  });

  it('timeInZones: single sample has 0 dwell; fractions 0 (not NaN)', () => {
    const r = timeInZones([{ t: 0, bpm: 100 }], zonesFromMaxHr(180));
    expect(r).toHaveLength(5);
    for (const z of r) {
      expect(z.seconds).toBe(0);
      expect(z.fraction).toBe(0);
    }
    expect(timeInZones([], zonesFromMaxHr(180)).every((z) => z.seconds === 0 && z.fraction === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// phases
// ---------------------------------------------------------------------------

describe('audit: phases', () => {
  const S = 1_700_000_000_000;
  const E = S + 600_000;

  it('sessionEnd fallbacks', () => {
    expect(sessionEnd(mkSession({ startedAt: S, endedAt: E }))).toBe(E);
    const open = mkSession({
      startedAt: S,
      samples: [{ t: S + 1000, bpm: 70 }, { t: S + 300_000, bpm: 70 }],
      rr: [{ t: S + 310_000, ms: 800 }],
      events: [{ id: 'm', t: S + 200_000, type: 'marker', marker: 'note' }],
    });
    expect(sessionEnd(open)).toBe(S + 310_000);
    expect(sessionEnd(mkSession({ startedAt: S }))).toBe(S);
  });

  it('derivePhases: clamping, duplicates, same-t events, zero-length final segment', () => {
    const events: SessionEvent[] = [
      { id: 'p_close', t: E + 50_000, type: 'phase', phase: 'closure' }, // after end -> clamped to E
      { id: 'p_pre1', t: S - 60_000, type: 'phase', phase: 'pre-op' }, //  before start -> clamped to S
      { id: 'm1', t: S + 200_000, type: 'marker', marker: 'complication' }, // not a phase event
      { id: 'p_inc', t: S + 100_000, type: 'phase', phase: 'incision' }, //  same t as dissection, first in stable order
      { id: 'p_dis', t: S + 100_000, type: 'phase', phase: 'dissection' },
      { id: 'p_pre2', t: S + 30_000, type: 'phase', phase: 'pre-op' }, //  consecutive duplicate -> keep first
      { id: 'p_crit', t: S + 400_000, type: 'phase', phase: 'critical' },
    ];
    // sorted (stable): pre1(S), pre2, inc(S+100k), dis(S+100k), crit(S+400k), close(E)
    // pre-op  [S, S+100k)         kept
    // incision[S+100k, S+100k)    zero length -> dropped
    // dissection [S+100k, S+400k) kept
    // critical [S+400k, E)        kept
    // closure [E, E]              zero length but final and ends at sessionEnd -> kept
    const segs = derivePhases(mkSession({ startedAt: S, endedAt: E, events }));
    expect(segs).toEqual([
      { phase: 'pre-op', index: 0, start: S, end: S + 100_000 },
      { phase: 'dissection', index: 1, start: S + 100_000, end: S + 400_000 },
      { phase: 'critical', index: 2, start: S + 400_000, end: E },
      { phase: 'closure', index: 3, start: E, end: E },
    ]);
    // input not mutated
    expect(events[0]!.id).toBe('p_close');
  });

  it('derivePhases: time before the first phase event is not a segment; open session uses sessionEnd', () => {
    const s = mkSession({
      startedAt: S,
      samples: [{ t: S + 300_000, bpm: 80 }],
      rr: [{ t: S + 310_000, ms: 800 }],
      events: [
        { id: 'a', t: S + 50_000, type: 'phase', phase: 'incision' },
        { id: 'b', t: S + 200_000, type: 'phase', phase: 'critical' },
      ],
    });
    expect(derivePhases(s)).toEqual([
      { phase: 'incision', index: 0, start: S + 50_000, end: S + 200_000 },
      { phase: 'critical', index: 1, start: S + 200_000, end: S + 310_000 },
    ]);
    expect(derivePhases(mkSession({ startedAt: S, endedAt: E }))).toEqual([]);
  });

  it('derivePhases: two events clamped onto the end — only the final zero-length one survives', () => {
    const s = mkSession({
      startedAt: S,
      endedAt: E,
      events: [
        { id: 'a', t: S, type: 'phase', phase: 'pre-op' },
        { id: 'b', t: E + 1, type: 'phase', phase: 'critical' },
        { id: 'c', t: E + 2, type: 'phase', phase: 'closure' },
      ],
    });
    // pre-op [S,E); critical [E,E) not final -> dropped; closure [E,E] final -> kept
    expect(derivePhases(s)).toEqual([
      { phase: 'pre-op', index: 0, start: S, end: E },
      { phase: 'closure', index: 1, start: E, end: E },
    ]);
  });

  it('phaseAt boundaries: start ≤ t < end, and t == last end -> last phase', () => {
    const segs: PhaseSegment[] = [
      { phase: 'pre-op', index: 0, start: 0, end: 100 },
      { phase: 'incision', index: 1, start: 100, end: 200 },
    ];
    expect(phaseAt(segs, -1)).toBeUndefined();
    expect(phaseAt(segs, 0)).toBe('pre-op');
    expect(phaseAt(segs, 99)).toBe('pre-op');
    expect(phaseAt(segs, 100)).toBe('incision');
    expect(phaseAt(segs, 199)).toBe('incision');
    expect(phaseAt(segs, 200)).toBe('incision');
    expect(phaseAt(segs, 201)).toBeUndefined();
    expect(phaseAt([], 0)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// stress episodes
// ---------------------------------------------------------------------------

describe('audit: detectStressEpisodes', () => {
  const T0 = 1_700_000_000_000;
  const at = (k: number, bpm: number): HeartRateSample => ({ t: T0 + k * 1000, bpm });

  // 1 Hz samples, k = seconds after T0
  const samples: HeartRateSample[] = [];
  for (let k = -10; k <= -1; k++) samples.push(at(k, 90));
  // run A: k 0..40, 105 + (k mod 5), with a 130 peak at k=20.  Σ = 8·535 + 105 + 25 = 4410 (41 samples)
  for (let k = 0; k <= 40; k++) samples.push(at(k, k === 20 ? 130 : 105 + (k % 5)));
  for (let k = 41; k <= 69; k++) samples.push(at(k, 90));
  // run B: k 70..100, 110 + (k mod 3), with another 130 at k=80.  Σ = 31·110 + 31 + 18 = 3459 (31 samples)
  for (let k = 70; k <= 100; k++) samples.push(at(k, k === 80 ? 130 : 110 + (k % 3)));
  for (let k = 101; k <= 199; k++) samples.push(at(k, 85));
  // run C: k 200..230 -> 30 s < 60 s, isolated -> dropped
  for (let k = 200; k <= 230; k++) samples.push(at(k, 120));
  for (let k = 231; k <= 299; k++) samples.push(at(k, 85));
  // run D: k 300..360 at exactly the threshold (≥) -> exactly 60 s -> kept
  for (let k = 300; k <= 360; k++) samples.push(at(k, 100));
  for (let k = 361; k <= 400; k++) samples.push(at(k, 70));

  const segments: PhaseSegment[] = [
    { phase: 'dissection', index: 0, start: T0 - 60_000, end: T0 + 10_000 },
    { phase: 'critical', index: 1, start: T0 + 10_000, end: T0 + 300_000 },
    { phase: 'closure', index: 2, start: T0 + 300_000, end: T0 + 400_000 },
  ];
  const events: SessionEvent[] = [
    { id: 'e1', t: T0 - 120_001, type: 'marker', marker: 'note' }, //        1 ms too early for ep1
    { id: 'e2', t: T0 - 120_000, type: 'marker', marker: 'interruption' }, // = start − 120 s -> ep1
    { id: 'e3', t: T0 + 10_000, type: 'phase', phase: 'critical' }, //       inside ep1
    { id: 'e4', t: T0 + 100_000, type: 'marker', marker: 'complication' }, // = ep1 end -> ep1
    { id: 'e5', t: T0 + 100_001, type: 'marker', marker: 'equipment' }, //    after ep1 end, before ep2 window
    { id: 'e6', t: T0 + 180_000, type: 'marker', marker: 'teaching' }, //     = ep2 start − 120 s -> ep2
    { id: 'e7', t: T0 + 360_000, type: 'marker', marker: 'takeover' }, //     = ep2 end -> ep2
    { id: 'e8', t: T0 + 360_001, type: 'marker', marker: 'note' }, //         after ep2
  ];

  it('merge (gap exactly mergeGapMs), min duration, peak first occurrence, phase and related events', () => {
    // A ends T0+40 s, B starts T0+70 s: separation 30 000 ms ≤ 30 000 -> merged -> [T0, T0+100 s], 100 s
    // peak 130 occurs at k=20 and k=80 -> first wins -> peakT = T0+20 s -> phaseAt -> 'critical'
    // meanBpm over the 72 above-threshold samples only (the 90 bpm samples between A and B excluded):
    //   (4410 + 3459)/72 = 7869/72 = 109.29166666666667
    // D: [T0+300 s, T0+360 s] = 60 s ≥ 60 s; peak 100 first at T0+300 s -> 'closure' (segment start inclusive)
    const eps = detectStressEpisodes(samples, { thresholdBpm: 100 }, { segments, events });
    expect(eps).toHaveLength(2);
    const [ep1, ep2] = eps;
    expect(ep1!.start).toBe(T0);
    expect(ep1!.end).toBe(T0 + 100_000);
    expect(ep1!.durationSec).toBe(100);
    expect(ep1!.peakBpm).toBe(130);
    expect(ep1!.peakT).toBe(T0 + 20_000);
    expect(ep1!.meanBpm).toBeCloseTo(7869 / 72, 9);
    expect(ep1!.phase).toBe('critical');
    expect(ep1!.relatedEventIds).toEqual(['e2', 'e3', 'e4']);

    expect(ep2!.start).toBe(T0 + 300_000);
    expect(ep2!.end).toBe(T0 + 360_000);
    expect(ep2!.durationSec).toBe(60);
    expect(ep2!.peakBpm).toBe(100);
    expect(ep2!.peakT).toBe(T0 + 300_000);
    expect(ep2!.meanBpm).toBeCloseTo(100, 9);
    expect(ep2!.phase).toBe('closure');
    expect(ep2!.relatedEventIds).toEqual(['e6', 'e7']);
  });

  it('separation of mergeGapMs + 1 does not merge', () => {
    // mergeGapMs 29 999 < 30 000 -> A (40 s) and B (30 s) stay separate, both < 60 s -> dropped.
    const eps = detectStressEpisodes(samples, { thresholdBpm: 100, mergeGapMs: 29_999 });
    expect(eps.map((e) => [e.start - T0, e.end - T0])).toEqual([[300_000, 360_000]]);
  });

  it('related events are reported in time order even if the input is not sorted', () => {
    const eps = detectStressEpisodes(samples, { thresholdBpm: 100 }, { segments, events: [...events].reverse() });
    expect(eps[0]!.relatedEventIds).toEqual(['e2', 'e3', 'e4']);
    expect(eps[1]!.relatedEventIds).toEqual(['e6', 'e7']);
  });

  it('without context there is no phase and no related events', () => {
    const eps = detectStressEpisodes(samples, { thresholdBpm: 100 });
    expect(eps).toHaveLength(2);
    expect(eps[0]!.phase).toBeUndefined();
    expect(eps[0]!.relatedEventIds).toEqual([]);
  });

  it('a data gap > 5000 ms breaks a run; exactly 5000 ms does not', () => {
    // above-threshold samples k = 0..40, then (gap) k = 46..100 -> gap 6000 ms > 5000 -> two runs
    // [0,40 s] (40 s) and [46,100 s] (54 s). With mergeGapMs 5000 they are not merged (6000 > 5000)
    // and both are < 60 s -> no episodes. Without the gap rule this would be one 100 s episode.
    const gapped: HeartRateSample[] = [];
    for (let k = 0; k <= 40; k++) gapped.push(at(k, 120));
    for (let k = 46; k <= 100; k++) gapped.push(at(k, 120));
    expect(detectStressEpisodes(gapped, { thresholdBpm: 100, mergeGapMs: 5000 })).toEqual([]);
    // default mergeGapMs (30 s) re-joins them
    const merged = detectStressEpisodes(gapped, { thresholdBpm: 100 });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.start).toBe(T0);
    expect(merged[0]!.end).toBe(T0 + 100_000);

    // gap of exactly 5000 ms: k = 0..40 then 45..100 -> single run even with mergeGapMs 0
    const edge: HeartRateSample[] = [];
    for (let k = 0; k <= 40; k++) edge.push(at(k, 120));
    for (let k = 45; k <= 100; k++) edge.push(at(k, 120));
    const one = detectStressEpisodes(edge, { thresholdBpm: 100, mergeGapMs: 0 });
    expect(one).toHaveLength(1);
    expect(one[0]!.durationSec).toBe(100);
  });

  it('minDurationMs option', () => {
    // run C (30 s) survives with minDurationMs 30 000; A+B and D also survive
    const eps = detectStressEpisodes(samples, { thresholdBpm: 100, minDurationMs: 30_000 });
    expect(eps.map((e) => e.durationSec)).toEqual([100, 30, 60]);
  });

  it('defaultEpisodeThreshold', () => {
    const baseline: Baseline = { startedAt: 0, endedAt: 1, restingHr: 70, source: 'measured' };
    const hr: HrStats = { count: 10, mean: 82, median: 80, min: 70, max: 95, sd: 5, p95: 92 };
    expect(defaultEpisodeThreshold(baseline, hr)).toBe(90); // 70 + 20
    expect(defaultEpisodeThreshold(baseline, null)).toBe(90);
    expect(defaultEpisodeThreshold(null, hr)).toBe(95); // 80 + 15
    expect(defaultEpisodeThreshold(undefined, hr)).toBe(95);
    expect(defaultEpisodeThreshold(null, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SURG-TLX / NASA-TLX (Wilson et al. 2011; Hart & Staveland 1988)
// ---------------------------------------------------------------------------

describe('audit: workload instruments', () => {
  const ratings = { mental: 80, physical: 30, temporal: 60, complexity: 70, stress: 90, distraction: 20 };

  it('raw and weighted SURG-TLX', () => {
    // raw = (80+30+60+70+90+20)/6 = 350/6 = 58.333…
    // weights 5,1,3,4,2,0 (Σ 15): weighted = (400+30+180+280+180+0)/15 = 1070/15 = 71.333…
    const resp: SurgTlxResponse = {
      instrument: 'surg-tlx',
      ratings,
      weights: { mental: 5, physical: 1, temporal: 3, complexity: 4, stress: 2, distraction: 0 },
      completedAt: 0,
    };
    const s = scoreWorkload(resp);
    expect(s.instrument).toBe('surg-tlx');
    expect(s.raw).toBeCloseTo(350 / 6, 10);
    expect(s.weighted).not.toBeNull();
    expect(s.weighted!).toBeCloseTo(1070 / 15, 10);
    expect(s.dimensions).toEqual(ratings);
  });

  it('clamps ratings to [0, 100]; no weights -> weighted null', () => {
    // clamped: 100, 0, 50, 50, 50, 50 -> raw = 300/6 = 50
    const s = scoreWorkload({
      instrument: 'surg-tlx',
      ratings: { mental: 120, physical: -10, temporal: 50, complexity: 50, stress: 50, distraction: 50 },
      completedAt: 0,
    });
    expect(s.raw).toBeCloseTo(50, 12);
    expect(s.weighted).toBeNull();
    expect(s.dimensions).toEqual({ mental: 100, physical: 0, temporal: 50, complexity: 50, stress: 50, distraction: 50 });
  });

  it('invalid weights -> weighted null', () => {
    const w = (mental: number, physical: number, temporal: number, complexity: number, stress: number, distraction: number) =>
      scoreWorkload({
        instrument: 'surg-tlx',
        ratings,
        weights: { mental, physical, temporal, complexity, stress, distraction },
        completedAt: 0,
      }).weighted;
    expect(w(5, 1, 3, 4, 1, 0)).toBeNull(); //       Σ 14
    expect(w(5, 1, 3, 4, 2, 1)).toBeNull(); //       Σ 16
    expect(w(2.5, 2.5, 3, 3, 2, 2)).toBeNull(); //   Σ 15 but non-integer
    expect(w(6, 0, 0, 4, 5, 0)).toBeNull(); //       Σ 15 but 6 > 5
    expect(w(-1, 5, 5, 5, 1, 0)).toBeNull(); //      Σ 15 but negative
    expect(w(5, 4, 3, 2, 1, 0)).toBeCloseTo((400 + 120 + 180 + 140 + 90 + 0) / 15, 10); // valid control: 930/15 = 62
  });

  it('NASA-TLX', () => {
    // raw = (40+20+60+30+50+10)/6 = 210/6 = 35
    // weights 4,0,3,2,5,1: (160+0+180+60+250+10)/15 = 660/15 = 44
    const resp: NasaTlxResponse = {
      instrument: 'nasa-tlx',
      ratings: { mental: 40, physical: 20, temporal: 60, performance: 30, effort: 50, frustration: 10 },
      weights: { mental: 4, physical: 0, temporal: 3, performance: 2, effort: 5, frustration: 1 },
      completedAt: 0,
    };
    const s = scoreWorkload(resp);
    expect(s.instrument).toBe('nasa-tlx');
    expect(s.raw).toBeCloseTo(35, 12);
    expect(s.weighted!).toBeCloseTo(44, 12);
  });

  it('tlxPairs has the 15 unique unordered pairs of the 6 dimensions (C(6,2) = 15)', () => {
    for (const [instrument, dims] of [
      ['surg-tlx', SURG_TLX_DIMENSIONS.map((d) => d.id as string)],
      ['nasa-tlx', NASA_TLX_DIMENSIONS.map((d) => d.id as string)],
    ] as const) {
      const pairs = tlxPairs(instrument);
      expect(pairs).toHaveLength(15);
      const keys = new Set(pairs.map(([a, b]) => [a, b].sort().join('|')));
      expect(keys.size).toBe(15);
      for (const [a, b] of pairs) {
        expect(a).not.toBe(b);
        expect(dims).toContain(a);
        expect(dims).toContain(b);
      }
      // each dimension appears in exactly 5 pairs
      for (const d of dims) expect(pairs.filter(([a, b]) => a === d || b === d)).toHaveLength(5);
      // fixed order: same result every call
      expect(tlxPairs(instrument)).toEqual(pairs);
    }
    expect(SURG_TLX_DIMENSIONS.map((d) => d.id)).toEqual([
      'mental', 'physical', 'temporal', 'complexity', 'stress', 'distraction',
    ]);
  });
});

// ---------------------------------------------------------------------------
// BLE Heart Rate Measurement (0x2A37) and base64
// ---------------------------------------------------------------------------

describe('audit: parseHeartRateMeasurement', () => {
  it('uint8 HR, no contact support, no extras', () => {
    // flags 0x00, HR 72
    const m = parseHeartRateMeasurement([0x00, 72]);
    expect(m.bpm).toBe(72);
    expect(m.contactSupported).toBe(false);
    expect(m.contact).toBeUndefined();
    expect(m.energyExpendedKj).toBeUndefined();
    expect(m.rrMs).toEqual([]);
  });

  it('uint16 HR little-endian', () => {
    expect(parseHeartRateMeasurement([0x01, 0x2c, 0x01]).bpm).toBe(300); // 0x012C
    expect(parseHeartRateMeasurement(new Uint8Array([0x01, 0x48, 0x00])).bpm).toBe(72);
  });

  it('sensor contact bits (bit2 supported, bit1 detected)', () => {
    const det = parseHeartRateMeasurement([0x06, 70]); // 0b110
    expect(det.contactSupported).toBe(true);
    expect(det.contact).toBe(true);
    const lost = parseHeartRateMeasurement([0x04, 70]); // 0b100
    expect(lost.contactSupported).toBe(true);
    expect(lost.contact).toBe(false);
    const unsupported = parseHeartRateMeasurement([0x02, 70]); // bit1 without bit2 -> undefined
    expect(unsupported.contactSupported).toBe(false);
    expect(unsupported.contact).toBeUndefined();
  });

  it('energy expended (uint16 kJ)', () => {
    const m = parseHeartRateMeasurement([0x08, 80, 0x34, 0x12]);
    expect(m.bpm).toBe(80);
    expect(m.energyExpendedKj).toBe(0x1234); // 4660
    expect(m.rrMs).toEqual([]);
  });

  it('RR intervals in 1/1024 s, rounded to 3 decimals', () => {
    // 0x0400 = 1024 -> 1000 ms; 0x0333 = 819 -> 819000/1024 = 799.8046875 -> 799.805
    expect(parseHeartRateMeasurement([0x10, 75, 0x00, 0x04, 0x33, 0x03]).rrMs).toEqual([1000, 799.805]);
  });

  it('all fields together: uint16 HR + contact + energy + 4 RR values', () => {
    // flags 0x1F = uint16 | contact detected | contact supported | energy | RR
    // HR 0x005A = 90; energy 0x03E8 = 1000
    // RR raw 1 -> 0.9765625 -> 0.977; 3 -> 2.9296875 -> 2.93; 0x0309 = 777 -> 758.7890625 -> 758.789;
    //        0xFFFF = 65535 -> 63999.0234375 -> 63999.023
    const m = parseHeartRateMeasurement([
      0x1f, 0x5a, 0x00, 0xe8, 0x03, 0x01, 0x00, 0x03, 0x00, 0x09, 0x03, 0xff, 0xff,
    ]);
    expect(m.bpm).toBe(90);
    expect(m.contactSupported).toBe(true);
    expect(m.contact).toBe(true);
    expect(m.energyExpendedKj).toBe(1000);
    expect(m.rrMs).toEqual([0.977, 2.93, 758.789, 63999.023]);
  });

  it('a trailing odd byte after RR data is ignored', () => {
    // 0x01F4 = 500 -> 488.28125 -> 488.281; trailing 0x07 ignored
    expect(parseHeartRateMeasurement([0x10, 60, 0xf4, 0x01, 0x07]).rrMs).toEqual([488.281]);
  });

  it('truncated payloads throw RangeError', () => {
    expect(() => parseHeartRateMeasurement([])).toThrow(RangeError); //               no flags
    expect(() => parseHeartRateMeasurement([0x00])).toThrow(RangeError); //           no HR byte
    expect(() => parseHeartRateMeasurement([0x01, 0x50])).toThrow(RangeError); //     uint16 HR, 1 byte
    expect(() => parseHeartRateMeasurement([0x08, 70, 0x10])).toThrow(RangeError); // energy, 1 byte
    expect(() => parseHeartRateMeasurement([0x09, 0x50, 0x00, 0x01])).toThrow(RangeError); // uint16 + energy 1 byte
  });
});

describe('audit: base64', () => {
  // Reference strings from Python's base64.b64encode (RFC 4648 standard alphabet, padded)
  const ALL_256 =
    'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fYGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn+AgYKDhIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ2en6ChoqOkpaanqKmqq6ytrq+wsbKztLW2t7i5uru8vb6/wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t/g4eLj5OXm5+jp6uvs7e7v8PHy8/T19vf4+fr7/P3+/w==';

  it('encodes against the python reference', () => {
    expect(bytesToBase64([])).toBe('');
    expect(bytesToBase64([77])).toBe('TQ==');
    expect(bytesToBase64([77, 97])).toBe('TWE=');
    expect(bytesToBase64([77, 97, 110])).toBe('TWFu');
    expect(bytesToBase64([0, 255, 128, 1, 2])).toBe('AP+AAQI=');
    expect(bytesToBase64([0xfb, 0xff, 0xbf])).toBe('+/+/');
    expect(bytesToBase64(Uint8Array.from({ length: 256 }, (_, i) => i))).toBe(ALL_256);
  });

  it('decodes against the python reference and round-trips', () => {
    expect(Array.from(base64ToBytes(''))).toEqual([]);
    expect(Array.from(base64ToBytes('TQ=='))).toEqual([77]);
    expect(Array.from(base64ToBytes('TWE='))).toEqual([77, 97]);
    expect(Array.from(base64ToBytes('TWFu'))).toEqual([77, 97, 110]);
    expect(Array.from(base64ToBytes('AP+AAQI='))).toEqual([0, 255, 128, 1, 2]);
    expect(Array.from(base64ToBytes('+/+/'))).toEqual([0xfb, 0xff, 0xbf]);
    const all = Array.from(base64ToBytes(ALL_256));
    expect(all).toEqual(Array.from({ length: 256 }, (_, i) => i));
    expect(base64ToBytes('TWFu')).toBeInstanceOf(Uint8Array);
    // round trip a BLE payload as delivered by react-native-ble-plx (base64)
    const payload = [0x1f, 0x5a, 0x00, 0xe8, 0x03, 0x01, 0x00, 0x03, 0x00, 0x09, 0x03, 0xff, 0xff];
    const b64 = bytesToBase64(payload);
    expect(b64).toBe('H1oA6AMBAAMACQP//w==');
    expect(parseHeartRateMeasurement(base64ToBytes(b64)).bpm).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// CSV (RFC 4180)
// ---------------------------------------------------------------------------

describe('audit: CSV', () => {
  const rows: Record<string, unknown>[] = [
    { id: 1, text: 'plain', note: 'a,b' },
    { id: 2.5, text: 'say "hi"', note: null },
    { id: -0, text: 'line1\nline2', extra: 'x' },
    { id: Number.NaN, text: 'cr\rmid', note: undefined },
    { id: Number.POSITIVE_INFINITY, text: 'crlf\r\nend', note: '' },
    { id: 1e21, text: ' spaced ', note: '""' },
    { id: 0.1 + 0.2, text: 'ünïcödé ✓', note: ',' },
  ];
  // columns = union of keys in first-seen order: id, text, note (row 0), extra (row 2)
  // String(-0) = '0'; NaN/Infinity -> empty; String(1e21) = '1e+21'; String(0.1+0.2) = '0.30000000000000004'
  // '""' -> quoted with each quote doubled -> '""""""'
  const EXPECTED_LINES = [
    'id,text,note,extra',
    '1,plain,"a,b",',
    '2.5,"say ""hi""",,',
    '0,"line1\nline2",,x',
    ',"cr\rmid",,',
    ',"crlf\r\nend",,',
    '1e+21, spaced ,"""""",',
    '0.30000000000000004,ünïcödé ✓,",",',
  ];

  it('toCsv quotes exactly the fields that need it and uses CRLF', () => {
    const out = toCsv(rows);
    // RFC 4180 allows (but does not require) a final CRLF; accept either.
    expect(out.replace(/\r\n$/, '')).toBe(EXPECTED_LINES.join('\r\n'));
  });

  it('parseCsv(toCsv(rows)) round-trips every nasty field', () => {
    expect(parseCsv(toCsv(rows))).toEqual([
      ['id', 'text', 'note', 'extra'],
      ['1', 'plain', 'a,b', ''],
      ['2.5', 'say "hi"', '', ''],
      ['0', 'line1\nline2', '', 'x'],
      ['', 'cr\rmid', '', ''],
      ['', 'crlf\r\nend', '', ''],
      ['1e+21', ' spaced ', '""', ''],
      ['0.30000000000000004', 'ünïcödé ✓', ',', ''],
    ]);
  });

  it('explicit columns select and order fields; header names are quoted too', () => {
    expect(toCsv(rows.slice(0, 2), ['note', 'id']).replace(/\r\n$/, '')).toBe('note,id\r\n"a,b",1\r\n,2.5');
    expect(toCsv([{ 'x,y': 1 }]).replace(/\r\n$/, '')).toBe('"x,y"\r\n1');
  });

  it('parseCsv handles mixed CRLF/LF, embedded newlines, doubled quotes, trailing newline', () => {
    expect(parseCsv('a,b\r\n"x\r\ny","q""q"\nlast,\n')).toEqual([
      ['a', 'b'],
      ['x\r\ny', 'q"q'],
      ['last', ''],
    ]);
    expect(parseCsv('h1,h2\n1,2')).toEqual([
      ['h1', 'h2'],
      ['1', '2'],
    ]);
    expect(parseCsv('"",""\r\n')).toEqual([['', '']]);
  });
});
