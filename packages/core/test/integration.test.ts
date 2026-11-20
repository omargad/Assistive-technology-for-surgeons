/**
 * End-to-end integration of @surgeonpulse/core through the public barrel, exercising the paths the mobile app,
 * the research dashboard and the ingest server share:
 *
 *   simulateSession → summarizeSession → summariesToCsv / samplesToCsv / rrToCsv / eventsToCsv
 *                   → createExportBundle → JSON.stringify → parseImport → summarizeSession (identical)
 *   deidentify (timeShiftMs)  → identical metrics, every time shifted by the same offset
 *   simulateCohort → summaries → aggregateMetric / metricSeries / generateInsights (sane, never NaN/Infinity)
 *
 * Cross-platform guards: the whole pipeline runs with the host clock and Math.random disabled and with deeply
 * frozen inputs, so results depend only on the data (identical on Hermes, browsers and Node).
 */
import { describe, expect, it } from 'vitest';
import {
  MARKER_KINDS,
  METRICS,
  PHASE_ORDER,
  SUMMARY_CSV_COLUMNS,
  aggregateMetric,
  createExportBundle,
  deidentifyBundle,
  deidentifySession,
  derivePhases,
  eventsToCsv,
  findProcedure,
  generateInsights,
  metricSeries,
  metricValue,
  parseCsv,
  parseImport,
  parseSession,
  phaseAt,
  rrToCsv,
  samplesToCsv,
  simulateCohort,
  simulateSession,
  summariesToCsv,
  summarizeSession,
} from '../src';
import type { GroupKey, MetricKey, ParticipantProfile, SessionSummary, SurgicalSession } from '../src';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deep scan for non-finite numbers (NaN, ±Infinity) anywhere in a value. Returns the JSON-ish path of every
 * offending number, so a failure message points straight at the culprit.
 */
function findNonFinite(value: unknown, path = '$', seen = new Set<object>(), out: string[] = []): string[] {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(`${path} = ${String(value)}`);
    return out;
  }
  if (value === null || typeof value !== 'object') return out;
  if (seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((v, i) => findNonFinite(v, `${path}[${i}]`, seen, out));
  } else {
    for (const [k, v] of Object.entries(value)) findNonFinite(v, `${path}.${k}`, seen, out);
  }
  return out;
}

