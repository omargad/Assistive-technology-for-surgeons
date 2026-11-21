import { describe, expect, it } from 'vitest';
import {
  METRICS,
  aggregateMetric,
  generateInsights,
  metricSeries,
  metricValue,
  tCritical95,
  trendEvidence,
  type MetricKey,
} from '../src/analytics/trends';
import { createRng, gaussian } from '../src/sim/rng';
import type {
  HrStats,
  HrvTimeDomain,
  Insight,
  PhaseKind,
  PhaseSummary,
  SessionEvent,
  SessionSummary,
  StressEpisode,
  SurgicalSession,
  WorkloadScore,
} from '../src/types';

const DAY = 86400000;
const T0 = Date.UTC(2026, 0, 5, 8, 0);

function makeSummary(id: string, startedAt: number, partial: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: id,
    participantCode: 'SP-001',
    procedureName: 'Laparoscopic cholecystectomy',
    startedAt,
    endedAt: startedAt + 3600000,
    durationSec: 3600,
    hr: null,
    hrv: null,
    rrArtifacts: null,
    stressIndex: null,
    baseline: null,
    meanHrDelta: null,
    peakHrDelta: null,
    maxHr: null,
    zones: [],
    highIntensityFraction: null,
    phases: [],
    episodes: [],
    markerCounts: {},
    workload: null,
    performance: null,
    perceivedStress: null,
    quality: { coverage: 1, gapCount: 0, longestGapSec: 0, rrArtifactRatio: null, sampleRateHz: 1 },
    ...partial,
  };
}

const hrOf = (mean: number, max = mean): HrStats => ({ count: 10, mean, median: mean, min: mean, max, sd: 0, p95: max });
const hrvOf = (rmssd: number, sdnn = 40): HrvTimeDomain => ({
  n: 100,
  pairs: 99,
  meanRr: 800,
  sdnn,
  rmssd,
  pnn50: 10,
  meanHr: 75,
});
const phaseOf = (
  phase: PhaseKind,
  index: number,
  durationSec: number,
  mean: number | null,
  meanHrDelta: number | null = null,
): PhaseSummary => ({
  phase,
  index,
  start: 0,
  end: durationSec * 1000,
  durationSec,
  hr: mean === null ? null : hrOf(mean),
  hrv: null,
  meanHrDelta,
});
const episodeOf = (durationSec: number, relatedEventIds: string[] = []): StressEpisode => ({
  start: 0,
  end: durationSec * 1000,
  durationSec,
  peakBpm: 120,
  peakT: 0,
  meanBpm: 110,
  relatedEventIds,
});
const workloadOf = (raw: number, weighted: number | null = null): WorkloadScore => ({
  instrument: 'surg-tlx',
  raw,
  weighted,
  dimensions: {},
});

/** n sessions one day apart, in chronological order. */
function series(n: number, f: (i: number) => Partial<SessionSummary>): SessionSummary[] {
  return Array.from({ length: n }, (_, i) => makeSummary(`s${i + 1}`, T0 + i * DAY, f(i)));
}

const byId = (insights: Insight[], id: string): Insight | undefined => insights.find((x) => x.id === id);

describe('METRICS', () => {
  it('describes every metric key', () => {
    const keys: MetricKey[] = [
      'meanHr',
      'peakHr',
      'meanHrDelta',
      'peakHrDelta',
      'rmssd',
      'sdnn',
      'stressIndex',
      'highIntensityPct',
      'episodeCount',
      'episodeMinutes',
      'workload',
      'performance',
      'perceivedStress',
      'durationMin',
      'criticalMeanHr',
      'criticalMeanHrDelta',
      'coveragePct',
    ];
    expect(Object.keys(METRICS).sort()).toEqual(keys.slice().sort());
    for (const k of keys) {
      const m = METRICS[k];
      expect(m.label.length).toBeGreaterThan(0);
      expect(typeof m.unit).toBe('string');
      expect(m.higherIsBetter === null || typeof m.higherIsBetter === 'boolean').toBe(true);
      expect(Number.isInteger(m.decimals) && m.decimals >= 0).toBe(true);
    }
    expect(METRICS.rmssd.higherIsBetter).toBe(true);
    expect(METRICS.stressIndex.higherIsBetter).toBe(false);
  });
});

