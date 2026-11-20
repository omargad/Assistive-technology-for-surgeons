/**
 * Generates the shared TypeScript ↔ Python parity fixtures in `/fixtures`.
 *
 *   npm run fixtures -w @surgeonpulse/core
 *   # or: cd packages/core && npx tsx scripts/generate-fixtures.ts
 *
 * Uses ONLY the public API of `@surgeonpulse/core` (`../src/index`) plus Node's
 * `fs`/`path`/`url` for writing files. Paths are resolved with `node:path` and
 * `node:url`, so the script behaves the same on Windows, macOS and Linux.
 *
 * Output (all deterministic: fixed seeds, fixed clocks):
 *   fixtures/manifest.json                     — what every fixture is and how it was made
 *   fixtures/sessions/<name>.json              — single SurgicalSession objects
 *   fixtures/cohort-small.json                 — ExportBundle from simulateCohort
 *   fixtures/expected/<name>.summary.json      — summarizeSession(session, summaryOptions)
 *   fixtures/expected/<name>.hrv.json          — computeHrv, cleanRr valid flags, rollingHrv, …
 *   fixtures/expected/<name>.{samples,rr,events}.csv — samplesToCsv / rrToCsv / eventsToCsv
 *   fixtures/expected/cohort-small.summaries.{csv,json}
 *   fixtures/expected/cohort-small.aggregates.json
 *
 * The Python toolkit (`/analysis/tests/test_parity.py`) recomputes everything
 * independently from SPEC.md and compares field by field.
 */
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  aggregateMetric,
  baevskyStressIndex,
  cleanRr,
  computeBaseline,
  computeHrv,
  createExportBundle,
  dataQuality,
  derivePhases,
  detectGaps,
  detectStressEpisodes,
  estimateMaxHr,
  eventsToCsv,
  hrStats,
  hrvTimeDomain,
  linearTrend,
  mean,
  median,
  movingAverage,
  parseImport,
  parseSession,
  percentile,
  rollingHrv,
  rrToCsv,
  sampleSd,
  samplesToCsv,
  scoreWorkload,
  sessionEnd,
  simulateCohort,
  simulateSession,
  summariesToCsv,
  summarizeSession,
  timeInZones,
  zonesFromBaseline,
  zonesFromMaxHr,
} from '../src/index';
import type {
  GroupKey,
  MetricKey,
  SessionSummary,
  SimulateOptions,
  SummaryOptions,
  SurgicalSession,
  WorkloadResponse,
  ZoneDefinition,
} from '../src/index';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const OUT = join(ROOT, 'fixtures');

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 5, 8, 0);

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

/** Pretty JSON where arrays of primitives stay on one line (keeps files small and diff-able). */
function pretty(value: unknown, indent = ''): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  const next = indent + '  ';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every((v) => v === null || typeof v !== 'object')) {
      return '[' + value.map((v) => JSON.stringify(v) ?? 'null').join(',') + ']';
    }
    return '[\n' + value.map((v) => next + pretty(v, next)).join(',\n') + '\n' + indent + ']';
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '{}';
  return (
    '{\n' +
    entries.map(([k, v]) => `${next}${JSON.stringify(k)}: ${pretty(v, next)}`).join(',\n') +
    '\n' +
    indent +
    '}'
  );
}

