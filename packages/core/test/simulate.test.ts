import { beforeAll, describe, expect, it } from 'vitest';
import { PHASE_ORDER } from '../src/types';
import type { HeartRateSample, LiveSimulator, RRInterval, SurgicalSession } from '../src/index';
import { createLiveSimulator, simulateCohort, simulateSession } from '../src/sim/simulate';
import { parseSession } from '../src/io/schema';
import { cleanRr, computeHrv } from '../src/analytics/rr';
import { detectGaps, hrStats } from '../src/analytics/hr';
import { derivePhases } from '../src/analytics/phases';
import { dataQuality, summarizeSession } from '../src/analytics/summary';
import { findProcedure } from '../src/catalog/procedures';
import { scoreWorkload } from '../src/instruments/tlx';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEFAULT_START = Date.UTC(2026, 0, 5, 8, 0);
const T0 = Date.UTC(2026, 2, 1, 9, 0);

/** Fails on NaN, ±Infinity or -0 anywhere in the value (JSON would silently turn them into null/0). */
function expectCleanNumbers(value: unknown, path = '$'): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error(`bad number ${String(value)} at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => expectCleanNumbers(v, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) expectCleanNumbers(v, `${path}.${k}`);
  }
}

function avg(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function meanBpm(samples: readonly HeartRateSample[]): number {
  return avg(samples.map((s) => s.bpm));
}

function meanHrDelta(s: SurgicalSession): number {
  return meanBpm(s.samples) - s.baseline!.restingHr;
}

function phaseMeanHr(s: SurgicalSession, phase: string): number {
  const seg = derivePhases(s).find((p) => p.phase === phase)!;
  return meanBpm(s.samples.filter((x) => x.t >= seg.start && x.t < seg.end));
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function seeds(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

// ---------------------------------------------------------------------------
// simulateSession
// ---------------------------------------------------------------------------

describe('simulateSession', () => {
  let base: SurgicalSession;
  beforeAll(() => {
    base = simulateSession();
  });

  it('is deterministic: the same seed gives byte-identical JSON', () => {
    expect(JSON.stringify(simulateSession())).toBe(JSON.stringify(base));
    const opts = { seed: 77, durationMin: 30, dropoutRate: 0.5, artifactRate: 0.02, markerRate: 6 };
    expect(JSON.stringify(simulateSession(opts))).toBe(JSON.stringify(simulateSession(opts)));
  });

  it('gives different sessions for different seeds', () => {
    const a = simulateSession({ seed: 1, durationMin: 20 });
    const b = simulateSession({ seed: 2, durationMin: 20 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    expect(a.id).not.toBe(b.id);
    expect(a.samples.map((s) => s.bpm)).not.toEqual(b.samples.map((s) => s.bpm));
  });

  it('matches the pinned fingerprint (reproducible across engines and releases)', () => {
    // Update deliberately (and note it in the changelog) whenever the physiology model changes.
    const s = simulateSession({ seed: 42, durationMin: 10 });
    expect(fnv1a(JSON.stringify({ samples: s.samples, rr: s.rr, events: s.events }))).toBe('12e47fb4');
    expect(s.id).toBe('a7ed2212-5d9e-403a-988b-0a2ee1bd3bf2');
  });

  it('passes parseSession and round-trips through JSON unchanged', () => {
    expect(parseSession(JSON.parse(JSON.stringify(base)))).toEqual(base);
    const variant = simulateSession({
      seed: 9,
      durationMin: 45,
      sampleIntervalMs: 5000,
      includeRr: false,
      dropoutRate: 0.5,
      withBaseline: false,
      withPostOp: false,
      trainingLevel: 'registrar',
      birthYear: 1990,
      participantCode: 'SP-014',
    });
    expect(parseSession(JSON.parse(JSON.stringify(variant)))).toEqual(variant);
  });

  it('contains no NaN, Infinity or -0', () => {
    expectCleanNumbers(base);
    expectCleanNumbers(simulateSession({ seed: 3, durationMin: 30, reactivity: 1, experience: 0, markerRate: 30 }));
  });

  it('fills session metadata', () => {
    expect(base.schemaVersion).toBe(1);
    expect(base.status).toBe('completed');
    expect(base.startedAt).toBe(DEFAULT_START);
    expect(base.endedAt).toBe(DEFAULT_START + 90 * 60000);
    expect(base.participantCode).toBe('SIM-001');
    expect(base.sensor.source).toBe('simulated');
    expect(base.tags).toContain('simulated');
    expect(base.participantSnapshot).toEqual({ restingHr: 68 });
    const catalogue = findProcedure(base.procedure.catalogId!);
    expect(catalogue?.name).toBe(base.procedure.name);
  });

  it('uses v4-format UUIDs for the session and events, all distinct', () => {
    const ids = [base.id, ...base.events.map((e) => e.id)];
    for (const id of ids) expect(id).toMatch(UUID_V4);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('copies the procedure and snapshot options without aliasing', () => {
    const procedure = { name: 'Total thyroidectomy', catalogId: 'total-thyroidectomy', complexity: 3 as const };
    const s = simulateSession({ seed: 4, durationMin: 10, procedure, trainingLevel: 'fellow', birthYear: 1985 });
    expect(s.procedure).toEqual(procedure);
    expect(s.procedure).not.toBe(procedure);
    expect(s.participantSnapshot).toEqual({ trainingLevel: 'fellow', birthYear: 1985, restingHr: 68 });
  });

  it('emits sorted 1 Hz integer samples covering [startedAt, endedAt) in a plausible range', () => {
    const { samples } = base;
    expect(samples.length).toBe(90 * 60);
    expect(samples[0]!.t).toBe(base.startedAt);
    expect(samples[samples.length - 1]!.t).toBe(base.endedAt! - 1000);
    for (let i = 1; i < samples.length; i++) expect(samples[i]!.t - samples[i - 1]!.t).toBe(1000);
    for (const s of samples) {
      expect(Number.isInteger(s.bpm)).toBe(true);
      expect(s.bpm).toBeGreaterThanOrEqual(45);
      expect(s.bpm).toBeLessThanOrEqual(190);
    }
  });

  it('keeps bpm plausible across seeds and extreme settings', () => {
    for (const seed of seeds(10)) {
      const s = simulateSession({ seed, durationMin: 60, reactivity: 1, experience: 0, markerRate: 4 });
      for (const x of s.samples) {
        expect(x.bpm).toBeGreaterThanOrEqual(45);
        expect(x.bpm).toBeLessThanOrEqual(190);
      }
    }
  });

  it('honours sampleIntervalMs', () => {
    const s = simulateSession({ seed: 5, durationMin: 30, sampleIntervalMs: 5000 });
    expect(s.samples.length).toBe(30 * 12);
    for (let i = 1; i < s.samples.length; i++) expect(s.samples[i]!.t - s.samples[i - 1]!.t).toBe(5000);
  });

  it('logs the six phases in PHASE_ORDER, covering the whole session', () => {
    const phaseEvents = base.events.filter((e) => e.type === 'phase');
    expect(phaseEvents.map((e) => (e.type === 'phase' ? e.phase : null))).toEqual([...PHASE_ORDER]);
    expect(phaseEvents[0]!.t).toBe(base.startedAt);
    const segments = derivePhases(base);
    expect(segments.map((s) => s.phase)).toEqual([...PHASE_ORDER]);
    expect(segments[0]!.start).toBe(base.startedAt);
    expect(segments[segments.length - 1]!.end).toBe(base.endedAt);
    for (let i = 1; i < segments.length; i++) expect(segments[i]!.start).toBe(segments[i - 1]!.end);
    // Shares stay within the ±20 % jitter (after renormalisation: ×[0.8/1.2, 1.2/0.8]).
    const nominal = [0.1, 0.1, 0.4, 0.15, 0.2, 0.05];
    const duration = base.endedAt! - base.startedAt;
    segments.forEach((seg, i) => {
      const share = (seg.end - seg.start) / duration;
      expect(share).toBeGreaterThanOrEqual((nominal[i]! * 0.8) / 1.2 - 1e-9);
      expect(share).toBeLessThanOrEqual((nominal[i]! * 1.2) / 0.8 + 1e-9);
    });
  });

  it('keeps events sorted and markers inside the session', () => {
    for (let i = 1; i < base.events.length; i++) {
      expect(base.events[i]!.t).toBeGreaterThanOrEqual(base.events[i - 1]!.t);
    }
    const busy = simulateSession({ seed: 6, markerRate: 20 });
    const markers = busy.events.filter((e) => e.type === 'marker');
    expect(markers.length).toBeGreaterThan(15); // Poisson, mean 30
    expect(markers.length).toBeLessThan(50);
    for (const m of markers) {
      expect(m.t).toBeGreaterThanOrEqual(busy.startedAt);
      expect(m.t).toBeLessThan(busy.endedAt!);
    }
    expect(simulateSession({ seed: 6, markerRate: 0 }).events.filter((e) => e.type === 'marker')).toEqual([]);
  });

  it('has a higher critical-phase than dissection-phase mean HR on average over 10 seeds', () => {
    const diffs = seeds(10).map((seed) => {
      const s = simulateSession({ seed });
      return phaseMeanHr(s, 'critical') - phaseMeanHr(s, 'dissection');
    });
    expect(avg(diffs)).toBeGreaterThan(5); // model: (22 − 10)·gain = 10.2 bpm at the defaults
    expect(diffs.filter((d) => d > 0).length).toBeGreaterThanOrEqual(8);
  });

  it('stores a measured 5-minute pre-op baseline close to the configured resting HR', () => {
    const b = base.baseline!;
    expect(b.source).toBe('measured');
    expect(b.startedAt).toBe(base.startedAt - 5 * 60000);
    expect(b.endedAt).toBe(base.startedAt);
    expect(Math.abs(b.restingHr - 68)).toBeLessThan(5);
    expect(b.rmssd).toBeGreaterThan(10);
    expect(b.sdnn).toBeGreaterThan(5);
    for (const seed of seeds(10)) {
      for (const restingHr of [52, 68, 85]) {
        const s = simulateSession({ seed, restingHr, durationMin: 5, withPostOp: false });
        expect(Math.abs(s.baseline!.restingHr - restingHr)).toBeLessThan(5);
      }
    }
    // Baseline data is never part of the session arrays.
    expect(base.samples.every((s) => s.t >= base.startedAt)).toBe(true);
    expect(base.rr.every((r) => r.t >= base.startedAt)).toBe(true);
  });

  it('omits baseline HRV when RR is not included', () => {
    const s = simulateSession({ seed: 2, durationMin: 10, includeRr: false });
    expect(s.rr).toEqual([]);
    expect(s.baseline?.restingHr).toBeDefined();
    expect(s.baseline?.rmssd).toBeUndefined();
  });

  it('has RR intervals whose mean matches 60000 / mean HR', () => {
    const hr = hrStats(base.samples)!;
    const { hrv } = computeHrv(base.rr);
    expect(hrv).not.toBeNull();
    expect(Math.abs(hrv!.meanRr - 60000 / hr.mean) / (60000 / hr.mean)).toBeLessThan(0.02);
    expect(Math.abs(hrv!.meanHr - hr.mean)).toBeLessThan(2);
    // About one interval per beat.
    const expectedBeats = base.samples.reduce((acc, s) => acc + s.bpm / 60, 0);
    expect(Math.abs(base.rr.length - expectedBeats) / expectedBeats).toBeLessThan(0.03);
  });

  it('delivers RR in beat order on the 1-second notification grid at BLE resolution', () => {
    let prev = -Infinity;
    for (const r of base.rr) {
      expect((r.t - base.startedAt) % 1000).toBe(0);
      expect(r.t).toBeGreaterThanOrEqual(prev);
      prev = r.t;
      expect(r.ms).toBeGreaterThan(250);
      expect(r.ms).toBeLessThan(5000);
      const raw = Math.round((r.ms * 1024) / 1000);
      expect(Math.round((raw * 1000 * 1000) / 1024) / 1000).toBe(r.ms);
    }
  });

  it('produces roughly the expected number of artefacts, as detected by cleanRr', () => {
    const clean = simulateSession({ seed: 11, artifactRate: 0 });
    expect(cleanRr(clean.rr).report.ratio).toBeLessThan(0.002);

    const rate = 0.02;
    const ratios = [11, 12, 13].map((seed) => cleanRr(simulateSession({ seed, artifactRate: rate }).rr).report.ratio);
    // A missed beat is flagged once, an ectopic beat twice (premature + compensatory) → ≈ 1.5 flags per artefact.
    const expected = 1.5 * rate;
    for (const ratio of ratios) {
      expect(ratio).toBeGreaterThan(0.65 * expected);
      expect(ratio).toBeLessThan(1.35 * expected);
    }
    // Artefacts live in the RR stream only; the HR trace is unchanged.
    expect(simulateSession({ seed: 11, artifactRate: rate }).samples).toEqual(clean.samples);
  });

  it('creates 5–40 s data gaps at dropoutRate', () => {
    expect(detectGaps(base.samples)).toEqual([]);
    const s = simulateSession({ seed: 8, dropoutRate: 1 });
    const gaps = detectGaps(s.samples);
    expect(gaps.length).toBeGreaterThan(20); // ≈ 90 starts expected
    for (const g of gaps) {
      expect(g.durationMs).toBeGreaterThanOrEqual(6000);
      expect(g.durationMs).toBeLessThanOrEqual(82000); // two back-to-back gaps at most
      expect(s.rr.some((r) => r.t > g.start && r.t < g.end)).toBe(false);
    }
    expect(dataQuality(s).coverage).toBeLessThan(0.9);
    expect(dataQuality(base).coverage).toBeGreaterThan(0.99);
    // Dropouts start a new HRV run, so HRV is still computed.
    expect(computeHrv(s.rr).hrv).not.toBeNull();
  });

  it('gives a lower mean HR delta with higher experience', () => {
    const lo: number[] = [];
    const hi: number[] = [];
    for (const seed of seeds(10)) {
      lo.push(meanHrDelta(simulateSession({ seed, experience: 0.1 })));
      hi.push(meanHrDelta(simulateSession({ seed, experience: 0.9 })));
    }
    expect(avg(hi)).toBeLessThan(avg(lo) - 1.5); // model: Δgain 0.24 × ≈ 10.5 bpm mean offset (paired seeds)
    hi.forEach((h, i) => expect(h).toBeLessThan(lo[i]!));
  });

  it('gives a higher mean HR delta with higher reactivity', () => {
    const lo = seeds(5).map((seed) => meanHrDelta(simulateSession({ seed, reactivity: 0 })));
    const hi = seeds(5).map((seed) => meanHrDelta(simulateSession({ seed, reactivity: 1 })));
    expect(avg(hi)).toBeGreaterThan(avg(lo) + 3);
  });

  it('writes a valid SURG-TLX post-op report correlated with physiology', () => {
    const postOp = base.postOp!;
    const workload = postOp.workload!;
    expect(workload.instrument).toBe('surg-tlx');
    expect(workload.completedAt).toBeGreaterThan(base.endedAt!);
    for (const r of Object.values(workload.ratings)) {
      expect(r % 5).toBe(0);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(100);
    }
    const weights = Object.values(workload.weights!);
    expect(weights.reduce((a, b) => a + b, 0)).toBe(15);
    for (const w of weights) expect(Number.isInteger(w) && w >= 0 && w <= 5).toBe(true);
    expect(scoreWorkload(workload).weighted).not.toBeNull();
    for (const v of [postOp.performance!, postOp.perceivedStress!]) {
      expect(Number.isInteger(v) && v >= 0 && v <= 10).toBe(true);
    }

    const calm = seeds(12).map((seed) => simulateSession({ seed, durationMin: 30, reactivity: 0, experience: 1 }));
    const stressed = seeds(12).map((seed) => simulateSession({ seed, durationMin: 30, reactivity: 1, experience: 0 }));
    const raw = (xs: SurgicalSession[]) => avg(xs.map((s) => scoreWorkload(s.postOp!.workload!).raw));
    const stress = (xs: SurgicalSession[]) => avg(xs.map((s) => s.postOp!.perceivedStress!));
    expect(raw(stressed)).toBeGreaterThan(raw(calm) + 10);
    expect(stress(stressed)).toBeGreaterThan(stress(calm));
  });

  it('keeps the physiology independent of output-only options', () => {
    const s = simulateSession({ seed: 21, durationMin: 20 });
    const noRr = simulateSession({ seed: 21, durationMin: 20, includeRr: false });
    const bare = simulateSession({ seed: 21, durationMin: 20, withBaseline: false, withPostOp: false });
    expect(noRr.samples).toEqual(s.samples);
    expect(noRr.events).toEqual(s.events);
    expect(noRr.baseline?.restingHr).toBe(s.baseline?.restingHr);
    expect(bare.samples).toEqual(s.samples);
    expect(bare.rr).toEqual(s.rr);
    expect(bare.baseline).toBeUndefined();
    expect(bare.postOp).toBeUndefined();
  });

  it('feeds the analytics pipeline (summarizeSession)', () => {
    const summary = summarizeSession(base);
    expect(summary.hr).not.toBeNull();
    expect(summary.hrv).not.toBeNull();
    expect(summary.stressIndex).not.toBeNull();
    expect(summary.baseline?.source).toBe('measured');
    expect(summary.meanHrDelta).toBeGreaterThan(0);
    expect(summary.phases.map((p) => p.phase)).toEqual([...PHASE_ORDER]);
    for (const p of summary.phases) expect(p.hrv).not.toBeNull();
    expect(summary.quality.coverage).toBeGreaterThan(0.99);
    expect(summary.rrArtifacts!.ratio).toBeLessThan(0.02);
    expect(summary.workload?.weighted).not.toBeNull();
    expectCleanNumbers(summary);
  });

  it('rejects out-of-range options with RangeError', () => {
    const bad: Parameters<typeof simulateSession>[0][] = [
      { durationMin: 0 },
      { durationMin: -5 },
      { durationMin: Number.NaN },
      { durationMin: 2000 },
      { restingHr: 10 },
      { restingHr: Number.POSITIVE_INFINITY },
      { reactivity: 1.5 },
      { experience: -0.1 },
      { sampleIntervalMs: 0 },
      { artifactRate: 0.9 },
      { dropoutRate: -1 },
      { markerRate: Number.NaN },
      { seed: Number.NaN },
      { startedAt: Number.NaN },
      { participantCode: '' },
      { birthYear: 1990.5 },
    ];
    for (const opts of bad) expect(() => simulateSession(opts)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// simulateCohort
// ---------------------------------------------------------------------------

describe('simulateCohort', () => {
  let cohort: ReturnType<typeof simulateCohort>;
  let json: string;
  beforeAll(() => {
    cohort = simulateCohort();
    json = JSON.stringify(cohort);
  });

  it('has the default size and stays under ~25 MB of JSON', () => {
    expect(cohort.participants.length).toBe(8);
    expect(cohort.sessions.length).toBe(96);
    expect(json.length).toBeLessThan(25000000);
  });

  it('honours custom sizes', () => {
    const small = simulateCohort({ participants: 3, sessionsPerParticipant: 4 });
    expect(small.participants.length).toBe(3);
    expect(small.sessions.length).toBe(12);
    expect(simulateCohort({ participants: 0 })).toEqual({ participants: [], sessions: [] });
    expect(simulateCohort({ sessionsPerParticipant: 0 }).sessions).toEqual([]);
  });

  it('is deterministic per seed', () => {
    const opts = { seed: 5, participants: 2, sessionsPerParticipant: 3 };
    expect(JSON.stringify(simulateCohort(opts))).toBe(JSON.stringify(simulateCohort(opts)));
    expect(JSON.stringify(simulateCohort({ ...opts, seed: 6 }))).not.toBe(JSON.stringify(simulateCohort(opts)));
    expect(JSON.stringify(simulateCohort())).toBe(json);
  });

  it('produces sessions that pass parseSession and contain no NaN/Infinity', () => {
    for (const s of cohort.sessions) {
      expect(parseSession(JSON.parse(JSON.stringify(s)))).toEqual(s);
      expectCleanNumbers(s);
    }
    expectCleanNumbers(cohort.participants);
  });

  it('mixes training levels and draws procedures from the catalogue', () => {
    const levels = new Set(cohort.participants.map((p) => p.trainingLevel));
    expect(levels.has('consultant')).toBe(true);
    expect(levels.size).toBeGreaterThanOrEqual(4);
    const byCode = new Map(cohort.participants.map((p) => [p.code, p]));
    for (const s of cohort.sessions) {
      const participant = byCode.get(s.participantCode)!;
      expect(participant).toBeDefined();
      expect(s.participantSnapshot?.trainingLevel).toBe(participant.trainingLevel);
      expect(s.participantSnapshot?.restingHr).toBe(participant.restingHr);
      const entry = findProcedure(s.procedure.catalogId!);
      expect(entry?.name).toBe(s.procedure.name);
      expect(entry?.specialty).toBe(participant.specialty);
      expect(s.baseline?.source).toBe('measured');
      expect(s.postOp?.workload?.instrument).toBe('surg-tlx');
    }
    for (const p of cohort.participants) {
      expect(p.code).toMatch(/^SIM-\d{3}$/);
      expect(p.consent?.version).toBeDefined();
    }
  });

  it('is chronological, with sessions spaced per participant, 5 s samples and RR every 3rd session', () => {
    for (let i = 1; i < cohort.sessions.length; i++) {
      expect(cohort.sessions[i]!.startedAt).toBeGreaterThanOrEqual(cohort.sessions[i - 1]!.startedAt);
    }
    for (const p of cohort.participants) {
      const own = cohort.sessions.filter((s) => s.participantCode === p.code);
      expect(own.length).toBe(12);
      own.forEach((s, k) => {
        expect(s.rr.length > 0).toBe(k % 3 === 0);
        for (let i = 1; i < s.samples.length; i++) expect((s.samples[i]!.t - s.samples[i - 1]!.t) % 5000).toBe(0);
        if (k > 0) {
          const gapDays = (s.startedAt - own[k - 1]!.startedAt) / 86400000;
          expect(gapDays).toBeGreaterThan(6.5);
          expect(gapDays).toBeLessThan(7.5);
        }
      });
    }
  });

  it("shows a learning curve: trainees' later sessions have a lower mean HR delta", () => {
    const early: number[] = [];
    const late: number[] = [];
    for (const p of cohort.participants.filter((x) => x.trainingLevel !== 'consultant')) {
      const deltas = cohort.sessions.filter((s) => s.participantCode === p.code).map(meanHrDelta);
      early.push(avg(deltas.slice(0, 4)));
      late.push(avg(deltas.slice(-4)));
    }
    expect(avg(late)).toBeLessThan(avg(early) - 1);
    expect(late.filter((l, i) => l < early[i]!).length).toBeGreaterThanOrEqual(late.length - 1);
  });

  it('gives consultants a smaller HR response than trainees', () => {
    const delta = (consultant: boolean) =>
      avg(
        cohort.sessions
          .filter((s) => (s.participantSnapshot?.trainingLevel === 'consultant') === consultant)
          .map(meanHrDelta),
      );
    expect(delta(true)).toBeLessThan(delta(false));
  });

  it('rejects invalid options with RangeError', () => {
    expect(() => simulateCohort({ participants: -1 })).toThrow(RangeError);
    expect(() => simulateCohort({ participants: 1.5 })).toThrow(RangeError);
    expect(() => simulateCohort({ sessionsPerParticipant: Number.NaN })).toThrow(RangeError);
    expect(() => simulateCohort({ spacingDays: -1 })).toThrow(RangeError);
    expect(() => simulateCohort({ seed: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// createLiveSimulator
// ---------------------------------------------------------------------------

interface Collected {
  samples: HeartRateSample[];
  rr: RRInterval[];
}

/** Ticks once per second for `n` seconds after `from`; returns everything produced. */
function runSeconds(sim: LiveSimulator, from: number, n: number): Collected {
  const out: Collected = { samples: [], rr: [] };
  for (let i = 1; i <= n; i++) {
    const r = sim.tick(from + i * 1000);
    out.samples.push(...r.samples);
    out.rr.push(...r.rr);
  }
  return out;
}

describe('createLiveSimulator', () => {
  it('produces one sample per elapsed second with monotonic t, plus RR beats', () => {
    const sim = createLiveSimulator({ seed: 3, startedAt: T0 });
    let lastSampleT = T0;
    let lastRrT = -Infinity;
    const all: Collected = { samples: [], rr: [] };
    for (let i = 1; i <= 300; i++) {
      const now = T0 + i * 1000;
      const { samples, rr } = sim.tick(now);
      expect(samples.length).toBe(1);
      expect(samples[0]!.t).toBe(now);
      expect(samples[0]!.t).toBeGreaterThan(lastSampleT);
      lastSampleT = samples[0]!.t;
      for (const r of rr) {
        expect(r.t).toBeGreaterThanOrEqual(lastRrT);
        expect(r.t).toBeGreaterThan(now - 1000);
        expect(r.t).toBeLessThanOrEqual(now);
        expect(r.ms).toBeGreaterThan(250);
        expect(r.ms).toBeLessThan(5000);
        lastRrT = r.t;
      }
      all.samples.push(...samples);
      all.rr.push(...rr);
    }
    for (const s of all.samples) {
      expect(Number.isInteger(s.bpm)).toBe(true);
      expect(s.bpm).toBeGreaterThanOrEqual(45);
      expect(s.bpm).toBeLessThanOrEqual(190);
    }
    const expectedBeats = (meanBpm(all.samples) * 300) / 60;
    expect(Math.abs(all.rr.length - expectedBeats) / expectedBeats).toBeLessThan(0.1);
    expectCleanNumbers(all);
  });

  it('handles irregular tick intervals without duplicating or skipping samples', () => {
    const sim = createLiveSimulator({ seed: 4, startedAt: T0 });
    const steps = [700, 1300, 950, 1600, 400, 1050, 2500, 30];
    let now = T0;
    const jittered: Collected = { samples: [], rr: [] };
    for (let i = 0; i < 400; i++) {
      now += steps[i % steps.length]!;
      const out = sim.tick(now);
      jittered.samples.push(...out.samples);
      jittered.rr.push(...out.rr);
    }
    const seconds = Math.floor((now - T0) / 1000);
    expect(jittered.samples.length).toBe(seconds);
    jittered.samples.forEach((s, k) => expect(s.t).toBe(T0 + (k + 1) * 1000));
    // Timer jitter differs between platforms; without interactions the stream must not depend on it.
    const regular = runSeconds(createLiveSimulator({ seed: 4, startedAt: T0 }), T0, seconds);
    expect(jittered.samples).toEqual(regular.samples);
    expect(jittered.rr).toEqual(regular.rr.filter((r) => r.t <= now));
  });

  it('defaults startedAt to the first tick', () => {
    const lazy = createLiveSimulator({ seed: 5 });
    expect(lazy.tick(T0)).toEqual({ samples: [], rr: [] });
    const eager = createLiveSimulator({ seed: 5, startedAt: T0 });
    expect(runSeconds(lazy, T0, 60)).toEqual(runSeconds(eager, T0, 60));
  });

  it('is deterministic for the same seed and tick sequence', () => {
    const a = runSeconds(createLiveSimulator({ seed: 8, startedAt: T0 }), T0, 120);
    const b = runSeconds(createLiveSimulator({ seed: 8, startedAt: T0 }), T0, 120);
    const c = runSeconds(createLiveSimulator({ seed: 9, startedAt: T0 }), T0, 120);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it("setPhase('critical') raises HR gradually over the next minutes", () => {
    for (const seed of [1, 2, 3]) {
      const control = createLiveSimulator({ seed, startedAt: T0 });
      const sim = createLiveSimulator({ seed, startedAt: T0 });
      runSeconds(control, T0, 120);
      runSeconds(sim, T0, 120);
      sim.setPhase('critical');
      const c = runSeconds(control, T0 + 120000, 240);
      const s = runSeconds(sim, T0 + 120000, 240);
      const early = meanBpm(s.samples.slice(0, 5)) - meanBpm(c.samples.slice(0, 5));
      const late = meanBpm(s.samples.slice(-60)) - meanBpm(c.samples.slice(-60));
      expect(early).toBeLessThan(6); // first-order lag, τ = 45 s
      expect(late).toBeGreaterThan(12); // 22·gain(0.85) ≈ 18.7 bpm at steady state
    }
  });

  it("trigger('complication') raises HR within about a minute", () => {
    for (const seed of [1, 2, 3]) {
      const control = createLiveSimulator({ seed, startedAt: T0 });
      const sim = createLiveSimulator({ seed, startedAt: T0 });
      runSeconds(control, T0, 120);
      runSeconds(sim, T0, 120);
      sim.trigger('complication');
      const c = runSeconds(control, T0 + 120000, 60);
      const s = runSeconds(sim, T0 + 120000, 60);
      expect(meanBpm(s.samples) - meanBpm(c.samples)).toBeGreaterThan(6);
      expect(meanBpm(s.samples.slice(0, 15)) - meanBpm(c.samples.slice(0, 15))).toBeGreaterThan(8);
    }
  });

  it('gives a smaller response to an interruption than to a complication, and none to a teaching note', () => {
    const run = (marker?: 'complication' | 'interruption' | 'teaching' | 'note') => {
      const sim = createLiveSimulator({ seed: 12, startedAt: T0 });
      runSeconds(sim, T0, 60);
      if (marker) sim.trigger(marker);
      return runSeconds(sim, T0 + 60000, 60);
    };
    const none = meanBpm(run().samples);
    const interruption = meanBpm(run('interruption').samples);
    const complication = meanBpm(run('complication').samples);
    expect(interruption).toBeGreaterThan(none + 2);
    expect(complication).toBeGreaterThan(interruption + 3);
    expect(run('teaching')).toEqual(run());
    expect(run('note')).toEqual(run());
  });

  it('accepts setPhase/trigger before the first tick', () => {
    const control = createLiveSimulator({ seed: 6 });
    const sim = createLiveSimulator({ seed: 6 });
    sim.trigger('complication');
    sim.setPhase('critical');
    control.tick(T0);
    sim.tick(T0);
    const c = runSeconds(control, T0, 120);
    const s = runSeconds(sim, T0, 120);
    expect(meanBpm(s.samples.slice(0, 30)) - meanBpm(c.samples.slice(0, 30))).toBeGreaterThan(6);
  });

  it('returns empty arrays for a tick earlier than (or equal to) the last one, without changing state', () => {
    const control = createLiveSimulator({ seed: 7, startedAt: T0 });
    const sim = createLiveSimulator({ seed: 7, startedAt: T0 });
    const a1 = runSeconds(control, T0, 30);
    const b1 = runSeconds(sim, T0, 30);
    expect(sim.tick(T0 + 10000)).toEqual({ samples: [], rr: [] });
    expect(sim.tick(T0 + 30000)).toEqual({ samples: [], rr: [] });
    expect(sim.tick(T0 - 5000)).toEqual({ samples: [], rr: [] });
    expect(sim.tick(Number.NaN)).toEqual({ samples: [], rr: [] });
    const a2 = runSeconds(control, T0 + 30000, 30);
    const b2 = runSeconds(sim, T0 + 30000, 30);
    expect(b1).toEqual(a1);
    expect(b2).toEqual(a2);
  });

  it('caps catch-up after a long pause at one hour and then continues normally', () => {
    const sim = createLiveSimulator({ seed: 10, startedAt: T0 });
    runSeconds(sim, T0, 60);
    const now = T0 + 3 * 3600000;
    const { samples, rr } = sim.tick(now);
    expect(samples.length).toBe(3600);
    expect(samples[0]!.t).toBe(now - 3600000 + 1000);
    expect(samples[samples.length - 1]!.t).toBe(now);
    expect(rr.every((r) => r.t > now - 3600000 && r.t <= now)).toBe(true);
    expect(rr.length).toBeGreaterThan(3000);
    const next = sim.tick(now + 1000);
    expect(next.samples.map((s) => s.t)).toEqual([now + 1000]);
  });

  it('stays plausible under stacked stressors', () => {
    const sim = createLiveSimulator({ seed: 2, startedAt: T0, reactivity: 1, experience: 0 });
    sim.setPhase('critical');
    runSeconds(sim, T0, 180);
    sim.trigger('complication');
    sim.trigger('complication');
    const s = runSeconds(sim, T0 + 180000, 300);
    for (const x of s.samples) {
      expect(x.bpm).toBeGreaterThanOrEqual(45);
      expect(x.bpm).toBeLessThanOrEqual(190);
    }
  });

  it('rejects out-of-range options with RangeError', () => {
    expect(() => createLiveSimulator({ restingHr: 0 })).toThrow(RangeError);
    expect(() => createLiveSimulator({ reactivity: 2 })).toThrow(RangeError);
    expect(() => createLiveSimulator({ seed: Number.NaN })).toThrow(RangeError);
    expect(() => createLiveSimulator({ startedAt: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });
});
