import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataQuality, effectiveMaxGapMs, isSyntheticSession, summarizeSession } from '../src/analytics/summary';
import { baevskyStressIndex, cleanRr, windowedStressIndex } from '../src/analytics/rr';
import { robustPeakHr } from '../src/analytics/hr';
import { computeBaseline } from '../src/analytics/baseline';
import { summariesToCsv, parseCsv } from '../src/io/csv';
import { simulateSession } from '../src/sim/simulate';
import { createRng } from '../src/sim/rng';
import { ANALYTICS_VERSION } from '../src/types';
import { scoreWorkload } from '../src/instruments/tlx';
import type { HeartRateSample, RRInterval, SessionEvent, SurgicalSession, SurgTlxResponse } from '../src/types';

const S = Date.UTC(2026, 0, 5, 8, 0); // 2026-01-05 08:00 UTC

function makeSession(partial: Partial<SurgicalSession> = {}): SurgicalSession {
  return {
    schemaVersion: 1,
    id: 'S1',
    participantCode: 'SP-001',
    procedure: { name: 'Test procedure' },
    startedAt: 0,
    status: 'completed',
    sensor: { source: 'simulated' },
    app: { version: '0.1.0', platform: 'web' },
    samples: [],
    rr: [],
    events: [],
    ...partial,
  };
}

/**
 * Two-minute case, one sample every 5 s (24 samples, t = S … S+115 s):
 *   0–25 s: 70 bpm · 30–55 s: 80 bpm · 60–85 s: 100 bpm · 90–115 s: 85 bpm
 * Σ = 420 + 480 + 600 + 510 = 2010 → mean 83.75; sorted middle values 80, 85 → median 82.5;
 * squared deviations: 6·13.75² + 6·3.75² + 6·16.25² + 6·1.25² = 2812.5 → SD √(2812.5/23); p95 = 100.
 */
function bpmAt(i: number): number {
  if (i < 6) return 70;
  if (i < 12) return 80;
  if (i < 18) return 100;
  return 85;
}
const samples: HeartRateSample[] = Array.from({ length: 24 }, (_, i) => ({ t: S + i * 5000, bpm: bpmAt(i) }));

const events: SessionEvent[] = [
  { id: 'p1', t: S, type: 'phase', phase: 'incision' },
  { id: 'p2', t: S + 60000, type: 'phase', phase: 'critical' },
  { id: 'm1', t: S + 70000, type: 'marker', marker: 'complication' },
  { id: 'm2', t: S + 80000, type: 'marker', marker: 'note' },
  { id: 'm3', t: S + 90000, type: 'marker', marker: 'complication' },
];

const workload: SurgTlxResponse = {
  instrument: 'surg-tlx',
  ratings: { mental: 50, physical: 20, temporal: 40, complexity: 60, stress: 30, distraction: 10 },
  weights: { mental: 5, physical: 0, temporal: 3, complexity: 4, stress: 2, distraction: 1 },
  completedAt: S + 200000,
};

function fullSession(partial: Partial<SurgicalSession> = {}): SurgicalSession {
  return makeSession({
    startedAt: S,
    endedAt: S + 120000,
    procedure: {
      name: 'Laparoscopic cholecystectomy',
      specialty: 'General surgery',
      approach: 'laparoscopic',
      role: 'primary',
      urgency: 'elective',
      complexity: 3,
    },
    participantSnapshot: { restingHr: 70, birthYear: 1986, trainingLevel: 'registrar' },
    samples,
    events,
    postOp: { workload, performance: 7, perceivedStress: 4 },
    ...partial,
  });
}

function deepFreeze<T>(x: T): T {
  if (x !== null && typeof x === 'object' && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x as Record<string, unknown>)) deepFreeze(v);
  }
  return x;
}