/** Strings that betray a non-finite or missing value leaking into user-facing or exported text. */
const BAD_TEXT = /\bNaN\b|\bInfinity\b|\bundefined\b|\[object /;

/** JSON with object keys sorted, so two structurally equal values give the same text regardless of key order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
    return sorted;
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/**
 * Runs `fn` with the host clock (`Date.now()`, `new Date()`) and `Math.random` disabled. Synchronous on purpose:
 * nothing else can run while the globals are replaced. Proves the pipeline is a pure function of its inputs.
 */
function withoutHostEntropy<T>(fn: () => T): T {
  const g = globalThis as { Date: DateConstructor };
  const RealDate = g.Date;
  const realRandom = Math.random;
  const fail = (what: string): never => {
    throw new Error(`${what} must not be called by @surgeonpulse/core analytics/io/sim`);
  };
  g.Date = new Proxy(RealDate, {
    construct(target, args: unknown[], newTarget) {
      if (args.length === 0) fail('new Date()');
      return Reflect.construct(target, args, newTarget) as object;
    },
    apply() {
      return fail('Date()');
    },
    get(target, prop, receiver) {
      if (prop === 'now') return () => fail('Date.now()');
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  Math.random = () => fail('Math.random()');
  try {
    return fn();
  } finally {
    g.Date = RealDate;
    Math.random = realRandom;
  }
}

/** The summary we expect after every timestamp in the session moved by `dt` ms: same metrics, shifted times. */
function shiftSummaryTimes(s: SessionSummary, dt: number): SessionSummary {
  return {
    ...s,
    startedAt: s.startedAt + dt,
    endedAt: s.endedAt + dt,
    baseline:
      s.baseline === null
        ? null
        : { ...s.baseline, startedAt: s.baseline.startedAt + dt, endedAt: s.baseline.endedAt + dt },
    phases: s.phases.map((p) => ({ ...p, start: p.start + dt, end: p.end + dt })),
    episodes: s.episodes.map((e) => ({ ...e, start: e.start + dt, end: e.end + dt, peakT: e.peakT + dt })),
  };
}

/** Header + data rows of a CSV export, with a lookup by column name. */
function readCsv(text: string): { header: string[]; rows: string[][]; col: (row: string[], name: string) => string } {
  const [header, ...rows] = parseCsv(text);
  if (header === undefined) throw new Error('CSV has no header row');
  const index = new Map(header.map((h, i) => [h, i]));
  return {
    header,
    rows,
    col(row, name) {
      const i = index.get(name);
      if (i === undefined) throw new Error(`CSV has no column ${name}`);
      return row[i] ?? '';
    },
  };
}

function expectCleanCsv(text: string, columns: number): void {
  expect(text.endsWith('\r\n')).toBe(true);
  expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/); // CRLF only (no free-text fields with line breaks here)
  const rows = parseCsv(text);
  for (const row of rows) {
    expect(row).toHaveLength(columns);
    for (const cell of row) expect(cell).not.toMatch(BAD_TEXT);
  }
}

const DAY_MS = 86_400_000;
const STARTED_AT = Date.UTC(2026, 2, 9, 7, 30); // a Monday morning list, 9 March 2026 (UTC)
const BIRTH_YEAR = 1985;

/** A reactive, inexperienced surgeon on a busy case: guarantees phases, markers, episodes, RR and dropouts. */
function busySession(): SurgicalSession {
  return simulateSession({
    seed: 2026,
    participantCode: 'SP-014',
    startedAt: STARTED_AT,
    durationMin: 80,
    reactivity: 0.9,
    experience: 0.15,
    markerRate: 6,
    dropoutRate: 0.15,
    artifactRate: 0.01,
    trainingLevel: 'registrar',
    birthYear: BIRTH_YEAR,
  });
}

const PARTICIPANT: ParticipantProfile = {
  code: 'SP-014',
  trainingLevel: 'registrar',
  specialty: 'General surgery',
  birthYear: BIRTH_YEAR,
  consent: { version: 'PICF-1.2', givenAt: STARTED_AT - 30 * DAY_MS },
};

// ---------------------------------------------------------------------------
// Scanner self-test (a broken scanner would let every NaN check pass vacuously)
// ---------------------------------------------------------------------------

describe('findNonFinite (test helper)', () => {
  it('reports NaN and ±Infinity at any depth, and nothing for finite data', () => {
    expect(findNonFinite({ a: 1, b: [0, -0, 1e308], c: { d: null, e: 'NaN' } })).toEqual([]);
    expect(
      findNonFinite({ a: Number.NaN, b: [1, { c: Number.POSITIVE_INFINITY }], d: { e: [Number.NEGATIVE_INFINITY] } }),
    ).toEqual(['$.a = NaN', '$.b[1].c = Infinity', '$.d.e[0] = -Infinity']);
  });

  it('handles shared and cyclic references', () => {
    const shared = { x: Number.NaN };
    const cyclic: { self?: unknown; v: number } = { v: 1 };
    cyclic.self = cyclic;
    expect(findNonFinite({ a: shared, b: shared, cyclic })).toEqual(['$.a.x = NaN']);
  });
});

// ---------------------------------------------------------------------------
// One session: simulate → summarise → CSV → bundle → JSON → import → summarise
// ---------------------------------------------------------------------------

describe('single session pipeline', () => {
  const session = deepFreeze(busySession());
  const summary = withoutHostEntropy(() => summarizeSession(session));

  it('simulator output is a valid, already-sorted session', () => {
    expect(parseSession(session)).toStrictEqual(session);
    expect(session.rr.length).toBeGreaterThan(1000);
    expect(session.events.some((e) => e.type === 'marker')).toBe(true);
  });

  it('summary is physiologically sane and contains no NaN/Infinity', () => {
    expect(findNonFinite(summary)).toEqual([]);

    expect(summary.sessionId).toBe(session.id);
    expect(summary.durationSec).toBe(80 * 60);
    expect(summary.hr).not.toBeNull();
    expect(summary.hr!.count).toBe(session.samples.length);
    expect(summary.hr!.min).toBeLessThanOrEqual(summary.hr!.median);
    expect(summary.hr!.median).toBeLessThanOrEqual(summary.hr!.p95);
    expect(summary.hr!.p95).toBeLessThanOrEqual(summary.hr!.max);

    // HRV (Task Force of ESC/NASPE 1996) from clean RR, plus artefact screening and the Baevsky stress index.
    expect(summary.hrv).not.toBeNull();
    expect(summary.hrv!.rmssd).toBeGreaterThan(0);
    expect(summary.hrv!.meanHr).toBeGreaterThan(40);
    expect(summary.hrv!.meanHr).toBeLessThan(200);
    expect(summary.rrArtifacts!.total).toBe(session.rr.length);
    expect(summary.rrArtifacts!.removed).toBeGreaterThan(0);
    expect(summary.stressIndex).toBeGreaterThan(0);

    // Measured baseline; HR rises above it during the case.
    expect(summary.baseline?.source).toBe('measured');
    expect(summary.meanHrDelta).toBeGreaterThan(0);
    expect(summary.peakHrDelta!).toBeGreaterThan(summary.meanHrDelta!);

    // Tanaka (2001) max HR from birth year at the UTC year of the session: 208 − 0.7·41 = 179.3 → 179.
    expect(summary.maxHr).toBe(179);
    expect(summary.highIntensityFraction).toBeGreaterThanOrEqual(0);
    expect(summary.highIntensityFraction).toBeLessThanOrEqual(1);

    // Baseline-relative zones; fractions sum to 1.
    expect(summary.zones.map((z) => z.id)).toEqual(['rest', 'elevated', 'high', 'very-high']);
    expect(summary.zones.reduce((a, z) => a + z.fraction, 0)).toBeCloseTo(1, 12);

    // The simulator logs all six phases, in operative order, covering the whole session.
    expect(summary.phases.map((p) => p.phase)).toEqual([...PHASE_ORDER]);
    expect(summary.phases[0]!.start).toBe(session.startedAt);
    expect(summary.phases[summary.phases.length - 1]!.end).toBe(summary.endedAt);
    expect(summary.phases.reduce((a, p) => a + p.durationSec, 0)).toBeCloseTo(summary.durationSec, 9);
    for (const p of summary.phases) expect(p.meanHrDelta).not.toBeNull();

    // Stress episodes are well-formed and annotated.
    expect(summary.episodes.length).toBeGreaterThan(0);
    for (const e of summary.episodes) {
      expect(e.start).toBeLessThanOrEqual(e.peakT);
      expect(e.peakT).toBeLessThanOrEqual(e.end);
      expect(e.durationSec).toBeGreaterThanOrEqual(60);
      expect(e.phase).toBeDefined();
      expect(e.peakBpm).toBeGreaterThanOrEqual(e.meanBpm);
    }

    const markerTotal = session.events.filter((e) => e.type === 'marker').length;
    expect(Object.values(summary.markerCounts).reduce((a, n) => a + n, 0)).toBe(markerTotal);
    for (const kind of Object.keys(summary.markerCounts)) expect(MARKER_KINDS).toContain(kind);

    // SURG-TLX (Wilson et al. 2011) with valid pairwise weights → weighted score available.
    expect(summary.workload?.instrument).toBe('surg-tlx');
    expect(summary.workload!.weighted).not.toBeNull();
    expect(summary.performance).not.toBeNull();

    expect(summary.quality.coverage).toBeGreaterThan(0.5);
    expect(summary.quality.coverage).toBeLessThanOrEqual(1);
    expect(summary.quality.gapCount).toBeGreaterThan(0); // dropouts were simulated
    expect(summary.quality.rrArtifactRatio).toBe(summary.rrArtifacts!.ratio);
  });

  it('summariesToCsv writes one clean wide row matching the summary', () => {
    const csv = summariesToCsv([summary]);
    expectCleanCsv(csv, SUMMARY_CSV_COLUMNS.length);
    const { header, rows, col } = readCsv(csv);
    expect(header).toEqual([...SUMMARY_CSV_COLUMNS]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(col(row, 'session_id')).toBe(summary.sessionId);
    expect(col(row, 'participant_code')).toBe('SP-014');
    expect(col(row, 'started_at')).toBe('2026-03-09T07:30:00.000Z');
    // Numbers survive the text round trip exactly (String(n) is the shortest round-tripping form).
    expect(Number(col(row, 'duration_min'))).toBe(80);
    expect(Number(col(row, 'hr_mean'))).toBe(summary.hr!.mean);
    expect(Number(col(row, 'rmssd'))).toBe(summary.hrv!.rmssd);
    expect(Number(col(row, 'mean_hr_delta'))).toBe(summary.meanHrDelta);
    expect(Number(col(row, 'episode_count'))).toBe(summary.episodes.length);
    expect(Number(col(row, 'coverage_pct'))).toBe(summary.quality.coverage * 100);
    const critical = summary.phases.find((p) => p.phase === 'critical')!;
    expect(Number(col(row, 'critical_duration_s'))).toBe(critical.durationSec);
    expect(Number(col(row, 'critical_hr_mean'))).toBe(critical.hr!.mean);
    expect(Number(col(row, 'pre_op_hr_delta'))).toBe(summary.phases[0]!.meanHrDelta);
  });

  it('samples/RR/events CSV exports line up with the session and with the analytics', () => {
    const segments = derivePhases(session);

    const samplesCsv = samplesToCsv(session);
    expectCleanCsv(samplesCsv, 7);
    const s = readCsv(samplesCsv);
    expect(s.rows).toHaveLength(session.samples.length);
    s.rows.forEach((row, i) => {
      const sample = session.samples[i]!;
      expect(Number(s.col(row, 't_offset_s'))).toBe((sample.t - session.startedAt) / 1000);
      expect(Number(s.col(row, 'bpm'))).toBe(sample.bpm);
      expect(s.col(row, 'phase')).toBe(phaseAt(segments, sample.t));
    });

    const rrCsv = rrToCsv(session);
    expectCleanCsv(rrCsv, 7);
    const r = readCsv(rrCsv);
    expect(r.rows).toHaveLength(session.rr.length);
    expect(r.rows.filter((row) => r.col(row, 'valid') === '0')).toHaveLength(summary.rrArtifacts!.removed);
    expect(r.rows.every((row) => r.col(row, 'phase') !== '')).toBe(true);

    const eventsCsv = eventsToCsv(session);
    expectCleanCsv(eventsCsv, 8);
    const e = readCsv(eventsCsv);
    expect(e.rows.map((row) => e.col(row, 'kind'))).toEqual(
      session.events.map((ev) => (ev.type === 'phase' ? ev.phase : ev.marker)),
    );
  });

  it('bundle → JSON → parseImport → summarizeSession reproduces the summary exactly', () => {
    const bundle = withoutHostEntropy(() =>
      createExportBundle({
        sessions: [session],
        participants: [PARTICIPANT],
        app: { version: '1.0.0', platform: 'ios' },
        now: session.endedAt! + 60_000,
      }),
    );
    const text = JSON.stringify(bundle);
    const { bundle: imported, warnings } = withoutHostEntropy(() => parseImport(text));

    expect(warnings).toEqual([]);
    expect(imported.deidentified).toBe(false);
    expect(imported.exportedAt).toBe(session.endedAt! + 60_000);
    expect(imported.app).toEqual({ version: '1.0.0', platform: 'ios' });
    expect(imported.participants).toStrictEqual([PARTICIPANT]);
    expect(imported.sessions).toHaveLength(1);
    expect(imported.sessions[0]).toStrictEqual(session);

    const again = withoutHostEntropy(() => summarizeSession(imported.sessions[0]!));
    expect(again).toStrictEqual(summary);
    // Byte-identical, not just structurally equal: the summary's JSON doesn't depend on the key order of the
    // session it came from (the simulator's objects vs zod's output), so it can be cached or diffed as text.
    expect(JSON.stringify(again)).toBe(JSON.stringify(summary));
    expect(summariesToCsv([again])).toBe(summariesToCsv([summary]));

    // Exporting the imported bundle again is idempotent.
    const reexported = createExportBundle({
      sessions: imported.sessions,
      participants: imported.participants,
      ...(imported.app !== undefined ? { app: imported.app } : {}),
      now: imported.exportedAt,
    });
    expect(canonicalJson(reexported)).toBe(canonicalJson(bundle));
  });

  it('a bare session object and an array of sessions import to the same session', () => {
    const single = parseImport(JSON.stringify(session));
    const array = parseImport(JSON.stringify([session]));
    expect(single.warnings).toEqual([]);
    expect(array.warnings).toEqual([]);
    expect(single.bundle.sessions[0]).toStrictEqual(session);
    expect(array.bundle.sessions[0]).toStrictEqual(session);
    expect(single.bundle.participants).toEqual([{ code: 'SP-014' }]);
    expect(summarizeSession(array.bundle.sessions[0]!)).toStrictEqual(summary);
  });

  it('is deterministic: the same seed gives the same session and summary', () => {
    const twin = busySession();
    expect(JSON.stringify(twin)).toBe(JSON.stringify(session));
    expect(canonicalJson(summarizeSession(twin))).toBe(canonicalJson(summary));
  });
});

// ---------------------------------------------------------------------------
// De-identification: same metrics, shifted times
// ---------------------------------------------------------------------------

describe('de-identification with timeShiftMs', () => {
  const session = deepFreeze(busySession());
  const summary = summarizeSession(session);
  // An awkward but integral offset (≈ 123 days) that stays inside the same UTC year.
  const shift = 123 * DAY_MS + 3 * 3_600_000 + 17;

  it('deidentifySession keeps every metric and shifts every time by the same offset', () => {
    const d = withoutHostEntropy(() => deidentifySession(session, { timeShiftMs: shift }));
    expect(parseSession(d)).toStrictEqual(d); // still valid and sorted
    expect(d.sensor.id).toBeUndefined();
    expect(d.procedure.name).toBe(findProcedure(session.procedure.catalogId!)!.name);
    expect(d.postOp?.notes).toBeUndefined();
    expect(d.events.every((e) => e.note === undefined)).toBe(true);

    const ds = withoutHostEntropy(() => summarizeSession(d));
    expect(findNonFinite(ds)).toEqual([]);
    expect(ds.startedAt).toBe(summary.startedAt + shift);
    expect(ds).toStrictEqual(shiftSummaryTimes(summary, shift));

    // CSV exports carry the same physiology; only absolute times differ.
    const before = readCsv(samplesToCsv(session));
    const after = readCsv(samplesToCsv(d));
    for (const name of ['t_offset_s', 'bpm', 'phase']) {
      expect(after.rows.map((row) => after.col(row, name))).toEqual(before.rows.map((row) => before.col(row, name)));
    }
    expect(after.col(after.rows[0]!, 't_iso')).not.toBe(before.col(before.rows[0]!, 't_iso'));
  });

  it('a de-identified bundle survives JSON and import with identical metrics', () => {
    const bundle = createExportBundle({
      sessions: [session],
      participants: [PARTICIPANT],
      now: session.endedAt! + 60_000,
      deidentify: { timeShiftMs: shift },
    });
    expect(bundle).toStrictEqual(
      deidentifyBundle(
        createExportBundle({ sessions: [session], participants: [PARTICIPANT], now: session.endedAt! + 60_000 }),
        { timeShiftMs: shift },
      ),
    );
    const { bundle: imported, warnings } = parseImport(JSON.stringify(bundle));
    expect(warnings).toEqual([]);
    expect(imported.deidentified).toBe(true);
    expect(imported.exportedAt).toBe(session.endedAt! + 60_000 + shift);
    expect(imported.participants[0]!.consent).toEqual({ version: 'PICF-1.2', givenAt: PARTICIPANT.consent!.givenAt + shift });

    const again = summarizeSession(imported.sessions[0]!);
    expect(again).toStrictEqual(shiftSummaryTimes(summary, shift));
    expect(findNonFinite(again)).toEqual([]);
  });

  it('a shift across a year boundary changes only the age-predicted max HR unless atYear is pinned', () => {
    // SPEC: maxHr uses Tanaka (2001) at `atYear ?? UTC year of startedAt`, so moving a March 2026 session back
    // into 2025 makes the surgeon a year younger. Pinning atYear (e.g. to the real session year, before
    // de-identifying) keeps every metric identical.
    const back = -(120 * DAY_MS);
    const d = deidentifySession(session, { timeShiftMs: back });
    expect(new Date(d.startedAt).getUTCFullYear()).toBe(2025);

    expect(summarizeSession(d, { atYear: 2026 })).toStrictEqual(
      shiftSummaryTimes(summarizeSession(session, { atYear: 2026 }), back),
    );
    const unpinned = summarizeSession(d);
    expect(unpinned.maxHr).toBe(180); // 208 − 0.7·40
    expect(summary.maxHr).toBe(179); // 208 − 0.7·41 → 179.3
  });

  it('dropBirthYear removes the age-derived max HR (and with it %HRmax intensity) but nothing else', () => {
    const d = deidentifySession(session, { timeShiftMs: shift, dropBirthYear: true });
    expect(d.participantSnapshot?.birthYear).toBeUndefined();
    const ds = summarizeSession(d);
    expect(ds.maxHr).toBeNull();
    expect(ds.highIntensityFraction).toBeNull();
    expect({ ...ds, maxHr: summary.maxHr, highIntensityFraction: summary.highIntensityFraction }).toStrictEqual(
      shiftSummaryTimes(summary, shift),
    );
  });
});

// ---------------------------------------------------------------------------
// Cohort: aggregate and insight engine on realistic multi-participant data
// ---------------------------------------------------------------------------

const METRIC_KEYS = Object.keys(METRICS) as MetricKey[];
const GROUP_KEYS: readonly GroupKey[] = [
  'participant',
  'procedure',
  'specialty',
  'approach',
  'role',
  'trainingLevel',
  'urgency',
  'month',
  'none',
];
const INSIGHT_IDS = ['peak-phase', 'hr-trend', 'hrv-trend', 'workload-hr', 'data-quality', 'episodes-after-markers'];

describe('cohort analytics', () => {
  // The default cohort (8 participants × 12 sessions) is what the dashboard demo loads.
  const cohort = deepFreeze(withoutHostEntropy(() => simulateCohort({ seed: 11 })));
  const { bundle, warnings } = parseImport(
    JSON.stringify(createExportBundle({ sessions: cohort.sessions, participants: cohort.participants, now: 0 })),
  );
  const sessions = bundle.sessions;
  const summaries = withoutHostEntropy(() => sessions.map((s) => summarizeSession(s)));
  const sessionIds = new Set(sessions.map((s) => s.id));

  it('imports every simulated session without warnings', () => {
    expect(warnings).toEqual([]);
    expect(sessions).toHaveLength(96);
    expect(bundle.participants).toStrictEqual(cohort.participants);
    expect(sessions).toStrictEqual(cohort.sessions);
  });

  it('summaries contain no NaN/Infinity and every metric is finite or null', () => {
    expect(findNonFinite(summaries)).toEqual([]);
    for (const s of summaries) {
      for (const key of METRIC_KEYS) {
        const v = metricValue(s, key);
        if (v !== null) expect(Number.isFinite(v)).toBe(true);
      }
    }
    // RR is recorded for every 3rd session of each participant, so HRV is available for about a third.
    const withHrv = summaries.filter((s) => s.hrv !== null).length;
    expect(withHrv).toBeGreaterThanOrEqual(24);
    expect(withHrv).toBeLessThan(48);
  });

  it('aggregateMetric gives sane descriptive statistics for every metric × grouping', () => {
    for (const key of METRIC_KEYS) {
      const nonNull = summaries.filter((s) => metricValue(s, key) !== null).length;
      for (const groupBy of GROUP_KEYS) {
        const rows = aggregateMetric(summaries, key, groupBy);
        expect(findNonFinite(rows), `${key} by ${groupBy}`).toEqual([]);
        expect(rows.reduce((a, r) => a + r.n, 0), `${key} by ${groupBy}`).toBe(nonNull);
        expect(new Set(rows.map((r) => r.group)).size).toBe(rows.length);
        for (const r of rows) {
          expect(r.n).toBeGreaterThan(0);
          expect(r.group).not.toBe('');
          expect(r.sd).toBeGreaterThanOrEqual(0);
          if (r.n === 1) expect(r.sd).toBe(0);
          expect(r.min).toBeLessThanOrEqual(r.median);
          expect(r.median).toBeLessThanOrEqual(r.max);
          expect(r.mean).toBeGreaterThanOrEqual(r.min - 1e-9);
          expect(r.mean).toBeLessThanOrEqual(r.max + 1e-9);
        }
        const groups = rows.map((r) => r.group);
        // Sorted by UTF-16 code units (never locale-dependent); YYYY-MM months sort chronologically either way.
        expect(groups).toEqual([...groups].sort());
      }
    }
  });

  it('groups match the cohort design', () => {
    expect(aggregateMetric(summaries, 'meanHr', 'participant').map((r) => r.group)).toEqual(
      cohort.participants.map((p) => p.code),
    );
    const none = aggregateMetric(summaries, 'durationMin', 'none');
    expect(none).toHaveLength(1);
    expect(none[0]!.n).toBe(96);
    const months = aggregateMetric(summaries, 'meanHr', 'month').map((r) => r.group);
    expect(months[0]).toBe('2026-01');
    for (const m of months) expect(m).toMatch(/^\d{4}-\d{2}$/);
    // Trainees react more than consultants on average (gain = 0.5 + reactivity·(1 − 0.6·experience)).
    const byLevel = new Map(aggregateMetric(summaries, 'meanHrDelta', 'trainingLevel').map((r) => [r.group, r.mean]));
    expect(byLevel.get('intern')!).toBeGreaterThan(byLevel.get('consultant')!);
  });

  it('metricSeries is chronological and finite', () => {
    for (const key of METRIC_KEYS) {
      const series = metricSeries(summaries, key);
      expect(findNonFinite(series)).toEqual([]);
      for (let i = 1; i < series.length; i++) expect(series[i]!.t).toBeGreaterThanOrEqual(series[i - 1]!.t);
    }
  });

  it('generateInsights produces well-formed, plain-language, evidence-backed feedback', () => {
    const checkInsights = (subset: readonly SessionSummary[], withSessions: boolean): void => {
      const insights = generateInsights(subset, withSessions ? { sessions } : {});
      expect(findNonFinite(insights)).toEqual([]);
      const ids = insights.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
      const subsetIds = new Set(subset.map((s) => s.sessionId));
      for (const insight of insights) {
        expect(INSIGHT_IDS).toContain(insight.id);
        expect(['info', 'positive', 'attention']).toContain(insight.kind);
        expect(insight.title.length).toBeGreaterThan(10);
        expect(insight.detail.length).toBeGreaterThan(20);
        expect(insight.title).not.toMatch(BAD_TEXT);
        expect(insight.detail).not.toMatch(BAD_TEXT);
        expect(insight.evidence.length).toBeGreaterThan(0);
        for (const id of insight.evidence) {
          expect(sessionIds.has(id)).toBe(true);
          expect(subsetIds.has(id)).toBe(true);
        }
      }
      // Input order must not matter (insights sort sessions chronologically).
      expect(generateInsights([...subset].reverse(), withSessions ? { sessions } : {})).toStrictEqual(insights);
    };

    expect(new Set(summaries.map((s) => s.startedAt)).size).toBe(summaries.length); // no ties → order-free
    checkInsights(summaries, false);
    checkInsights(summaries, true);
    // Per participant, as shown in each surgeon's own Insights tab.
    for (const p of cohort.participants) {
      const mine = summaries.filter((s) => s.participantCode === p.code);
      expect(mine).toHaveLength(12);
      checkInsights(mine, true);
    }
    // Phases are logged in every simulated session, so the peak-phase rule has data for the whole cohort.
    expect(generateInsights(summaries).map((i) => i.id)).toContain('peak-phase');
    expect(generateInsights([])).toEqual([]);
    expect(findNonFinite(generateInsights(summaries.slice(0, 1)))).toEqual([]);
  });

  it('summariesToCsv exports the whole cohort as a clean rectangular table', () => {
    const csv = summariesToCsv(summaries);
    expectCleanCsv(csv, SUMMARY_CSV_COLUMNS.length);
    const { rows, col } = readCsv(csv);
    expect(rows).toHaveLength(96);
    expect(rows.map((row) => col(row, 'session_id'))).toEqual(summaries.map((s) => s.sessionId));
    // Empty (missing) cells only where the summary has no value, e.g. HRV for sessions without RR.
    rows.forEach((row, i) => {
      expect(col(row, 'rmssd') === '').toBe(summaries[i]!.hrv === null);
      expect(col(row, 'hr_mean')).not.toBe('');
    });
  });

  it('is deterministic: the same seed gives byte-identical cohort JSON and summaries', () => {
    const twin = simulateCohort({ seed: 11 });
    expect(JSON.stringify(twin)).toBe(JSON.stringify(cohort));
    expect(canonicalJson(twin.sessions.map((s) => summarizeSession(s)))).toBe(canonicalJson(summaries));
  });
});