/** Collects JSON paths of NaN / ±Infinity values (SPEC: outputs must never contain them). */
function nonFinitePaths(value: unknown, path = '$', acc: string[] = []): string[] {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) acc.push(`${path} = ${String(value)}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => nonFinitePaths(v, `${path}[${i}]`, acc));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) nonFinitePaths(v, `${path}.${k}`, acc);
  }
  return acc;
}

const nonFiniteReport: Record<string, string[]> = {};

function write(rel: string, text: string): void {
  const file = join(OUT, ...rel.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

function writeJson(rel: string, value: unknown, compact = false): void {
  const bad = nonFinitePaths(value);
  if (bad.length > 0) nonFiniteReport[rel] = bad;
  write(rel, (compact ? JSON.stringify(value) : pretty(value)) + '\n');
}

// ---------------------------------------------------------------------------
// Fixture definitions
// ---------------------------------------------------------------------------

interface SessionFixture {
  name: string;
  description: string;
  simulate?: SimulateOptions;
  /** Free-text description of post-simulation edits (documented in the manifest). */
  modifications?: string[];
  summaryOptions?: SummaryOptions;
  build: () => SurgicalSession;
}

function withSnapshot(s: SurgicalSession, snapshot: SurgicalSession['participantSnapshot']): SurgicalSession {
  const copy: SurgicalSession = { ...s };
  if (snapshot === undefined) delete copy.participantSnapshot;
  else copy.participantSnapshot = snapshot;
  return copy;
}

function withoutBaseline(s: SurgicalSession): SurgicalSession {
  const copy: SurgicalSession = { ...s };
  delete copy.baseline;
  return copy;
}

const sim = (o: SimulateOptions) => () => simulateSession(o);

/** Hand-built session exercising phase clamping / dedupe / zero-length rules, invalid bpm, gaps and episodes. */
function buildEdgePhases(): SurgicalSession {
  const startedAt = Date.UTC(2026, 2, 2, 9, 30);
  const endedAt = startedAt + 10 * MIN;
  const samples: { t: number; bpm: number; contact?: boolean }[] = [];
  // Piecewise HR profile (bpm per second offset), with gaps and invalid values.
  for (let sec = 0; sec <= 600; sec++) {
    if (sec > 300 && sec < 312) continue; // 12 s dropout (> 5 s gap)
    if (sec > 450 && sec < 454) continue; // 4 s gap (not a gap for detectGaps)
    if (sec > 120 && sec < 125) continue; // exactly 5 s inside run A: NOT a gap (rule is "> 5000 ms")
    if (sec > 170 && sec < 176) continue; // exactly 6 s inside run B: breaks the run (re-merged by mergeGapMs)
    let bpm: number;
    if (sec < 60) bpm = 72 + (sec % 3);
    else if (sec < 140) bpm = 96 + (sec % 5); // run A (80 s above threshold 90)
    else if (sec < 160) bpm = 84; // 20 s dip → A and B merge (≤ 30 s)
    else if (sec < 230) bpm = 101 + (sec % 7); // run B, peak 107 repeated (first occurrence wins)
    else if (sec < 300) bpm = 80;
    else if (sec < 340) bpm = 95; // run C interrupted by the 12 s dropout → two short runs
    else if (sec < 420) bpm = 78;
    else if (sec < 450) bpm = 99; // run D 30 s < 60 s → dropped
    else bpm = 75 + (sec % 4);
    const sample: { t: number; bpm: number; contact?: boolean } = { t: startedAt + sec * 1000, bpm };
    if (sec % 50 === 0) sample.contact = sec % 100 === 0;
    samples.push(sample);
  }
  // Invalid bpm values (outside [25, 250]) inside and outside episodes.
  samples.push({ t: startedAt + 100_500, bpm: 0 });
  samples.push({ t: startedAt + 180_500, bpm: 260 });
  samples.push({ t: startedAt + 500_500, bpm: 20 });

  // RR: 1 notification per second, 1–2 beats each; ectopic pair, out-of-range values and a 10 s dropout.
  const rr: { t: number; ms: number }[] = [];
  let beatT = startedAt;
  let k = 0;
  while (beatT < endedAt) {
    const sec = (beatT - startedAt) / 1000;
    const base = sec < 60 ? 830 : sec < 230 ? 610 : 760;
    let ms = base + 25 * Math.sin(2 * Math.PI * 0.25 * sec) + ((k * 37) % 23) - 11;
    if (k === 150) ms = 250; // too short (rule 1)
    if (k === 151) ms = 2600; // too long (rule 1)
    if (k === 300) ms = base * 0.6; // ectopic
    if (k === 301) ms = base * 1.4; // compensatory
    ms = Math.round(ms * 1000) / 1000;
    beatT += ms;
    k++;
    const tNotify = Math.ceil(beatT / 1000) * 1000;
    if (tNotify > startedAt + 400_000 && tNotify <= startedAt + 410_000) continue; // RR dropout
    rr.push({ t: tNotify, ms });
  }

  const ev = (id: string, t: number, extra: Record<string, unknown>) => ({ id, t, loggedBy: 'self', ...extra });
  const events = [
    ev('ph-0', startedAt - 30_000, { type: 'phase', phase: 'pre-op' }), // before start → clamped
    ev('ph-1', startedAt + 20_000, { type: 'phase', phase: 'pre-op' }), // duplicate → ignored
    ev('ph-2', startedAt + 60_000, { type: 'phase', phase: 'incision' }),
    ev('ph-3', startedAt + 120_000, { type: 'phase', phase: 'dissection' }), // zero-length → dropped
    ev('ph-4', startedAt + 120_000, { type: 'phase', phase: 'critical' }),
    ev('mk-1', startedAt + 70_000, { type: 'marker', marker: 'complication', note: 'bleeding' }),
    ev('mk-2', startedAt + 215_000, { type: 'marker', marker: 'interruption', loggedBy: 'team' }),
    ev('mk-3', startedAt + 260_000, { type: 'marker', marker: 'equipment' }),
    ev('ph-5', startedAt + 330_000, { type: 'phase', phase: 'closure' }),
    ev('mk-4', startedAt + 430_000, { type: 'marker', marker: 'teaching' }),
    ev('mk-5', startedAt + 520_000, { type: 'marker', marker: 'complication', loggedBy: 'retrospective' }),
    ev('ph-6', endedAt, { type: 'phase', phase: 'post-op' }), // at sessionEnd → zero-length final segment
  ];

  return parseSession({
    schemaVersion: 1,
    id: 'edge-phases-0001',
    participantCode: 'EDGE-01',
    procedure: {
      name: 'Open inguinal hernia repair',
      catalogId: 'open-inguinal-hernia-repair',
      specialty: 'General surgery',
      approach: 'open',
      role: 'primary',
      complexity: 3,
      urgency: 'urgent',
    },
    startedAt,
    endedAt,
    status: 'completed',
    sensor: { source: 'import', name: 'hand-built fixture' },
    app: { version: 'fixtures', platform: 'web' },
    tzOffsetMin: 600,
    participantSnapshot: { trainingLevel: 'registrar', birthYear: 1990 },
    baseline: { startedAt: startedAt - 5 * MIN, endedAt: startedAt, restingHr: 70, source: 'manual' },
    samples,
    rr,
    events,
    postOp: {
      workload: {
        instrument: 'surg-tlx',
        ratings: { mental: 70, physical: 35, temporal: 60, complexity: 65, stress: 80, distraction: 25 },
        weights: { mental: 4, physical: 1, temporal: 2, complexity: 3, stress: 5, distraction: 0 },
        completedAt: endedAt + 5 * MIN,
      },
      performance: 6,
      perceivedStress: 7,
    },
  });
}

/** Very little data: one HR sample, 12 RR intervals, no events, still recording (no endedAt). */
function buildEdgeSparse(): SurgicalSession {
  const startedAt = Date.UTC(2026, 5, 30, 23, 59, 30);
  const rr = Array.from({ length: 12 }, (_, i) => ({ t: startedAt + 1000 * (i + 1), ms: 800 + (i % 3) * 20 }));
  return parseSession({
    schemaVersion: 1,
    id: 'edge-sparse-0001',
    participantCode: 'EDGE-02',
    procedure: { name: 'Diagnostic laparoscopy' },
    startedAt,
    status: 'recording',
    sensor: { source: 'ble' },
    app: { version: 'fixtures', platform: 'android' },
    samples: [{ t: startedAt + 4000, bpm: 77, contact: true }],
    rr,
    events: [],
  });
}

/** No signal at all and a zero-length session window. */
function buildEdgeEmpty(): SurgicalSession {
  const startedAt = Date.UTC(2025, 11, 31, 23, 0);
  return parseSession({
    schemaVersion: 1,
    id: 'edge-empty-0001',
    participantCode: 'EDGE-03',
    procedure: { name: 'Aborted case', approach: 'robotic', role: 'assistant', complexity: 5, urgency: 'emergency' },
    startedAt,
    endedAt: startedAt,
    status: 'aborted',
    sensor: { source: 'healthkit' },
    app: { version: 'fixtures', platform: 'ios' },
    participantSnapshot: { trainingLevel: 'fellow', maxHr: 190, restingHr: 58 },
    samples: [],
    rr: [],
    events: [],
    postOp: {
      workload: {
        instrument: 'nasa-tlx',
        ratings: { mental: 55, physical: 10, temporal: 40, performance: 20, effort: 50, frustration: 15 },
        completedAt: startedAt + 10 * MIN,
      },
    },
  });
}

/** Samples and RR extend beyond the session window on both sides; phase/marker events outside it. */
function buildEdgeWindow(): SurgicalSession {
  const startedAt = Date.UTC(2026, 3, 15, 13, 0);
  const endedAt = startedAt + 6 * MIN;
  const samples: { t: number; bpm: number }[] = [];
  for (let sec = -20; sec <= 380; sec++) {
    if (sec > -8 && sec < 3) continue; // 11 s gap straddling startedAt
    if (sec > 200 && sec < 209) continue; // 9 s gap
    const bpm = sec < 60 ? 88 : sec < 150 ? 125 + (sec % 6) : sec < 250 ? 104 : 131 + (sec % 3);
    samples.push({ t: startedAt + sec * 1000 + 250, bpm });
  }
  const rr: { t: number; ms: number }[] = [];
  let beatT = startedAt - 15_000;
  let k = 0;
  while (beatT < endedAt + 15_000) {
    const sec = (beatT - startedAt) / 1000;
    const base = sec < 60 ? 680 : sec < 150 ? 470 : sec < 250 ? 575 : 455;
    const ms = Math.round((base + 18 * Math.sin(2 * Math.PI * 0.25 * sec) + ((k * 53) % 17) - 8) * 1000) / 1000;
    beatT += ms;
    k++;
    rr.push({ t: Math.ceil(beatT / 1000) * 1000, ms });
  }
  return parseSession({
    schemaVersion: 1,
    id: 'edge-window-0001',
    participantCode: 'EDGE-04',
    procedure: { name: 'Laparoscopic appendicectomy', catalogId: 'laparoscopic-appendicectomy', approach: 'laparoscopic', urgency: 'emergency' },
    startedAt,
    endedAt,
    status: 'completed',
    sensor: { source: 'web-bluetooth', name: 'Strap' },
    app: { version: 'fixtures', platform: 'web' },
    participantSnapshot: { trainingLevel: 'intern', maxHr: 170 },
    samples,
    rr,
    events: [
      { id: 'w-1', t: startedAt - 60_000, type: 'phase', phase: 'pre-op' },
      { id: 'w-2', t: startedAt + 60_000, type: 'phase', phase: 'dissection' },
      { id: 'w-3', t: startedAt + 140_000, type: 'marker', marker: 'takeover' },
      { id: 'w-4', t: startedAt + 150_000, type: 'phase', phase: 'critical' },
      { id: 'w-5', t: endedAt + 5_000, type: 'marker', marker: 'note', note: 'after the end' },
      { id: 'w-6', t: endedAt + 10_000, type: 'phase', phase: 'closure' },
    ],
  });
}

const SESSION_FIXTURES: SessionFixture[] = [
  {
    name: 'sim-1',
    description: 'Default physiology, measured baseline, birthYear-derived maxHr for high-intensity fraction.',
    simulate: { seed: 1, durationMin: 30, birthYear: 1980, trainingLevel: 'consultant' },
    build: () => simulateSession({ seed: 1, durationMin: 30, birthYear: 1980, trainingLevel: 'consultant' }),
  },
  {
    name: 'sim-7',
    description: 'Frequent data dropouts (5–40 s gaps) and many markers; reactive trainee.',
    simulate: { seed: 7, durationMin: 40, dropoutRate: 0.4, markerRate: 6, reactivity: 0.85, experience: 0.1, trainingLevel: 'resident' },
    build: sim({ seed: 7, durationMin: 40, dropoutRate: 0.4, markerRate: 6, reactivity: 0.85, experience: 0.1, trainingLevel: 'resident' }),
  },
  {
    name: 'sim-13',
    description: 'High RR artefact rate (8 %), highly reactive and inexperienced.',
    simulate: { seed: 13, durationMin: 25, artifactRate: 0.08, reactivity: 0.95, experience: 0.05 },
    build: sim({ seed: 13, durationMin: 25, artifactRate: 0.08, reactivity: 0.95, experience: 0.05 }),
  },
  {
    name: 'sim-21',
    description: 'No RR intervals (HR-only sensor): HRV, stress index and artefact ratio must be null.',
    simulate: { seed: 21, durationMin: 30, includeRr: false },
    build: sim({ seed: 21, durationMin: 30, includeRr: false }),
  },
  {
    name: 'sim-34',
    description: 'No measured baseline; participantSnapshot.restingHr → profile baseline and baseline zones.',
    simulate: { seed: 34, durationMin: 30, withBaseline: false, restingHr: 62 },
    modifications: ['baseline removed', 'participantSnapshot = { trainingLevel: "registrar", restingHr: 62 }'],
    build: () =>
      withSnapshot(withoutBaseline(simulateSession({ seed: 34, durationMin: 30, withBaseline: false, restingHr: 62 })), {
        trainingLevel: 'registrar',
        restingHr: 62,
      }),
  },
  {
    name: 'sim-55',
    description: 'No baseline and no resting HR; maxHr estimated from birthYear (Tanaka) → %maxHR zones.',
    simulate: { seed: 55, durationMin: 35, withBaseline: false, birthYear: 1972, trainingLevel: 'consultant' },
    modifications: ['baseline removed', 'participantSnapshot = { trainingLevel: "consultant", birthYear: 1972 }'],
    build: () =>
      withSnapshot(
        withoutBaseline(simulateSession({ seed: 55, durationMin: 35, withBaseline: false, birthYear: 1972, trainingLevel: 'consultant' })),
        { trainingLevel: 'consultant', birthYear: 1972 },
      ),
  },
  {
    name: 'sim-89',
    description: 'Explicit SummaryOptions (maxHr, atYear, episode threshold, maxGapMs), 2 s sampling, no post-op report.',
    simulate: { seed: 89, durationMin: 20, sampleIntervalMs: 2000, withPostOp: false, reactivity: 1, markerRate: 8 },
    summaryOptions: { maxHr: 182, atYear: 2030, episodeThresholdBpm: 80, maxGapMs: 4000 },
    build: sim({ seed: 89, durationMin: 20, sampleIntervalMs: 2000, withPostOp: false, reactivity: 1, markerRate: 8 }),
  },
  {
    name: 'sim-144',
    description: 'Dropouts + artefacts; NASA-TLX workload with invalid weights (sum 14) → weighted null.',
    simulate: { seed: 144, durationMin: 30, dropoutRate: 1, artifactRate: 0.02, experience: 0.9, trainingLevel: 'fellow' },
    modifications: ['postOp.workload replaced by a NASA-TLX response whose weights sum to 14'],
    build: () => {
      const s = simulateSession({ seed: 144, durationMin: 30, dropoutRate: 1, artifactRate: 0.02, experience: 0.9, trainingLevel: 'fellow' });
      return {
        ...s,
        postOp: {
          ...s.postOp,
          workload: {
            instrument: 'nasa-tlx',
            ratings: { mental: 65, physical: 30, temporal: 45, performance: 25, effort: 60, frustration: 35 },
            weights: { mental: 5, physical: 1, temporal: 2, performance: 2, effort: 3, frustration: 1 },
            completedAt: (s.endedAt ?? s.startedAt) + 10 * MIN,
          },
        },
      };
    },
  },
  {
    name: 'edge-phases',
    description:
      'Hand-built: phase event before start (clamped), duplicate consecutive phase, zero-length middle segment, ' +
      'final phase at sessionEnd, invalid bpm, 12 s and 4 s gaps, merging/dropped episodes, RR dropout and out-of-range RR.',
    build: buildEdgePhases,
  },
  {
    name: 'edge-window',
    description:
      'Hand-built: samples/RR/events before startedAt and after endedAt (window clipping), unaligned sample times, ' +
      'snapshot maxHr without baseline (median-based episode threshold, %HRmax zones).',
    build: buildEdgeWindow,
  },
  {
    name: 'edge-sparse',
    description: 'Hand-built: one HR sample, 12 RR intervals, no events, no endedAt (sessionEnd from data).',
    build: buildEdgeSparse,
  },
  {
    name: 'edge-empty',
    description: 'Hand-built: no samples/RR/events, zero-length window, snapshot maxHr+restingHr, NASA-TLX without weights.',
    build: buildEdgeEmpty,
  },
];

const ROLLING_CUSTOM = { windowMs: 120_000, stepMs: 45_000, minIntervals: 40 } as const;
const CLEAN_CUSTOM = { minMs: 400, maxMs: 1500, maxDeviation: 0.1, window: 5 } as const;
const HRV_CUSTOM = { gapMs: 1000, minIntervals: 10, window: 7 } as const;

/** JSON-safe zone definitions (Infinity → "Infinity"). */
const zonesJson = (zs: ZoneDefinition[]) =>
  zs.map((z) => ({ ...z, maxBpm: Number.isFinite(z.maxBpm) ? z.maxBpm : 'Infinity' }));

/** Direct calls of individual analytics functions with non-default options (see manifest.extrasSpec). */
function extras(session: SurgicalSession) {
  const hr = hrStats(session.samples);
  const segments = derivePhases(session);
  const ctx = { segments, events: session.events };
  const threshold = hr ? hr.median + 5 : 90;
  const cleaned = cleanRr(session.rr);
  const validMs = session.rr.filter((_, i) => cleaned.valid[i]).map((r) => r.ms);
  const bpm = session.samples.map((s) => s.bpm);
  return {
    sessionEnd: sessionEnd(session),
    derivePhases: segments,
    hrStats: hr,
    percentiles: [0, 5, 33.3, 50, 95, 99.9, 100].map((p) => ({ p, value: percentile(bpm, p) })),
    detectGaps2000: detectGaps(session.samples, 2000),
    dataQuality2000: dataQuality(session, 2000),
    timeInZonesMaxHr185Gap3000: timeInZones(session.samples, zonesFromMaxHr(185), 3000),
    timeInZonesBaseline65: timeInZones(session.samples, zonesFromBaseline(65)),
    episodeThreshold: threshold,
    episodesNoMerge: detectStressEpisodes(session.samples, { thresholdBpm: threshold, minDurationMs: 0, mergeGapMs: 0 }, ctx),
    episodesLongMerge: detectStressEpisodes(session.samples, { thresholdBpm: threshold, minDurationMs: 20_000, mergeGapMs: 60_000 }, ctx),
    episodesNoContext: detectStressEpisodes(session.samples, { thresholdBpm: threshold }),
    computeBaselineFirst5Min: computeBaseline(session.samples, session.rr, session.startedAt, session.startedAt + 5 * MIN),
    cleanRrCustom: cleanRr(session.rr, CLEAN_CUSTOM),
    computeHrvCustom: computeHrv(session.rr, HRV_CUSTOM),
    baevskyBin25: baevskyStressIndex(validMs, 25),
    baevskyBin100: baevskyStressIndex(validMs, 100),
  };
}

/** Small hand-picked vectors for the pure helpers (inputs are stored next to outputs). */
function miscVectors() {
  const vecs: number[][] = [[], [5], [3, 1], [4, 1, 3, 2], [72, 75, 71, 90, 88, 88, 64], [0.1, 0.2, 0.3], [1e-7, 2.5e-7, 1e21]];
  const ps = [0, 10, 25, 50, 75, 90, 95, 99.5, 100];
  const trends = [
    [],
    [{ x: 1, y: 2 }],
    [{ x: 1, y: 2 }, { x: 1, y: 5 }],
    [{ x: 1, y: 3 }, { x: 2, y: 3 }, { x: 3, y: 3 }],
    [{ x: 1, y: 10 }, { x: 2, y: 8.5 }, { x: 3, y: 9 }, { x: 4, y: 6 }, { x: 5, y: 5.5 }],
    [{ x: 0.5, y: -1 }, { x: 2, y: 4 }, { x: 7, y: 3 }],
  ];
  const surg = (ratings: Record<string, number>, weights?: Record<string, number>): WorkloadResponse =>
    ({ instrument: 'surg-tlx', ratings, ...(weights ? { weights } : {}), completedAt: T0 }) as unknown as WorkloadResponse;
  const nasa = (ratings: Record<string, number>, weights?: Record<string, number>): WorkloadResponse =>
    ({ instrument: 'nasa-tlx', ratings, ...(weights ? { weights } : {}), completedAt: T0 }) as unknown as WorkloadResponse;
  const r6 = { mental: 70, physical: 35, temporal: 60, complexity: 65, stress: 80, distraction: 25 };
  const n6 = { mental: 55, physical: 10, temporal: 40, performance: 20, effort: 50, frustration: 15 };
  const workloads: WorkloadResponse[] = [
    surg(r6),
    surg(r6, { mental: 4, physical: 1, temporal: 2, complexity: 3, stress: 5, distraction: 0 }),
    surg({ ...r6, mental: 120, distraction: -10 }, { mental: 5, physical: 5, temporal: 5, complexity: 0, stress: 0, distraction: 0 }),
    surg(r6, { mental: 2.5, physical: 2.5, temporal: 2.5, complexity: 2.5, stress: 2.5, distraction: 2.5 }),
    surg(r6, { mental: 6, physical: 1, temporal: 2, complexity: 3, stress: 3, distraction: 0 }),
    surg(r6, { mental: 4, physical: 1, temporal: 2, complexity: 3, stress: 4, distraction: 0 }),
    nasa(n6, { mental: 5, physical: 0, temporal: 3, performance: 2, effort: 4, frustration: 1 }),
    nasa(n6, { mental: 5, physical: 0, temporal: 3, performance: 2, effort: 4 }),
  ];
  const hrvVectors: number[][] = [[], [800], [800, 800], [800, 810, 790, 850], [1000, 900, 1100, 1000, 940, 1010]];
  return {
    stats: vecs.map((xs) => ({
      xs,
      mean: mean(xs),
      median: median(xs),
      sampleSd: sampleSd(xs),
      percentiles: ps.map((p) => ({ p, value: percentile(xs, p) })),
      movingAverage3: movingAverage(xs, 3),
    })),
    linearTrend: trends.map((points) => ({ points, fit: linearTrend(points) })),
    estimateMaxHr: Array.from({ length: 91 }, (_, age) => ({ birthYear: 2026 - age, atYear: 2026, maxHr: estimateMaxHr(2026 - age, 2026) })),
    zonesFromMaxHr: [150, 176, 183, 190.5, 203].map((m) => ({ maxHr: m, zones: zonesJson(zonesFromMaxHr(m)) })),
    zonesFromBaseline: [58, 67.99, 72.5].map((r) => ({ restingHr: r, zones: zonesJson(zonesFromBaseline(r)) })),
    scoreWorkload: workloads.map((input) => ({ input, output: scoreWorkload(input) })),
    hrvTimeDomain: hrvVectors.map((xs) => ({ xs, hrv: hrvTimeDomain(xs) })),
  };
}

const COHORT_OPTIONS = { seed: 2026, participants: 3, sessionsPerParticipant: 4, start: T0, spacingDays: 7 } as const;
const COHORT_AGGREGATES: { metric: MetricKey; groupBy: GroupKey }[] = [
  { metric: 'meanHr', groupBy: 'participant' },
  { metric: 'meanHrDelta', groupBy: 'trainingLevel' },
  { metric: 'rmssd', groupBy: 'procedure' },
  { metric: 'workload', groupBy: 'specialty' },
  { metric: 'episodeCount', groupBy: 'month' },
  { metric: 'criticalMeanHr', groupBy: 'approach' },
  { metric: 'coveragePct', groupBy: 'none' },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function clean(): void {
  for (const sub of ['sessions', 'expected', 'imports']) rmSync(join(OUT, sub), { recursive: true, force: true });
  rmSync(join(OUT, 'cohort-small.json'), { force: true });
  rmSync(join(OUT, 'manifest.json'), { force: true });
}

function main(): void {
  clean();
  const manifestSessions: unknown[] = [];
  const sessionSummaries: SessionSummary[] = [];

  for (const fx of SESSION_FIXTURES) {
    // Round-trip through parseSession so the file is exactly what an importer would see.
    const session = parseSession(JSON.parse(JSON.stringify(fx.build())));
    const opts = fx.summaryOptions ?? {};
    writeJson(`sessions/${fx.name}.json`, session, true);

    const summary = summarizeSession(session, opts);
    sessionSummaries.push(summary);
    writeJson(`expected/${fx.name}.summary.json`, summary);

    const cleaned = cleanRr(session.rr);
    const validMs = session.rr.filter((_, i) => cleaned.valid[i]).map((r) => r.ms);
    writeJson(`expected/${fx.name}.hrv.json`, {
      computeHrv: computeHrv(session.rr),
      computeHrvMin20: computeHrv(session.rr, { minIntervals: 20 }),
      cleanRrValid: cleaned.valid,
      cleanRrReport: cleaned.report,
      hrvTimeDomainValid: hrvTimeDomain(validMs),
      baevskyStressIndex: baevskyStressIndex(validMs),
      rollingHrv: rollingHrv(session.rr),
      rollingHrvCustom: rollingHrv(session.rr, ROLLING_CUSTOM),
    });

    writeJson(`expected/${fx.name}.extras.json`, extras(session));
    write(`expected/${fx.name}.samples.csv`, samplesToCsv(session));
    write(`expected/${fx.name}.rr.csv`, rrToCsv(session));
    write(`expected/${fx.name}.events.csv`, eventsToCsv(session));

    manifestSessions.push({
      name: fx.name,
      description: fx.description,
      session: `sessions/${fx.name}.json`,
      simulate: fx.simulate ?? null,
      modifications: fx.modifications ?? [],
      summaryOptions: opts,
      expected: {
        summary: `expected/${fx.name}.summary.json`,
        hrv: `expected/${fx.name}.hrv.json`,
        extras: `expected/${fx.name}.extras.json`,
        samplesCsv: `expected/${fx.name}.samples.csv`,
        rrCsv: `expected/${fx.name}.rr.csv`,
        eventsCsv: `expected/${fx.name}.events.csv`,
      },
    });
  }

  writeJson('expected/misc.json', miscVectors());

  // parseImport behaviour on mixed valid / invalid input (list and bundle forms).
  const sparse = JSON.parse(JSON.stringify(buildEdgeSparse())) as Record<string, unknown>;
  const empty = JSON.parse(JSON.stringify(buildEdgeEmpty())) as Record<string, unknown>;
  const imports: Record<string, unknown> = {
    'import-list': [
      sparse,
      { ...empty, id: 'bad-bpm', samples: [{ t: 1, bpm: 400 }] },
      { ...sparse, id: 'no-code', participantCode: undefined },
      { ...empty, id: 'unsorted', samples: [{ t: (empty.startedAt as number) + 2000, bpm: 70 }, { t: (empty.startedAt as number) + 1000, bpm: 71 }] },
    ],
    'import-bundle': {
      format: 'surgeonpulse-export',
      version: 1,
      exportedAt: Date.UTC(2026, 6, 1),
      deidentified: true,
      participants: [{ code: 'EDGE-03', trainingLevel: 'fellow' }],
      sessions: [empty, { ...sparse, rr: [{ t: 5, ms: -3 }] }, sparse],
    },
    'import-single': sparse,
  };
  const importManifest: unknown[] = [];
  for (const [name, value] of Object.entries(imports)) {
    const text = JSON.stringify(value);
    write(`imports/${name}.json`, text + '\n');
    const { bundle: b, warnings } = parseImport(text);
    writeJson(`expected/${name}.result.json`, {
      sessionIds: b.sessions.map((x) => x.id),
      participantCodes: b.participants.map((x) => x.code),
      deidentified: b.deidentified,
      warningCount: warnings.length,
      warnings,
      firstSampleTimes: b.sessions.map((x) => x.samples.map((y) => y.t)),
    });
    importManifest.push({ name, input: `imports/${name}.json`, expected: `expected/${name}.result.json` });
  }

  // One wide CSV over all single-session fixtures (covers absent and zero-length phases).
  write('expected/sessions.summaries.csv', summariesToCsv(sessionSummaries));

  // Cohort bundle.
  const cohort = simulateCohort(COHORT_OPTIONS);
  const bundle = createExportBundle({
    sessions: cohort.sessions,
    participants: cohort.participants,
    app: { version: 'fixtures-1', platform: 'unknown' },
    deidentify: false,
    now: Date.UTC(2026, 6, 1),
  });
  writeJson('cohort-small.json', bundle, true);
  const summaries: SessionSummary[] = bundle.sessions.map((s) => summarizeSession(s));
  writeJson('expected/cohort-small.summaries.json', summaries);
  write('expected/cohort-small.summaries.csv', summariesToCsv(summaries));
  writeJson(
    'expected/cohort-small.aggregates.json',
    COHORT_AGGREGATES.map((a) => ({ ...a, result: aggregateMetric(summaries, a.metric, a.groupBy) })),
  );

  writeJson('manifest.json', {
    generatedBy: 'packages/core/scripts/generate-fixtures.ts',
    note: 'Regenerate with `npm run fixtures -w @surgeonpulse/core`. Do not edit by hand.',
    rollingHrvCustomOptions: ROLLING_CUSTOM,
    extrasSpec: {
      threshold: 'hrStats(samples).median + 5, or 90 without HR',
      episodesNoMerge: { minDurationMs: 0, mergeGapMs: 0, context: 'segments + events' },
      episodesLongMerge: { minDurationMs: 20000, mergeGapMs: 60000, context: 'segments + events' },
      episodesNoContext: { context: 'none' },
      cleanRrCustom: CLEAN_CUSTOM,
      computeHrvCustom: HRV_CUSTOM,
      computeBaselineFirst5Min: '[startedAt, startedAt + 300000)',
    },
    misc: 'expected/misc.json',
    imports: importManifest,
    sessions: manifestSessions,
    sessionsSummariesCsv: 'expected/sessions.summaries.csv',
    cohort: {
      name: 'cohort-small',
      bundle: 'cohort-small.json',
      simulateCohort: COHORT_OPTIONS,
      summaryOptions: {},
      expected: {
        summariesJson: 'expected/cohort-small.summaries.json',
        summariesCsv: 'expected/cohort-small.summaries.csv',
        aggregates: 'expected/cohort-small.aggregates.json',
      },
      aggregates: COHORT_AGGREGATES,
    },
    nonFiniteOutputs: nonFiniteReport,
  });

  // Report.
  let total = 0;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else total += st.size;
    }
  };
  walk(OUT);
  console.log(`Wrote fixtures to ${relative(process.cwd(), OUT) || '.'} (${(total / 1e6).toFixed(2)} MB total)`);
  const bad = Object.entries(nonFiniteReport);
  if (bad.length > 0) {
    console.warn('WARNING: non-finite numbers in outputs (SPEC forbids NaN/Infinity):');
    for (const [file, paths] of bad) console.warn(`  ${file}: ${paths.slice(0, 5).join('; ')}`);
  }
}

main();