function collectNonFinite(x: unknown, path = '$', out: string[] = []): string[] {
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) out.push(path);
  } else if (x !== null && typeof x === 'object') {
    for (const [k, v] of Object.entries(x)) collectNonFinite(v, `${path}.${k}`, out);
  }
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dataQuality', () => {
  it('measures coverage, gaps and sample rate', () => {
    // covered = 1000 + 1000 + 1000 + min(7000, 5000) + 1000 = 9000 of 20000 ms
    const s = makeSession({
      startedAt: 0,
      endedAt: 20000,
      samples: [0, 1000, 2000, 3000, 10000, 11000].map((t) => ({ t, bpm: 70 })),
    });
    const q = dataQuality(s);
    expect(q.coverage).toBe(0.45);
    expect(q.gapCount).toBe(1);
    expect(q.longestGapSec).toBe(7);
    expect(q.sampleRateHz).toBeCloseTo(5 / 9, 12);
    expect(q.rrArtifactRatio).toBeNull();
  });

  it('clips covered time to the session window', () => {
    // intervals [−2000,−1000] and [−1000,0] are outside; [0,1000] counts → 1000 / 2000
    const before = makeSession({
      startedAt: 0,
      endedAt: 2000,
      samples: [-2000, -1000, 0, 1000].map((t) => ({ t, bpm: 70 })),
    });
    expect(dataQuality(before).coverage).toBe(0.5);
    // Only the 2 valid samples inside [startedAt, sessionEnd] count: (2 − 1) / 1 s = 1 Hz for 1 Hz data
    // (counting all 4 samples gave 3 Hz, inflated by samples recorded before the start).
    expect(dataQuality(before).sampleRateHz).toBe(1);
    // [1000, 2000] is clipped to [1000, 1500] → covered 1500 of 1500
    const after = makeSession({ startedAt: 0, endedAt: 1500, samples: [0, 1000, 2000].map((t) => ({ t, bpm: 70 })) });
    expect(dataQuality(after).coverage).toBe(1);
  });

  it('uses only valid samples for covered time but all samples for gaps', () => {
    const s = makeSession({
      startedAt: 0,
      endedAt: 2000,
      samples: [
        { t: 0, bpm: 70 },
        { t: 1000, bpm: 0 },
        { t: 2000, bpm: 70 },
      ],
    });
    const q = dataQuality(s);
    expect(q.coverage).toBe(1); // min(2000, 5000) between the two valid samples
    expect(q.sampleRateHz).toBe(0.5); // (2 − 1) / 2 s
    expect(q.gapCount).toBe(0);
  });

  it('returns coverage 0 for a non-positive duration and sample rate 0 without covered time', () => {
    const s = makeSession({ startedAt: 1000, endedAt: 1000, samples: [{ t: 1000, bpm: 70 }] });
    expect(dataQuality(s)).toEqual({ coverage: 0, gapCount: 0, longestGapSec: 0, rrArtifactRatio: null, sampleRateHz: 0 });
  });

  it('honours maxGapMs and reports the RR artefact ratio', () => {
    const s = makeSession({
      startedAt: 0,
      endedAt: 8000,
      samples: [
        { t: 0, bpm: 70 },
        { t: 8000, bpm: 70 },
      ],
      rr: [
        { t: 800, ms: 800 },
        { t: 3300, ms: 2500 },
        { t: 4110, ms: 810 },
        { t: 4900, ms: 790 },
      ],
    });
    expect(dataQuality(s).coverage).toBe(5000 / 8000);
    expect(dataQuality(s).gapCount).toBe(1);
    const q = dataQuality(s, 10000);
    expect(q.coverage).toBe(1);
    expect(q.gapCount).toBe(0);
    expect(q.rrArtifactRatio).toBe(0.25);
  });
});