describe('metricValue', () => {
  const s = makeSummary('a', T0, {
    hr: hrOf(82, 121),
    hrv: hrvOf(35, 48),
    stressIndex: 150,
    meanHrDelta: 12,
    peakHrDelta: 51,
    highIntensityFraction: 0.25,
    episodes: [episodeOf(90), episodeOf(30)],
    workload: workloadOf(35, 45),
    performance: 7,
    perceivedStress: 4,
    durationSec: 5400,
    quality: { coverage: 0.85, gapCount: 0, longestGapSec: 0, rrArtifactRatio: null, sampleRateHz: 1 },
    phases: [
      phaseOf('dissection', 0, 600, 80, 10),
      phaseOf('critical', 1, 60, 100, 30),
      phaseOf('critical', 2, 120, 90, 20),
      phaseOf('critical', 3, 0, null, null),
    ],
  });

  it('uses the robust peakHr when the summary has one, else hr.max', () => {
    expect(metricValue({ ...s, peakHr: 104 }, 'peakHr')).toBe(104);
    expect(metricValue({ ...s, peakHr: null }, 'peakHr')).toBeNull();
  });

  it('reads direct fields', () => {
    expect(metricValue(s, 'meanHr')).toBe(82);
    expect(metricValue(s, 'peakHr')).toBe(121);
    expect(metricValue(s, 'meanHrDelta')).toBe(12);
    expect(metricValue(s, 'peakHrDelta')).toBe(51);
    expect(metricValue(s, 'rmssd')).toBe(35);
    expect(metricValue(s, 'sdnn')).toBe(48);
    expect(metricValue(s, 'stressIndex')).toBe(150);
    expect(metricValue(s, 'performance')).toBe(7);
    expect(metricValue(s, 'perceivedStress')).toBe(4);
  });

  it('derives scaled and aggregated metrics', () => {
    expect(metricValue(s, 'highIntensityPct')).toBe(25);
    expect(metricValue(s, 'episodeCount')).toBe(2);
    expect(metricValue(s, 'episodeMinutes')).toBe(2); // (90 + 30) / 60
    expect(metricValue(s, 'durationMin')).toBe(90);
    expect(metricValue(s, 'coveragePct')).toBe(85);
  });

  it('always uses the raw workload score, never mixing in the weighted one (RV-18)', () => {
    expect(metricValue(s, 'workload')).toBe(35);
    expect(metricValue(makeSummary('b', T0, { workload: workloadOf(35) }), 'workload')).toBe(35);
  });

  it('duration-weights the critical phases', () => {
    // (100·60 + 90·120) / 180 = 16800 / 180; deltas (30·60 + 20·120) / 180 = 4200 / 180
    expect(metricValue(s, 'criticalMeanHr')).toBeCloseTo(16800 / 180, 12);
    expect(metricValue(s, 'criticalMeanHrDelta')).toBeCloseTo(4200 / 180, 12);
  });

  it('returns null for missing data (but 0 episodes is a value)', () => {
    const empty = makeSummary('e', T0);
    for (const k of [
      'meanHr',
      'peakHr',
      'meanHrDelta',
      'peakHrDelta',
      'rmssd',
      'sdnn',
      'stressIndex',
      'highIntensityPct',
      'workload',
      'performance',
      'perceivedStress',
      'criticalMeanHr',
      'criticalMeanHrDelta',
    ] as const) {
      expect(metricValue(empty, k)).toBeNull();
    }
    expect(metricValue(empty, 'episodeCount')).toBe(0);
    expect(metricValue(empty, 'episodeMinutes')).toBe(0);
  });
});