describe('summarizeSession', () => {
  it('wires every field for a complete session', () => {
    const sum = summarizeSession(fullSession());
    expect(sum.sessionId).toBe('S1');
    expect(sum.participantCode).toBe('SP-001');
    expect(sum.procedureName).toBe('Laparoscopic cholecystectomy');
    expect(sum.specialty).toBe('General surgery');
    expect(sum.approach).toBe('laparoscopic');
    expect(sum.role).toBe('primary');
    expect(sum.urgency).toBe('elective');
    expect(sum.complexity).toBe(3);
    expect(sum.trainingLevel).toBe('registrar');
    expect(sum.startedAt).toBe(S);
    expect(sum.endedAt).toBe(S + 120000);
    expect(sum.durationSec).toBe(120);

    expect(sum.hr!.count).toBe(24);
    expect(sum.hr!.mean).toBe(83.75);
    expect(sum.hr!.median).toBe(82.5);
    expect(sum.hr!.min).toBe(70);
    expect(sum.hr!.max).toBe(100);
    expect(sum.hr!.sd).toBeCloseTo(Math.sqrt(2812.5 / 23), 10);
    expect(sum.hr!.p95).toBe(100);

    // no RR data
    expect(sum.hrv).toBeNull();
    expect(sum.rrArtifacts).toBeNull();
    expect(sum.stressIndex).toBeNull();

    // no session baseline → profile baseline from participantSnapshot.restingHr
    expect(sum.baseline).toEqual({ source: 'profile', restingHr: 70, startedAt: S, endedAt: S });
    expect(sum.meanHrDelta).toBe(13.75);
    expect(sum.peakHrDelta).toBe(30);

    // maxHr from birthYear 1986 at the UTC year of startedAt (2026): 208 − 0.7·40 = 180
    expect(sum.maxHr).toBe(180);
    // zones from the baseline (70): rest <80, elevated <90, high <100, very-high ≥100; 5 s per sample
    expect(sum.zones).toEqual([
      { id: 'rest', label: 'At rest', seconds: 30, fraction: 0.25 },
      { id: 'elevated', label: 'Elevated', seconds: 60, fraction: 0.5 },
      { id: 'high', label: 'High', seconds: 0, fraction: 0 },
      { id: 'very-high', label: 'Very high', seconds: 30, fraction: 0.25 },
    ]);
    // nothing reaches 0.7·180 = 126 bpm
    expect(sum.highIntensityFraction).toBe(0);

    // phases: incision [S, S+60 s) = 70×6, 80×6; critical [S+60 s, S+120 s) = 100×6, 85×6
    expect(sum.phases).toHaveLength(2);
    const [incision, critical] = sum.phases;
    expect(incision).toMatchObject({ phase: 'incision', index: 0, start: S, end: S + 60000, durationSec: 60 });
    expect(incision!.hr).toEqual({ count: 12, mean: 75, median: 75, min: 70, max: 80, sd: incision!.hr!.sd, p95: 80 });
    expect(incision!.hr!.sd).toBeCloseTo(Math.sqrt(300 / 11), 10);
    expect(incision!.hrv).toBeNull();
    expect(incision!.meanHrDelta).toBe(5);
    expect(critical).toMatchObject({ phase: 'critical', index: 1, start: S + 60000, end: S + 120000, durationSec: 60 });
    expect(critical!.hr!.mean).toBe(92.5);
    expect(critical!.meanHrDelta).toBe(22.5);

    // default threshold = 70 + 20 = 90 → only 60–85 s (25 s) is elevated → shorter than 60 s → no episodes
    expect(sum.episodes).toEqual([]);

    expect(sum.markerCounts).toEqual({ complication: 2, note: 1 });
    expect(Object.keys(sum.markerCounts)).toEqual(['complication', 'note']);
    expect(sum.workload).toEqual(scoreWorkload(workload));
    expect(sum.workload!.weighted).toBeCloseTo(680 / 15, 12);
    expect(sum.performance).toBe(7);
    expect(sum.perceivedStress).toBe(4);

    // covered = 23 × 5000 ms of 120000 ms; sample rate = 23 / 115 s
    expect(sum.quality.coverage).toBeCloseTo(115 / 120, 12);
    expect(sum.quality.gapCount).toBe(0);
    expect(sum.quality.longestGapSec).toBe(0);
    expect(sum.quality.rrArtifactRatio).toBeNull();
    expect(sum.quality.sampleRateHz).toBeCloseTo(0.2, 12);
  });

  it('uses episodeThresholdBpm and annotates episodes with phase and related events', () => {
    // ≥ 80 bpm from 30 s to 115 s → one 85-s episode; peak 100 first at 60 s (critical phase)
    // mean of the 18 elevated samples = (480 + 600 + 510) / 18
    const sum = summarizeSession(fullSession(), { episodeThresholdBpm: 80 });
    expect(sum.episodes).toEqual([
      {
        start: S + 30000,
        end: S + 115000,
        durationSec: 85,
        peakBpm: 100,
        peakT: S + 60000,
        meanBpm: sum.episodes[0]!.meanBpm,
        phase: 'critical',
        relatedEventIds: ['p1', 'p2', 'm1', 'm2', 'm3'],
      },
    ]);
    expect(sum.episodes[0]!.meanBpm).toBeCloseTo(1590 / 18, 10);
  });

  it('resolves maxHr from opts, then the snapshot, then Tanaka (with opts.atYear)', () => {
    // opts.maxHr 140 → 0.7·140 = 98 → the 100-bpm samples (30 of 120 s) are high intensity
    const a = summarizeSession(fullSession(), { maxHr: 140 });
    expect(a.maxHr).toBe(140);
    expect(a.highIntensityFraction).toBe(0.25);
    expect(a.zones.map((z) => z.id)).toEqual(['rest', 'elevated', 'high', 'very-high']); // baseline still wins

    const b = summarizeSession(
      fullSession({ participantSnapshot: { restingHr: 70, birthYear: 1986, maxHr: 130 } }),
    );
    expect(b.maxHr).toBe(130);
    expect(b.highIntensityFraction).toBe(0.25); // threshold 91 bpm

    const c = summarizeSession(fullSession(), { atYear: 2036 }); // age 50 → 208 − 35
    expect(c.maxHr).toBe(173);
  });

  it('falls back to %HRmax zones without a baseline, and to nothing without either', () => {
    const noResting = summarizeSession(fullSession({ participantSnapshot: { birthYear: 1986 } }));
    expect(noResting.baseline).toBeNull();
    expect(noResting.meanHrDelta).toBeNull();
    expect(noResting.peakHrDelta).toBeNull();
    expect(noResting.maxHr).toBe(180);
    // zonesFromMaxHr(180): every sample < 108 → all 120 s in z1
    expect(noResting.zones.map((z) => [z.id, z.seconds, z.fraction])).toEqual([
      ['z1', 120, 1],
      ['z2', 0, 0],
      ['z3', 0, 0],
      ['z4', 0, 0],
      ['z5', 0, 0],
    ]);
    expect(noResting.trainingLevel).toBeUndefined();
    expect('trainingLevel' in noResting).toBe(false);

    const none = summarizeSession(fullSession({ participantSnapshot: undefined }));
    expect(none.baseline).toBeNull();
    expect(none.maxHr).toBeNull();
    expect(none.zones).toEqual([]);
    expect(none.highIntensityFraction).toBeNull();
    expect(none.phases.every((p) => p.meanHrDelta === null)).toBe(true);
    // threshold falls back to median + 15 = 97.5 → only 25 s elevated → no episodes
    expect(none.episodes).toEqual([]);
  });

  it('prefers the recorded session baseline over the profile', () => {
    const sum = summarizeSession(
      fullSession({ baseline: { startedAt: S - 300000, endedAt: S, restingHr: 60, source: 'measured' } }),
    );
    expect(sum.baseline!.source).toBe('measured');
    expect(sum.meanHrDelta).toBe(23.75);
    // zones from 60: rest <70, elevated <80, high <90, very-high ≥90
    expect(sum.zones.map((z) => z.seconds)).toEqual([0, 30, 60, 30]);
  });

  it('copies the baseline (no shared object) with keys in types.ts order', () => {
    // Keys deliberately out of order, as e.g. an imported file or another producer might write them.
    const baseline = { source: 'measured', sdnn: 41, rmssd: 33, restingHr: 60, endedAt: S, startedAt: S - 300000 } as const;
    const session = fullSession({ baseline });
    const sum = summarizeSession(session);
    expect(sum.baseline).toStrictEqual(baseline);
    expect(sum.baseline).not.toBe(session.baseline);
    expect(Object.keys(sum.baseline!)).toEqual(['startedAt', 'endedAt', 'restingHr', 'rmssd', 'sdnn', 'source']);
  });

  it('computes whole-session and per-phase HRV, artefacts and the stress index from RR', () => {
    // 40 beats alternating 800 / 850 ms plus one 2500 ms artefact, all within the incision phase
    const ms = [...Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 800 : 850)), 2500];
    for (let i = 0; i < 20; i++) ms.push(i % 2 === 0 ? 800 : 850);
    let t = S;
    const rr: RRInterval[] = ms.map((m) => {
      t += m;
      return { t, ms: m };
    });
    const sum = summarizeSession(fullSession({ rr }));
    expect(sum.rrArtifacts).toEqual({ total: 41, removed: 1, ratio: 1 / 41 });
    expect(sum.quality.rrArtifactRatio).toBe(1 / 41);
    expect(sum.hrv!.n).toBe(40);
    // 19 + 19 pairs: the artefact at index 20 breaks the 850 → 800 pair instead of joining it
    expect(sum.hrv!.pairs).toBe(38);
    expect(sum.hrv!.meanRr).toBe(825);
    // every remaining successive difference is ±50 ms
    expect(sum.hrv!.rmssd).toBe(50);
    // The stress index is the median over 5-min windows with ≥ 4 min of clean beats: 33 s of RR gives none.
    expect(sum.stressIndex).toBeNull();
    expect(sum.phases[0]!.hrv!.n).toBe(40);
    expect(sum.phases[1]!.hrv).toBeNull();
  });

  it('handles a session without post-op data or optional procedure fields', () => {
    const sum = summarizeSession(
      makeSession({ startedAt: S, endedAt: S + 1000, procedure: { name: 'Appendicectomy' } }),
    );
    expect(sum.workload).toBeNull();
    expect(sum.performance).toBeNull();
    expect(sum.perceivedStress).toBeNull();
    expect(sum.hr).toBeNull();
    expect(sum.markerCounts).toEqual({});
    expect(sum.phases).toEqual([]);
    expect(sum.episodes).toEqual([]);
    for (const key of ['specialty', 'approach', 'role', 'urgency', 'complexity', 'trainingLevel']) {
      expect(key in sum).toBe(false);
    }
  });

  it('is pure and deterministic: no clock or RNG, no input mutation, no NaN/Infinity', () => {
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now must not be called');
    });
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random must not be called');
    });
    const session = deepFreeze(fullSession({ events: events.slice().reverse() }));
    const a = summarizeSession(session, { episodeThresholdBpm: 80 });
    const b = summarizeSession(session, { episodeThresholdBpm: 80 });
    expect(a).toEqual(b);
    expect(collectNonFinite(a)).toEqual([]);
    expect(collectNonFinite(summarizeSession(deepFreeze(makeSession())))).toEqual([]);
  });
});

describe('review fixes', () => {
  const samples: HeartRateSample[] = Array.from({ length: 120 }, (_, i) => ({ t: i * 1000, bpm: 70 + (i % 40) }));

  it('treats a resting/max HR that is not a plausible bpm (e.g. 0) as missing', () => {
    const s = makeSession({ endedAt: 120000, samples, participantSnapshot: { restingHr: 0, maxHr: 0, birthYear: 1980 } });
    const out = summarizeSession(s, { atYear: 2026 });
    expect(out.baseline).toBeNull();
    expect(out.maxHr).toBe(176); // falls through to Tanaka: 208 − 0.7·46 = 175.8 → 176
    const manual = makeSession({
      endedAt: 120000,
      samples,
      baseline: { startedAt: 0, endedAt: 0, restingHr: 0, source: 'manual' },
      participantSnapshot: { restingHr: 64 },
    });
    expect(summarizeSession(manual).baseline).toEqual({ startedAt: 0, endedAt: 0, restingHr: 64, source: 'profile' });
  });

  it('highIntensityFraction is null when maxHr is known but there is no dwell time', () => {
    const one = makeSession({ endedAt: 1000, samples: [{ t: 0, bpm: 150 }], participantSnapshot: { maxHr: 190 } });
    expect(summarizeSession(one).highIntensityFraction).toBeNull();
    expect(summarizeSession(makeSession({ samples, endedAt: 120000 }), { maxHr: 100 }).highIntensityFraction).toBeCloseTo(
      1,
      12,
    );
  });

  it('sampleRateHz counts only samples inside the session window', () => {
    const wide = makeSession({
      startedAt: 20000,
      endedAt: 80000,
      samples: Array.from({ length: 101 }, (_, i) => ({ t: i * 1000, bpm: 70 })),
    });
    expect(dataQuality(wide).sampleRateHz).toBe(1);
  });

  it('a summary equals the one computed from separately cleaned RR (single cleaning pass is exact)', () => {
    const rr: RRInterval[] = Array.from({ length: 300 }, (_, i) => ({ t: i * 800, ms: 800 + (i % 7) * 9 + (i === 50 ? 500 : 0) }));
    const s = makeSession({ endedAt: 240000, samples, rr });
    const out = summarizeSession(s);
    expect(out.quality).toEqual(dataQuality(s));
    expect(out.rrArtifacts!.removed).toBeGreaterThan(0);
  });
});