describe('aggregateMetric', () => {
  const summaries = [
    makeSummary('a', T0, { trainingLevel: 'registrar', hr: hrOf(80) }),
    makeSummary('b', T0 + DAY, { trainingLevel: 'registrar', hr: hrOf(90) }),
    makeSummary('c', T0 + 2 * DAY, { trainingLevel: 'consultant', hr: hrOf(70) }),
    makeSummary('d', T0 + 3 * DAY, { hr: hrOf(75) }),
    makeSummary('e', T0 + 4 * DAY, { trainingLevel: 'registrar' }), // no HR → skipped
    makeSummary('f', T0 + 5 * DAY, { trainingLevel: 'fellow' }), // group with no values → dropped
  ];

  it('computes n, mean, sd, median, min, max per group, sorted by name', () => {
    expect(aggregateMetric(summaries, 'meanHr', 'trainingLevel')).toEqual([
      // code-unit order: 'U' (0x55) sorts before lower-case letters
      { group: 'Unspecified', n: 1, mean: 75, sd: 0, median: 75, min: 75, max: 75 },
      { group: 'consultant', n: 1, mean: 70, sd: 0, median: 70, min: 70, max: 70 },
      { group: 'registrar', n: 2, mean: 85, sd: Math.sqrt(50), median: 85, min: 80, max: 90 },
    ]);
  });

  it("puts every session in one 'All' group for groupBy none", () => {
    const [row, ...rest] = aggregateMetric(summaries, 'meanHr', 'none');
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ group: 'All', n: 4, mean: 78.75, median: 77.5, min: 70, max: 90 });
  });

  it('groups by UTC month in chronological order', () => {
    const months = [
      makeSummary('x', Date.UTC(2026, 1, 10), { hr: hrOf(70) }),
      makeSummary('y', Date.UTC(2025, 11, 31, 23, 30), { hr: hrOf(80) }),
      makeSummary('z', Date.UTC(2026, 0, 1, 0, 0), { hr: hrOf(90) }),
      makeSummary('w', Date.UTC(2026, 0, 31, 23, 59), { hr: hrOf(100) }),
    ];
    expect(aggregateMetric(months, 'meanHr', 'month').map((r) => [r.group, r.n, r.mean])).toEqual([
      ['2025-12', 1, 80],
      ['2026-01', 2, 95],
      ['2026-02', 1, 70],
    ]);
  });

  it('groups by local month when tzOffsetMin is known (RV-7)', () => {
    // 08:00 AEDT on 1 March 2026 is 21:00 UTC on 28 February
    const melbourneMorning = makeSummary('m', Date.UTC(2026, 1, 28, 21, 0), { hr: hrOf(80), tzOffsetMin: 660 });
    const utcOnly = makeSummary('u', Date.UTC(2026, 1, 28, 21, 0), { hr: hrOf(70) });
    expect(aggregateMetric([melbourneMorning, utcOnly], 'meanHr', 'month').map((r) => [r.group, r.mean])).toEqual([
      ['2026-02', 70],
      ['2026-03', 80],
    ]);
  });

  it("maps missing or blank group fields to 'Unspecified'", () => {
    const rows = aggregateMetric(
      [
        makeSummary('a', T0, { procedureName: '  ', hr: hrOf(70) }),
        makeSummary('b', T0, { procedureName: 'Appendicectomy', hr: hrOf(80), approach: 'open' }),
      ],
      'meanHr',
      'procedure',
    );
    expect(rows.map((r) => r.group)).toEqual(['Appendicectomy', 'Unspecified']);
    expect(aggregateMetric([makeSummary('a', T0, { hr: hrOf(70) })], 'meanHr', 'approach')[0]!.group).toBe(
      'Unspecified',
    );
  });

  it('returns [] when no session has the metric', () => {
    expect(aggregateMetric([makeSummary('a', T0)], 'rmssd', 'participant')).toEqual([]);
    expect(aggregateMetric([], 'meanHr', 'none')).toEqual([]);
  });
});

describe('metricSeries', () => {
  it('returns chronological points with nulls dropped (stable for equal times)', () => {
    const out = metricSeries(
      [
        makeSummary('late', T0 + 2 * DAY, { hr: hrOf(70) }),
        makeSummary('early', T0, { hr: hrOf(80) }),
        makeSummary('none', T0 + DAY),
        makeSummary('tie', T0, { hr: hrOf(75) }),
      ],
      'meanHr',
    );
    expect(out).toEqual([
      { sessionId: 'early', t: T0, value: 80 },
      { sessionId: 'tie', t: T0, value: 75 },
      { sessionId: 'late', t: T0 + 2 * DAY, value: 70 },
    ]);
  });
});

describe('generateInsights', () => {
  it('returns [] without summaries', () => {
    expect(generateInsights([])).toEqual([]);
  });

  describe('rule 1: peak phase', () => {
    const peaks = (a: number, b: number): Partial<SessionSummary> => ({
      phases: [phaseOf('dissection', 0, 600, a), phaseOf('critical', 1, 300, b)],
    });
    it('reports a phase that is the peak in ≥ 50 % of ≥ 3 sessions', () => {
      const sums = [
        makeSummary('s1', T0, peaks(80, 95)),
        makeSummary('s2', T0 + DAY, peaks(85, 90)),
        makeSummary('s3', T0 + 2 * DAY, peaks(90, 88)),
        makeSummary('s4', T0 + 3 * DAY), // no phase data → not counted
      ];
      const ins = byId(generateInsights(sums), 'peak-phase');
      expect(ins).toBeDefined();
      expect(ins!.kind).toBe('info');
      expect(ins!.evidence).toEqual(['s1', 's2']);
      expect(ins!.detail).toContain('2 of 3');
      expect(ins!.title).toContain('critical');
    });
    it('needs at least 3 sessions with phase data', () => {
      const sums = [makeSummary('s1', T0, peaks(80, 95)), makeSummary('s2', T0 + DAY, peaks(85, 90))];
      expect(byId(generateInsights(sums), 'peak-phase')).toBeUndefined();
    });
    it('stays silent when no phase reaches 50 %', () => {
      const sums = [
        makeSummary('s1', T0, { phases: [phaseOf('dissection', 0, 60, 90), phaseOf('critical', 1, 60, 80)] }),
        makeSummary('s2', T0 + DAY, { phases: [phaseOf('critical', 0, 60, 90), phaseOf('closure', 1, 60, 80)] }),
        makeSummary('s3', T0 + 2 * DAY, { phases: [phaseOf('closure', 0, 60, 90), phaseOf('dissection', 1, 60, 80)] }),
      ];
      expect(byId(generateInsights(sums), 'peak-phase')).toBeUndefined();
    });
    it('breaks equal per-session means by PHASE_ORDER, not by logging order (RV-15)', () => {
      // critical logged before dissection, equal means → the session peak is dissection (earlier in PHASE_ORDER)
      const tie = { phases: [phaseOf('critical', 0, 300, 90), phaseOf('dissection', 1, 300, 90)] };
      const sums = [makeSummary('s1', T0, tie), makeSummary('s2', T0 + DAY, tie), makeSummary('s3', T0 + 2 * DAY, tie)];
      expect(byId(generateInsights(sums), 'peak-phase')!.title).toContain('dissection');
    });
    it('combines repeated segments of a phase duration-weighted before comparing (RV-15)', () => {
      // dissection 88 / 95 / 86 (600 s each) → 89.7 combined, below critical 91
      const rep = {
        phases: [
          phaseOf('dissection', 0, 600, 88),
          phaseOf('critical', 1, 600, 91),
          phaseOf('dissection', 2, 600, 95),
          phaseOf('dissection', 3, 600, 86),
        ],
      };
      const sums = [makeSummary('s1', T0, rep), makeSummary('s2', T0 + DAY, rep), makeSummary('s3', T0 + 2 * DAY, rep)];
      expect(byId(generateInsights(sums), 'peak-phase')!.title).toContain('critical');
      // a 20-s spike segment barely moves a long phase's combined mean
      const short = { phases: [phaseOf('dissection', 0, 2400, 85), phaseOf('dissection', 1, 20, 120), phaseOf('critical', 2, 600, 90)] };
      const sums2 = [makeSummary('a', T0, short), makeSummary('b', T0 + DAY, short), makeSummary('c', T0 + 2 * DAY, short)];
      expect(byId(generateInsights(sums2), 'peak-phase')!.title).toContain('critical');
    });
    it('breaks a 50/50 tie towards the earlier operative phase', () => {
      const sums = [
        makeSummary('s1', T0, peaks(80, 95)),
        makeSummary('s2', T0 + DAY, peaks(85, 90)),
        makeSummary('s3', T0 + 2 * DAY, peaks(95, 88)),
        makeSummary('s4', T0 + 3 * DAY, peaks(99, 88)),
      ];
      const ins = byId(generateInsights(sums), 'peak-phase');
      expect(ins!.evidence).toEqual(['s3', 's4']);
      expect(ins!.title).toContain('dissection');
    });
  });

  describe('rule 2: HR trend', () => {
    it('is positive for a clear falling trend over ≥ 8 sessions (sorted chronologically first)', () => {
      const sums = series(8, (i) => ({ meanHrDelta: 20 - 2 * i + (i % 2 === 0 ? 0.5 : -0.5) })).reverse();
      const ins = byId(generateInsights(sums), 'hr-trend');
      expect(ins!.kind).toBe('positive');
      expect(ins!.evidence).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']);
      expect(ins!.detail).toContain('-2 bpm per session');
      expect(ins!.detail).toContain('p < 0.05');
      // descriptive wording only: no claim that experience caused the change (RV-1)
      expect(`${ins!.title} ${ins!.detail}`.toLowerCase()).not.toContain('experience');
    });
    it('is attention for a clear rising trend, falling back to meanHr without meanHrDelta', () => {
      const sums = series(8, (i) => ({ hr: hrOf(70 + i) }));
      const ins = byId(generateInsights(sums), 'hr-trend');
      expect(ins!.kind).toBe('attention');
      expect(ins!.detail).toContain('average heart rate');
      expect(ins!.detail).toContain('+1 bpm per session');
    });
    it('stays silent for a flat trend, fewer than 8 sessions, or a slope that is not significant (RV-1)', () => {
      const ys = [10, 10.2, 10.1, 10.3, 10.2, 10.1, 10.3, 10.2]; // slope ≈ 0.02
      expect(byId(generateInsights(series(8, (i) => ({ meanHrDelta: ys[i]! }))), 'hr-trend')).toBeUndefined();
      // a perfect line, but only 7 sessions
      expect(byId(generateInsights(series(7, (i) => ({ meanHrDelta: 20 - 5 * i }))), 'hr-trend')).toBeUndefined();
      // noise with a visible slope (−0.71 bpm/session, which the old rule reported) but t = −1.30, p > 0.05
      const noise = [18, 12, 16, 11, 13, 19, 9, 10];
      const fit = trendEvidence(noise.map((y, x) => ({ x, y })))!;
      expect(Math.abs(fit.slope)).toBeGreaterThanOrEqual(0.5);
      expect(fit.significant).toBe(false);
      expect(byId(generateInsights(series(8, (i) => ({ meanHrDelta: noise[i]! }))), 'hr-trend')).toBeUndefined();
    });
  });

  describe('rule 3: intra-operative HRV', () => {
    const rmssd = (values: number[]): SessionSummary[] => series(values.length, (i) => ({ hrv: hrvOf(values[i]!) }));
    it('reports a clear, ≥ 15 % drop in the last 3 sessions as info, without fatigue or rest advice (RV-1)', () => {
      const ins = byId(generateInsights(rmssd([40, 41, 39, 40, 41, 30, 31, 29])), 'hrv-trend');
      expect(ins!.kind).toBe('info');
      expect(ins!.title).toContain('lower');
      expect(ins!.detail).toContain('25 %');
      expect(ins!.detail).toContain('p < 0.05');
      expect(ins!.detail.toLowerCase()).not.toContain('rest and recovery');
      expect(ins!.detail.toLowerCase()).toContain('not a measure of fatigue');
      expect(ins!.evidence).toHaveLength(8);
    });
    it('reports a clear rise too', () => {
      const ins = byId(generateInsights(rmssd([30, 31, 29, 30, 31, 40, 41, 39])), 'hrv-trend');
      expect(ins!.title).toContain('higher');
    });
    it('stays silent for small, noisy or under-powered changes', () => {
      expect(byId(generateInsights(rmssd([40, 40, 41, 39, 40, 38, 38, 38])), 'hrv-trend')).toBeUndefined();
      // ≥ 15 % apart on average but within the session-to-session spread: not significant
      expect(byId(generateInsights(rmssd([25, 55, 30, 50, 40, 20, 45, 37])), 'hrv-trend')).toBeUndefined();
      // the old 5-session case
      expect(byId(generateInsights(rmssd([40, 40, 30, 30, 30])), 'hrv-trend')).toBeUndefined();
    });
  });

  describe('rule 4: workload vs physiology', () => {
    it('reports a strong, significant correlation over ≥ 10 sessions as info', () => {
      const pos = series(10, (i) => ({ workload: workloadOf(20 + 8 * i), meanHrDelta: 5 + 2 * i }));
      const ins = byId(generateInsights(pos), 'workload-hr');
      expect(ins!.kind).toBe('info');
      expect(ins!.detail).toContain('r = 1');
      expect(ins!.detail).toContain('n = 10');
      expect(ins!.detail.toLowerCase()).toContain('does not show that one causes the other');
      expect(ins!.evidence).toHaveLength(10);
      const neg = series(10, (i) => ({ workload: workloadOf(20 + 8 * i), meanHrDelta: 25 - 2 * i }));
      expect(byId(generateInsights(neg), 'workload-hr')!.detail).toContain('r = -1');
    });
    it('stays silent for weak or non-significant correlation, or fewer than 10 paired sessions', () => {
      const deltas = [10, 20, 10, 20, 10, 20, 10, 20, 10, 20]; // r ≈ 0.17
      expect(
        byId(generateInsights(series(10, (i) => ({ workload: workloadOf(20 + 8 * i), meanHrDelta: deltas[i]! }))), 'workload-hr'),
      ).toBeUndefined();
      // a perfect correlation from only 9 pairs
      const nine = series(10, (i) => ({ workload: i < 9 ? workloadOf(20 + 8 * i) : null, meanHrDelta: 5 + 2 * i }));
      expect(byId(generateInsights(nine), 'workload-hr')).toBeUndefined();
      // r = 0.60 from 10 pairs: above the old 0.5 cut-off but p > 0.05 (critical r = 0.632)
      const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const ys = [3, 1, 4, 1, 5, 9, 2, 6, 5, 8];
      const mid = series(10, (i) => ({ workload: workloadOf(xs[i]! * 10), meanHrDelta: ys[i]! }));
      expect(byId(generateInsights(mid), 'workload-hr')).toBeUndefined();
    });
    it('uses the raw TLX score even when some sessions are weighted (RV-18)', () => {
      // raw scores track HR perfectly; weighted scores (present on alternate sessions) would break the pattern
      const sums = series(10, (i) => ({
        workload: workloadOf(20 + 8 * i, i % 2 === 0 ? 95 - 8 * i : null),
        meanHrDelta: 5 + 2 * i,
      }));
      expect(byId(generateInsights(sums), 'workload-hr')!.detail).toContain('r = 1');
    });
  });

  describe('false-positive rate under the null (RV-1)', () => {
    it('rules 2–4 fire on at most ~5 % of noise-only histories', () => {
      const rng = createRng(20261121);
      const trials = 1500;
      for (const n of [8, 10, 12]) {
        let trend = 0;
        let hrv = 0;
        let wl = 0;
        for (let k = 0; k < trials; k++) {
          // no true trend, no true change and workload independent of HR
          const sums = series(n, () => ({
            meanHrDelta: 15 + 6 * gaussian(rng),
            hrv: hrvOf(Math.max(5, 30 * (1 + 0.25 * gaussian(rng)))),
            workload: workloadOf(50 + 15 * gaussian(rng)),
          }));
          const ins = generateInsights(sums);
          if (byId(ins, 'hr-trend')) trend++;
          if (byId(ins, 'hrv-trend')) hrv++;
          if (byId(ins, 'workload-hr')) wl++;
        }
        // The old rules fired 46 % / 39 % / 14 % at n = 10 (and 80 % / 50 % / 39 % at n = 5).
        expect(trend / trials).toBeLessThan(0.08);
        expect(hrv / trials).toBeLessThan(0.08);
        expect(wl / trials).toBeLessThan(0.08);
      }
    });
  });

  describe('statistical helpers', () => {
    it('tCritical95 returns two-sided 5 % critical values (conservative between table rows)', () => {
      expect(tCritical95(1)).toBe(12.706);
      expect(tCritical95(6)).toBe(2.447);
      expect(tCritical95(8.9)).toBe(2.306);
      expect(tCritical95(35)).toBe(2.042);
      expect(tCritical95(5000)).toBe(1.96);
      expect(tCritical95(0)).toBeNull();
      expect(tCritical95(Number.NaN)).toBeNull();
    });
    it('trendEvidence tests the slope against zero', () => {
      expect(trendEvidence([{ x: 0, y: 1 }, { x: 1, y: 2 }])).toMatchObject({ t: null, significant: false });
      expect(trendEvidence([0, 1, 2, 3].map((x) => ({ x, y: 2 * x })))).toMatchObject({ t: null, significant: true });
      expect(trendEvidence([0, 1, 2, 3].map((x) => ({ x, y: 5 })))).toMatchObject({ t: 0, significant: false });
      const e = trendEvidence([1, 3, 2, 5, 4, 6].map((y, x) => ({ x, y })))!;
      // r² = 0.7845 → t = √(0.7845·4/0.2155) = 3.816 > 2.776 (df 4)
      expect(e.t!).toBeCloseTo(3.816, 2);
      expect(e.significant).toBe(true);
    });
  });

  describe('rule 5: data quality', () => {
    const q = (coverage: number) => ({
      quality: { coverage, gapCount: 0, longestGapSec: 0, rrArtifactRatio: null, sampleRateHz: 1 },
    });
    it('flags coverage < 0.8 in the latest session', () => {
      const sums = [makeSummary('new', T0 + DAY, q(0.7)), makeSummary('old', T0, q(0.95))];
      const ins = byId(generateInsights(sums), 'data-quality');
      expect(ins!.kind).toBe('attention');
      expect(ins!.evidence).toEqual(['new']);
      expect(ins!.detail).toContain('70 %');
      expect(ins!.detail.toLowerCase()).toContain('strap');
    });
    it('gives watch advice for health-store sessions and stays silent for simulated ones (RV-11)', () => {
      const watch = byId(generateInsights([makeSummary('w', T0, { ...q(0.5), sensorSource: 'healthkit' })]), 'data-quality');
      expect(watch!.detail.toLowerCase()).toContain('watch');
      expect(watch!.detail.toLowerCase()).not.toContain('electrodes');
      expect(byId(generateInsights([makeSummary('s', T0, { ...q(0.5), sensorSource: 'simulated' })]), 'data-quality')).toBeUndefined();
    });
    it('stays silent when the latest session is flagged synthetic (e.g. a demo-tagged strap session)', () => {
      const demo = makeSummary('d', T0 + DAY, { ...q(0.5), sensorSource: 'ble', simulated: true });
      expect(byId(generateInsights([makeSummary('old', T0, q(0.95)), demo]), 'data-quality')).toBeUndefined();
      // the flag only suppresses the rule when set: a real low-coverage strap session still gets the tip
      const real = makeSummary('r', T0 + DAY, { ...q(0.5), sensorSource: 'ble', simulated: false });
      expect(byId(generateInsights([real]), 'data-quality')!.evidence).toEqual(['r']);
    });
    it('ignores earlier sessions and coverage of exactly 0.8', () => {
      expect(byId(generateInsights([makeSummary('old', T0, q(0.5)), makeSummary('new', T0 + DAY, q(0.9))]), 'data-quality')).toBeUndefined();
      expect(byId(generateInsights([makeSummary('only', T0, q(0.8))]), 'data-quality')).toBeUndefined();
    });
  });

  describe('rule 6: episodes after markers', () => {
    function sessionWith(id: string, events: SessionEvent[]): SurgicalSession {
      return {
        schemaVersion: 1,
        id,
        participantCode: 'SP-001',
        procedure: { name: 'x' },
        startedAt: 0,
        status: 'completed',
        sensor: { source: 'simulated' },
        app: { version: '0', platform: 'web' },
        samples: [],
        rr: [],
        events,
      };
    }
    const sessions = [
      sessionWith('A', [
        { id: 'm1', t: 0, type: 'marker', marker: 'complication' },
        { id: 'm2', t: 0, type: 'marker', marker: 'note' },
        { id: 'p1', t: 0, type: 'phase', phase: 'critical' },
      ]),
      sessionWith('B', [{ id: 'i1', t: 0, type: 'marker', marker: 'interruption' }]),
    ];

    it('reports when ≥ 50 % of ≥ 3 episodes follow a complication or interruption', () => {
      const sums = [
        makeSummary('A', T0, { episodes: [episodeOf(90, ['m1', 'p1']), episodeOf(90, ['m2', 'p1'])] }),
        makeSummary('B', T0 + DAY, { episodes: [episodeOf(90, ['i1'])] }),
      ];
      const ins = byId(generateInsights(sums, { sessions }), 'episodes-after-markers');
      expect(ins!.kind).toBe('info');
      expect(ins!.evidence).toEqual(['A', 'B']);
      expect(ins!.detail).toContain('2 of 3');
      // summaries alone do not say which related ids are complications → rule needs the sessions
      expect(byId(generateInsights(sums), 'episodes-after-markers')).toBeUndefined();
    });

    it('stays silent below 50 % or with fewer than 3 episodes', () => {
      const minority = [
        makeSummary('A', T0, { episodes: [episodeOf(90, ['m1']), episodeOf(90, ['m2']), episodeOf(90, ['p1'])] }),
      ];
      expect(byId(generateInsights(minority, { sessions }), 'episodes-after-markers')).toBeUndefined();
      const few = [makeSummary('A', T0, { episodes: [episodeOf(90, ['m1']), episodeOf(90, ['m1'])] })];
      expect(byId(generateInsights(few, { sessions }), 'episodes-after-markers')).toBeUndefined();
    });
  });

  it('emits insights in rule order with complete, readable text', () => {
    const sums = series(10, (i) => ({
      meanHrDelta: 20 - 2 * i,
      hrv: hrvOf(i < 7 ? 30 + (i % 2) : 40 + (i % 2)),
      workload: workloadOf(80 - 5 * i),
      phases: [phaseOf('dissection', 0, 600, 80), phaseOf('critical', 1, 300, 95)],
      quality: { coverage: i === 9 ? 0.6 : 1, gapCount: 0, longestGapSec: 0, rrArtifactRatio: null, sampleRateHz: 1 },
    }));
    const out = generateInsights(sums);
    expect(out.map((x) => x.id)).toEqual(['peak-phase', 'hr-trend', 'hrv-trend', 'workload-hr', 'data-quality']);
    for (const ins of out) {
      expect(ins.title.length).toBeGreaterThan(0);
      expect(`${ins.title} ${ins.detail}`).not.toMatch(/NaN|undefined|Infinity|null/);
      expect(ins.evidence.length).toBeGreaterThan(0);
    }
    // deterministic
    expect(generateInsights(sums)).toEqual(out);
  });
});