describe('research-validity rules (RV review)', () => {
  /** n samples at 1 Hz from S. */
  const steady = (n: number, bpm: (i: number) => number, extra: (i: number) => Partial<HeartRateSample> = () => ({})) =>
    Array.from({ length: n }, (_, i) => ({ t: S + i * 1000, bpm: bpm(i), ...extra(i) }));

  it('ignores samples recorded without skin contact (RV-8)', () => {
    // 10 min at 80 bpm, then 10 min of a frozen 72 bpm with contact = false
    const samples = steady(1200, (i) => (i < 600 ? 80 : 72), (i) => ({ contact: i < 600 }));
    const sum = summarizeSession(makeSession({ startedAt: S, endedAt: S + 1_200_000, samples }));
    expect(sum.hr!.count).toBe(600);
    expect(sum.hr!.mean).toBe(80);
    expect(sum.quality.coverage).toBeCloseTo(0.5, 2);
    // contact: undefined (sensor without contact detection) is still valid
    const noFlag = summarizeSession(makeSession({ startedAt: S, endedAt: S + 600_000, samples: steady(600, () => 75) }));
    expect(noFlag.hr!.count).toBe(600);
    // episodes and zones skip no-contact samples as well
    const high = steady(600, () => 130, () => ({ contact: false }));
    const ep = summarizeSession(
      makeSession({ startedAt: S, endedAt: S + 600_000, samples: high, baseline: { startedAt: S, endedAt: S, restingHr: 60, source: 'manual' } }),
    );
    expect(ep.episodes).toEqual([]);
    expect(ep.zones.every((z) => z.seconds === 0)).toBe(true);
  });

  it('takes the peak from an 11-s rolling median so one spike cannot become Peak HR (RV-9)', () => {
    const samples = steady(600, (i) => (i === 300 ? 212 : 80));
    const sum = summarizeSession(
      makeSession({ startedAt: S, endedAt: S + 600_000, samples, baseline: { startedAt: S, endedAt: S, restingHr: 70, source: 'manual' } }),
    );
    expect(sum.hr!.max).toBe(212); // raw maximum is still reported
    expect(sum.peakHr).toBe(80);
    expect(sum.peakHrDelta).toBe(10);
    // a sustained rise is kept
    expect(robustPeakHr(steady(600, (i) => (i >= 300 && i < 320 ? 150 : 80)))).toBe(150);
    // sparse data (one sample per window) → plain maximum
    expect(robustPeakHr([{ t: 0, bpm: 70 }, { t: 60_000, bpm: 140 }, { t: 120_000, bpm: 90 }])).toBe(140);
    expect(robustPeakHr([])).toBeNull();
  });

  it('suppresses HRV and the stress index when more than 10 % of beats are artefacts (RV-9)', () => {
    // AF-like rhythm: RR uniform on 500–1100 ms → cleanRr removes ~half the beats
    const rng = createRng(5);
    let t = S;
    const rr: RRInterval[] = Array.from({ length: 900 }, () => {
      const ms = 500 + 600 * rng();
      t += ms;
      return { t: Math.round(t), ms };
    });
    const session = makeSession({ startedAt: S, endedAt: t + 1000, samples: steady(Math.ceil((t - S) / 1000), () => 85), rr });
    const sum = summarizeSession(session);
    expect(sum.rrArtifacts!.ratio).toBeGreaterThan(0.1);
    expect(sum.hrv).toBeNull();
    expect(sum.stressIndex).toBeNull();
    expect(sum.phases.every((p) => p.hrv === null)).toBe(true);
    // the same rule applies to a measured baseline
    const base = computeBaseline(session.samples, rr, S, t + 1);
    expect(base!.rmssd).toBeUndefined();
    expect(base!.restingHr).toBe(85);
  });

  it('computes the stress index per 5-min window so it does not fall with case length (RV-10)', () => {
    const si = (durationMin: number) => {
      const out: { win: number; whole: number }[] = [];
      for (let seed = 1; seed <= 4; seed++) {
        const sim = simulateSession({ seed, durationMin, markerRate: 0 });
        const { valid } = cleanRr(sim.rr);
        out.push({
          win: summarizeSession(sim).stressIndex!,
          whole: baevskyStressIndex(sim.rr.filter((_, i) => valid[i]).map((r) => r.ms))!,
        });
      }
      const m = (k: 'win' | 'whole') => out.reduce((a, x) => a + x[k], 0) / out.length;
      return { win: m('win'), whole: m('whole') };
    };
    const short = si(30);
    const long = si(240);
    expect(long.whole / short.whole).toBeLessThan(0.75); // the old whole-session index fell by ~40 %
    expect(Math.abs(long.win / short.win - 1)).toBeLessThan(0.15);
    // a window needs ≥ 4 min of clean beats
    const twoMin: RRInterval[] = Array.from({ length: 150 }, (_, i) => ({ t: S + i * 800, ms: 780 + (i % 5) * 10 }));
    expect(windowedStressIndex(twoMin, twoMin.map(() => true))).toBeNull();
  });

  it('uses a gap rule that fits sparse watch data (RV-11)', () => {
    // 60 min of Health Connect HR at one sample per minute, +35 bpm above baseline for the middle 30 min
    const samples = Array.from({ length: 61 }, (_, i) => ({ t: S + i * 60_000, bpm: i >= 15 && i < 45 ? 105 : 70 }));
    const session = makeSession({
      startedAt: S,
      endedAt: S + 3_600_000,
      sensor: { source: 'health-connect' },
      samples,
      baseline: { startedAt: S, endedAt: S, restingHr: 70, source: 'manual' },
    });
    expect(effectiveMaxGapMs(session)).toBe(90_000);
    const sum = summarizeSession(session);
    expect(sum.maxGapMs).toBe(90_000);
    expect(sum.quality.coverage).toBeGreaterThan(0.95);
    expect(sum.quality.gapCount).toBe(0);
    expect(sum.episodes).toHaveLength(1);
    expect(sum.episodes[0]!.durationSec).toBe(29 * 60);
    expect(dataQuality(session).coverage).toBe(sum.quality.coverage);
    // chest-strap sessions keep the 5-s rule, and an explicit option always wins
    expect(effectiveMaxGapMs({ ...session, sensor: { source: 'ble' } })).toBe(5000);
    expect(effectiveMaxGapMs(session, 5000)).toBe(5000);
    expect(summarizeSession(session, { maxGapMs: 5000 }).quality.coverage).toBeLessThan(0.1);
  });

  it('reports phase HRV only for phases of at least 60 s (RV-14)', () => {
    let t = S;
    const rr: RRInterval[] = Array.from({ length: 300 }, (_, i) => {
      const ms = i % 2 === 0 ? 800 : 850;
      t += ms;
      return { t, ms };
    });
    const events: SessionEvent[] = [
      { id: 'a', t: S, type: 'phase', phase: 'dissection' },
      { id: 'b', t: S + 100_000, type: 'phase', phase: 'critical' },
      { id: 'c', t: S + 130_000, type: 'phase', phase: 'closure' },
    ];
    const sum = summarizeSession(makeSession({ startedAt: S, endedAt: t + 1, samples: steady(250, () => 75), rr, events }));
    const byPhase = Object.fromEntries(sum.phases.map((p) => [p.phase, p]));
    expect(byPhase.dissection!.hrv).not.toBeNull();
    expect(byPhase.critical!.durationSec).toBe(30);
    expect(byPhase.critical!.hrv).toBeNull(); // 30 s: ~36 beats, but too short for a reliable RMSSD
    expect(byPhase.closure!.hrv).not.toBeNull();
  });

  it('records provenance and covariates for research exports (RV-4, RV-7, RV-13)', () => {
    const sum = summarizeSession(
      fullSession({
        sensor: { source: 'ble' },
        tzOffsetMin: 660,
        postOp: { workload, sleepHours: 5.5, caffeine: true, outcome: 'minor-deviation' },
      }),
    );
    expect(sum).toMatchObject({
      sensorSource: 'ble',
      simulated: false,
      tzOffsetMin: 660,
      sleepHours: 5.5,
      caffeine: true,
      outcome: 'minor-deviation',
      maxGapMs: 5000,
      analyticsVersion: ANALYTICS_VERSION,
    });
    const bare = summarizeSession(fullSession({ postOp: { workload } }));
    expect(bare).toMatchObject({ sensorSource: 'simulated', simulated: true, sleepHours: null, caffeine: null, outcome: null });
    expect('tzOffsetMin' in bare).toBe(false);
    expect(isSyntheticSession({ sensor: { source: 'ble' }, tags: ['demo'] })).toBe(true);
    expect(isSyntheticSession({ sensor: { source: 'ble' }, tags: ['uploaded:2026-01-01T00:00:00.000Z'] })).toBe(false);

    const [header, row] = parseCsv(summariesToCsv([sum]));
    const rec = Object.fromEntries(header!.map((h, i) => [h, row![i]]));
    expect(rec).toMatchObject({
      sensor_source: 'ble',
      simulated: '0',
      tz_offset_min: '660',
      started_at: '2026-01-05T08:00:00.000Z',
      started_local: '2026-01-05T19:00:00.000+11:00',
      baseline_source: 'profile',
      baseline_duration_s: '0',
      sleep_hours: '5.5',
      caffeine: '1',
      outcome: 'minor-deviation',
      analytics_version: ANALYTICS_VERSION,
    });
    expect(Number(rec.max_hr)).toBe(sum.maxHr);
    expect(Number(rec.peak_hr)).toBe(sum.peakHr);
    // a negative offset and an older summary without the new fields
    const west = parseCsv(summariesToCsv([{ ...sum, tzOffsetMin: -210 }]));
    expect(west[1]![west[0]!.indexOf('started_local')]).toBe('2026-01-05T04:30:00.000-03:30');
    const legacy = { ...sum } as Partial<typeof sum>;
    for (const k of ['sensorSource', 'simulated', 'tzOffsetMin', 'peakHr', 'analyticsVersion'] as const) delete legacy[k];
    const old = parseCsv(summariesToCsv([legacy as typeof sum]));
    expect(['sensor_source', 'simulated', 'started_local', 'analytics_version'].map((c) => old[1]![old[0]!.indexOf(c)])).toEqual([
      '',
      '',
      '',
      '',
    ]);
  });
});
