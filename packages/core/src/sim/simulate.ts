/**
 * Physiological simulator: realistic, fully reproducible intra-operative heart-rate data for demos, training,
 * automated tests and the dashboard's "Simulated" cohort. Simulated data is always tagged (`sensor.source:
 * 'simulated'`, `tags: ['simulated']`) and must never be presented as real measurements.
 *
 * ## Physiology model (SPEC.md › sim/simulate.ts)
 *
 * **Phases.** pre-op 10 %, incision 10 %, dissection 40 %, critical 15 %, closure 20 %, post-op 5 % of the
 * duration. Each share is jittered by a seeded ±20 % and the shares are renormalised. The pre-op event is at
 * `startedAt`, so the phases cover the whole session.
 *
 * **Heart rate**, on a 1-second grid:
 *
 *     HR(t) = resting + L(t) + drift(t) + R(t) + ε(t)
 *
 * - `L` is the phase offset × `gain`, passed through a first-order lag, τ = 45 s
 *   (`L += (target − L)·(1 − e^(−1 s/τ))`), so phase transitions are smooth. The offsets in bpm are pre-op 6,
 *   incision 12, dissection 10, critical 22, closure 6, post-op 3.
 * - `gain = 0.5 + reactivity·(1 − 0.6·experience)`. Experienced surgeons respond less, as commonly reported in
 *   studies of surgeons' stress (e.g. the systematic review by Arora et al., 2010, Surgery 147:318–330).
 * - `drift` is an AR(1) process `d ← 0.995·d + 0.6·N(0,1)` per second (time constant ≈ 200 s, stationary SD
 *   ≈ 6 bpm). It models slow, non-specific wandering (posture, fatigue, hydration) and starts at 0 at `startedAt`.
 * - `R` is the sum of marker responses. A `complication` adds `15·gain·e^(−Δt/180 s)`. An `interruption` or
 *   `equipment` problem adds `6·gain·e^(−Δt/90 s)`. Other markers add nothing.
 * - `ε ~ N(0, 1.5)` is white noise per second. HR is clamped to [30, 220] bpm.
 *
 * **Beats and RR intervals.** Beats are generated one after another. The interval that ends at a beat is
 *
 *     rr = 60000/HR(t_prev) + A·sin(2π·0.25 Hz·t_prev) + N(0, 8 ms)
 *
 * (clamped to [250, 2100] ms). The sine is respiratory sinus arrhythmia at 15 breaths/min, inside the HF band of
 * the Task Force of ESC/NASPE (1996). Its amplitude is `A = 25 ms·(1 − 0.5·stressLoad)`, with
 * `stressLoad = clamp((HR − resting)/30 bpm, 0, 1)`, so vagal modulation (and thus RMSSD) falls as HR rises above
 * rest. Each beat independently starts an artefact with probability `artifactRate`. Half of these are a **missed
 * beat**: the interval merges with the next one (≈ 2×). The other half are an **ectopic** beat: a premature
 * 0.6× interval, then a compensatory pause (0.4× + the next interval ≈ 1.4×), so beat timing stays consistent.
 * Like a BLE strap, beats are delivered in 1-second notifications: an RR interval's `t` is the next whole second
 * (on the grid anchored at `startedAt`) after its beat. Values are quantised to the Heart Rate Measurement
 * characteristic's 1/1024 s resolution and converted exactly as `ble/heartRate.ts` does.
 *
 * **HR samples** are emitted every `sampleIntervalMs` (1 Hz by default). Each is the rounded integer of
 * `60000 / mean(last 4 beat intervals)`, like a strap's own HR output. The strap is assumed to correct its own HR
 * output, so the RR artefacts above don't affect `bpm`.
 *
 * **Dropouts.** A Poisson process at `dropoutRate` per minute starts gaps lasting 5–40 s, with no samples and no
 * RR (like loss of skin contact or a BLE link drop). The physiology carries on underneath.
 *
 * **Markers.** A Poisson process at `markerRate` per hour. The kind mix leans towards complications and takeovers
 * for less experienced surgeons.
 *
 * **Baseline.** A 5-minute rest window just before `startedAt`, at resting HR. There's no phase offset and no
 * drift there, but RSA and noise are present. It is simulated with the same generator. Only the `Baseline`
 * record, from {@link computeBaseline} over that window, is stored. Its samples are never part of the session
 * arrays.
 *
 * **Post-op report.** A SURG-TLX (Wilson et al., 2011, World J Surg 35:1961–1969) whose latent workload rises with
 * the session's mean HR above resting, complications, interruptions/equipment problems, procedure complexity and
 * inexperience. Ratings are on the 0–100 scale in steps of 5. Pairwise-comparison weights follow Hart & Staveland
 * (1988): 15 comparisons, so they sum to 15. Self-rated performance and perceived stress (0–10) are included too.
 *
 * ## Determinism and portability
 *
 * There's no `Math.random()` or `Date.now()` anywhere in this file. Each concern draws from its own random stream
 * derived from the seed (timeline, HR grid, beat noise, artefacts, dropouts, post-op report, ids, cohort design).
 * Changing e.g. `artifactRate` therefore doesn't move the HR trace. Ids are v4-format UUIDs taken from the id
 * stream, not {@link createId}-style randomness. Transcendental functions come from {@link portableMath}. Any
 * sorting is a merge or has a total order. The same seed therefore yields byte-identical JSON on Hermes, browsers
 * and Node.
 */
import { PHASE_ORDER, SCHEMA_VERSION } from '../types';
import type {
  Baseline,
  EpochMs,
  EventLogger,
  HeartRateSample,
  MarkerKind,
  ParticipantProfile,
  ParticipantSnapshot,
  PhaseKind,
  PostOpReport,
  ProcedureInfo,
  RRInterval,
  SessionEvent,
  SurgicalApproach,
  SurgicalSession,
  SurgeonRole,
  SurgTlxDimension,
  TrainingLevel,
  Urgency,
} from '../types';
import { computeBaseline } from '../analytics/baseline';
import { PROCEDURE_CATALOG, findProcedure } from '../catalog/procedures';
import { createRng, gaussian, portableMath } from './rng';
import type { Rng } from './rng';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options for {@link simulateSession}. Every field is optional; defaults are noted in brackets. */
export interface SimulateOptions {
  /** Random seed [1]. Reduced to a 32-bit integer; the same seed gives identical output. */
  seed?: number;
  /** Participant study code ['SIM-001']. */
  participantCode?: string;
  /** Procedure [laparoscopic cholecystectomy from the catalogue, primary surgeon, complexity 2, elective]. */
  procedure?: ProcedureInfo;
  /** Session start, epoch ms [`Date.UTC(2026, 0, 5, 8, 0)`]. */
  startedAt?: EpochMs;
  /** Duration in minutes, (0, 1440] [90]. */
  durationMin?: number;
  /** Resting heart rate, bpm, [30, 150] [68]. */
  restingHr?: number;
  /** Trait stress reactivity, 0–1 [0.5]. */
  reactivity?: number;
  /** Experience with the task, 0 (novice) – 1 (expert) [0.5]. */
  experience?: number;
  /** HR sample interval, ms, [100, 600000] [1000]. */
  sampleIntervalMs?: number;
  /** Store RR intervals [true]. */
  includeRr?: boolean;
  /** Probability per beat that an RR artefact starts, [0, 0.5] [0.005]. */
  artifactRate?: number;
  /** Rate of 5–40 s data dropouts, per minute, [0, 60] [0]. */
  dropoutRate?: number;
  /** Rate of intra-operative markers, per hour, [0, 120] [1.0]. */
  markerRate?: number;
  /** Store a measured 5-minute pre-op baseline [true]. */
  withBaseline?: boolean;
  /** Store a post-op SURG-TLX / self-report [true]. */
  withPostOp?: boolean;
  /** Copied into `participantSnapshot` when given. */
  trainingLevel?: TrainingLevel;
  /** Copied into `participantSnapshot` when given (integer 1900–2100). */
  birthYear?: number;
}

/** Options for {@link simulateCohort}. */
export interface SimulateCohortOptions {
  /** Random seed [1]. */
  seed?: number;
  /** Number of participants, integer 0–1000 [8]. */
  participants?: number;
  /** Sessions per participant, integer 0–1000 [12]. */
  sessionsPerParticipant?: number;
  /** Start of the study, epoch ms [`Date.UTC(2026, 0, 5, 8, 0)`]. */
  start?: EpochMs;
  /** Days between a participant's consecutive sessions, [0, 365] [7]. */
  spacingDays?: number;
}

/** Result of {@link simulateCohort}. */
export interface SimulatedCohort {
  participants: ParticipantProfile[];
  /** All sessions, chronological (ties broken by participant, then session number). */
  sessions: SurgicalSession[];
}

/** Options for {@link createLiveSimulator}. */
export interface LiveSimulatorOptions {
  /** Random seed [1]. */
  seed?: number;
  /** Resting heart rate, bpm, [30, 150] [68]. */
  restingHr?: number;
  /** Trait stress reactivity, 0–1 [0.5]. */
  reactivity?: number;
  /** Start time, epoch ms [the `now` of the first {@link LiveSimulator.tick} call]. */
  startedAt?: EpochMs;
  /** Experience, 0–1 [0.5]. */
  experience?: number;
  /** Probability per beat that an RR artefact starts, [0, 0.5] [0.005]. */
  artifactRate?: number;
}

/** Data produced by one {@link LiveSimulator.tick}. */
export interface LiveSimulatorTick {
  samples: HeartRateSample[];
  rr: RRInterval[];
}

/** A simulated sensor that streams in real time (used by the app's demo/simulator source). */
export interface LiveSimulator {
  /**
   * Advance to time `now` and return all samples / RR generated since the last call (1 Hz samples on the grid
   * `startedAt + k·1000`, RR in beat order). A `now` that isn't later than the previous call returns empty
   * arrays and changes nothing. If more than an hour has passed (e.g. the app was suspended), only the last
   * hour is generated; the rest is treated as a sensor dropout.
   */
  tick(now: EpochMs): LiveSimulatorTick;
  /** Shift the target phase offset (applies from the next second, through the 45 s lag). */
  setPhase(phase: PhaseKind): void;
  /** Add the marker's HR response (complication, interruption, equipment), starting at the last tick. */
  trigger(marker: MarkerKind): void;
}

// ---------------------------------------------------------------------------
// Model constants
// ---------------------------------------------------------------------------

const MINUTE_MS = 60000;
const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const DEFAULT_STARTED_AT: EpochMs = Date.UTC(2026, 0, 5, 8, 0);
const DEFAULT_RESTING_HR = 68;

const PHASE_FRACTION: Readonly<Record<PhaseKind, number>> = {
  'pre-op': 0.1,
  incision: 0.1,
  dissection: 0.4,
  critical: 0.15,
  closure: 0.2,
  'post-op': 0.05,
};
const PHASE_JITTER = 0.2;
const PHASE_OFFSET_BPM: Readonly<Record<PhaseKind, number>> = {
  'pre-op': 6,
  incision: 12,
  dissection: 10,
  critical: 22,
  closure: 6,
  'post-op': 3,
};

const LAG_TAU_S = 45;
const DRIFT_PHI = 0.995;
const DRIFT_SIGMA = 0.6;
const NOISE_SD_BPM = 1.5;
const HR_MIN = 30;
const HR_MAX = 220;

const MARKER_RESPONSE: Readonly<Partial<Record<MarkerKind, { amp: number; tauS: number }>>> = {
  complication: { amp: 15, tauS: 180 },
  interruption: { amp: 6, tauS: 90 },
  equipment: { amp: 6, tauS: 90 },
};
/** Responses are ignored after this many time constants (e^−10 ≈ 4.5e−5 of the peak). */
const RESPONSE_HORIZON_TAUS = 10;

const RSA_FREQ_HZ = 0.25;
const RSA_AMP_MS = 25;
const STRESS_LOAD_SPAN_BPM = 30;
const RR_NOISE_SD_MS = 8;
const RR_MIN_MS = 250;
const RR_MAX_MS = 2100;
const BPM_AVERAGE_BEATS = 4;
const RECENT_BEATS_KEPT = 8;

const BASELINE_MS = 5 * MINUTE_MS;
/** Beats simulated before the first stored sample so the first `bpm` already averages real intervals. */
const WARMUP_MS = 10000;
const NOTIFICATION_INTERVAL_MS = 1000;
const LIVE_SAMPLE_INTERVAL_MS = 1000;
const LIVE_MAX_CATCH_UP_MS = HOUR_MS;
const MAX_MARKERS = 10000;

const SENSOR_NAME = 'SurgeonPulse simulator';
const SIM_APP_VERSION = 'simulator-1';

const SURG_TLX_ORDER: readonly SurgTlxDimension[] = [
  'mental',
  'physical',
  'temporal',
  'complexity',
  'stress',
  'distraction',
];

/** Independent random streams (see the module comment). */
const STREAM = {
  timeline: 1,
  hr: 2,
  beat: 3,
  artifact: 4,
  dropout: 5,
  postOp: 6,
  id: 7,
  cohort: 8,
  cohortSession: 9,
} as const;

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** murmur3 32-bit finaliser: a bijective avalanche mix of a 32-bit integer. */
function mix32(x: number): number {
  let h = x | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Seed of an independent sub-stream, e.g. `deriveSeed(seed, STREAM.hr)` or
 * `deriveSeed(seed, STREAM.cohortSession, p, k)`.
 */
function deriveSeed(seed: number, ...path: number[]): number {
  let h = mix32((seed | 0) ^ 0x2545f491);
  for (const p of path) h = mix32(h ^ Math.imul((p | 0) + 1, 0x9e3779b1));
  return h | 0;
}

interface Streams {
  timeline: Rng;
  hr: Rng;
  beat: Rng;
  artifact: Rng;
  dropout: Rng;
  postOp: Rng;
  id: Rng;
}

function createStreams(seed: number): Streams {
  return {
    timeline: createRng(deriveSeed(seed, STREAM.timeline)),
    hr: createRng(deriveSeed(seed, STREAM.hr)),
    beat: createRng(deriveSeed(seed, STREAM.beat)),
    artifact: createRng(deriveSeed(seed, STREAM.artifact)),
    dropout: createRng(deriveSeed(seed, STREAM.dropout)),
    postOp: createRng(deriveSeed(seed, STREAM.postOp)),
    id: createRng(deriveSeed(seed, STREAM.id)),
  };
}

const HEX = '0123456789abcdef';

/** RFC 4122 version-4-format UUID (lowercase) from 128 bits of the seeded stream: reproducible, not secret. */
function uuidFromRng(rng: Rng): string {
  let hex = '';
  for (let w = 0; w < 4; w++) {
    let word = Math.floor(rng() * 4294967296) >>> 0;
    if (w === 1) word = ((word & 0xffff0fff) | 0x00004000) >>> 0; // version 4
    if (w === 2) word = ((word & 0x3fffffff) | 0x80000000) >>> 0; // variant 10xx
    for (let shift = 28; shift >= 0; shift -= 4) hex += HEX.charAt((word >>> shift) & 15);
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Item chosen by `u ∈ [0, 1)` from `[item, weight]` pairs (weights need not sum to 1). One draw per call site. */
function pickWeighted<T>(items: readonly (readonly [T, number])[], u: number): T {
  let total = 0;
  for (const [, w] of items) total += w;
  let x = u * total;
  for (const [item, w] of items) {
    if (x < w) return item;
    x -= w;
  }
  return items[items.length - 1]![0];
}

function round5(x: number): number {
  return Math.round(x / 5) * 5;
}

/** `gain = 0.5 + reactivity·(1 − 0.6·experience)` (SPEC.md). */
function responseGain(reactivity: number, experience: number): number {
  return 0.5 + reactivity * (1 - 0.6 * experience);
}

/** Converts an interval to the BLE wire resolution (1/1024 s) and back, exactly as `ble/heartRate.ts` decodes it. */
function quantizeRr(ms: number): number {
  const raw = clamp(Math.round((ms * 1024) / 1000), 0, 65535);
  return Math.round((raw * 1000 * 1000) / 1024) / 1000;
}

// ---------------------------------------------------------------------------
// Option validation
// ---------------------------------------------------------------------------

function numberOption(fn: string, name: string, value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${fn}: ${name} must be a finite number in [${min}, ${max}], got ${String(value)}`);
  }
  return value;
}

function integerOption(fn: string, name: string, value: unknown, fallback: number, min: number, max: number): number {
  const n = numberOption(fn, name, value, fallback, min, max);
  if (!Number.isInteger(n)) throw new RangeError(`${fn}: ${name} must be an integer, got ${String(value)}`);
  return n;
}

function seedOption(fn: string, value: unknown): number {
  if (value === undefined) return 1;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`${fn}: seed must be a finite number, got ${String(value)}`);
  }
  return value;
}

function epochOption(fn: string, name: string, value: unknown, fallback: EpochMs): EpochMs {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`${fn}: ${name} must be a finite epoch-ms number, got ${String(value)}`);
  }
  return value;
}

interface ResolvedSimulateOptions {
  seed: number;
  participantCode: string;
  procedure: ProcedureInfo;
  startedAt: EpochMs;
  durationMin: number;
  restingHr: number;
  reactivity: number;
  experience: number;
  sampleIntervalMs: number;
  includeRr: boolean;
  artifactRate: number;
  dropoutRate: number;
  markerRate: number;
  withBaseline: boolean;
  withPostOp: boolean;
  trainingLevel: TrainingLevel | undefined;
  birthYear: number | undefined;
}

function defaultProcedure(): ProcedureInfo {
  const entry = findProcedure('laparoscopic-cholecystectomy');
  return {
    name: entry?.name ?? 'Laparoscopic cholecystectomy',
    catalogId: 'laparoscopic-cholecystectomy',
    specialty: entry?.specialty ?? 'General surgery',
    approach: 'laparoscopic',
    role: 'primary',
    complexity: 2,
    urgency: 'elective',
  };
}

function resolveSimulateOptions(opts: SimulateOptions): ResolvedSimulateOptions {
  const fn = 'simulateSession';
  const participantCode = opts.participantCode ?? 'SIM-001';
  if (typeof participantCode !== 'string' || participantCode.length === 0) {
    throw new RangeError(`${fn}: participantCode must be a non-empty string`);
  }
  const birthYear =
    opts.birthYear === undefined ? undefined : integerOption(fn, 'birthYear', opts.birthYear, 0, 1900, 2100);
  return {
    seed: seedOption(fn, opts.seed),
    participantCode,
    procedure: opts.procedure !== undefined ? { ...opts.procedure } : defaultProcedure(),
    startedAt: epochOption(fn, 'startedAt', opts.startedAt, DEFAULT_STARTED_AT),
    durationMin: numberOption(fn, 'durationMin', opts.durationMin, 90, 1 / 60, 1440),
    restingHr: numberOption(fn, 'restingHr', opts.restingHr, DEFAULT_RESTING_HR, 30, 150),
    reactivity: numberOption(fn, 'reactivity', opts.reactivity, 0.5, 0, 1),
    experience: numberOption(fn, 'experience', opts.experience, 0.5, 0, 1),
    sampleIntervalMs: numberOption(fn, 'sampleIntervalMs', opts.sampleIntervalMs, 1000, 100, 600000),
    includeRr: opts.includeRr ?? true,
    artifactRate: numberOption(fn, 'artifactRate', opts.artifactRate, 0.005, 0, 0.5),
    dropoutRate: numberOption(fn, 'dropoutRate', opts.dropoutRate, 0, 0, 60),
    markerRate: numberOption(fn, 'markerRate', opts.markerRate, 1, 0, 120),
    withBaseline: opts.withBaseline ?? true,
    withPostOp: opts.withPostOp ?? true,
    trainingLevel: opts.trainingLevel,
    birthYear,
  };
}

// ---------------------------------------------------------------------------
// Beat engine (shared by the batch and live simulators)
// ---------------------------------------------------------------------------

interface ResponseKernel {
  onset: EpochMs;
  amp: number;
  tauMs: number;
}

/** Σ amp·e^(−Δt/τ) over the kernels that have started (and haven't faded out) at `t`. */
function responseSum(kernels: readonly ResponseKernel[], t: EpochMs): number {
  let sum = 0;
  for (const k of kernels) {
    const dt = t - k.onset;
    if (dt < 0 || dt > RESPONSE_HORIZON_TAUS * k.tauMs) continue;
    sum += k.amp * portableMath.exp(-dt / k.tauMs);
  }
  return sum;
}

interface BeatEngineConfig {
  /** Grid origin and time of the first beat. Must be `deliveryAnchor` minus a whole number of seconds. */
  origin: EpochMs;
  /** The AR(1) drift is held at 0 before this time (the resting baseline). */
  driftStart: EpochMs;
  /** Notification grid anchor (`startedAt`). */
  deliveryAnchor: EpochMs;
  restingHr: number;
  artifactRate: number;
  /** Unlagged phase offset × gain at grid time `t`, bpm. Called with non-decreasing `t`. */
  targetAt: (t: EpochMs) => number;
  /** Marker response at grid time `t`, bpm. */
  responseAt: (t: EpochMs) => number;
  hrRng: Rng;
  beatRng: Rng;
  artifactRng: Rng;
}

interface TrueBeat {
  /** Occurrence time (ms, fractional). */
  t: number;
  /** True interval ending at this beat, ms. */
  rr: number;
}

interface BeatEngine {
  /** Generates beats until every beat at or before `t` exists (and no artefact is pending). */
  advanceTo(t: EpochMs): void;
  /** Strap-style HR at `t`: rounded `60000 / mean(last 4 intervals of beats ≤ t)`. */
  bpmAt(t: EpochMs): number;
  /** Removes and returns the reported intervals delivered at or before `upTo`, in beat order. */
  takeDelivered(upTo: EpochMs): RRInterval[];
  /** Jumps to `t` without simulating the time in between (live simulator catch-up limit). */
  skipTo(t: EpochMs): void;
}

function createBeatEngine(cfg: BeatEngineConfig): BeatEngine {
  const lagAlpha = 1 - portableMath.exp(-1 / LAG_TAU_S);
  let second = -1;
  let hr = cfg.restingHr;
  let drift = 0;
  let lag = 0;
  let lastBeat = cfg.origin;
  const recent: TrueBeat[] = [];
  let held: { prevT: number; rr: number; ectopic: boolean } | null = null;
  const out: RRInterval[] = [];

  /** Advances the 1-second HR grid by one step (drift, lagged phase offset, marker response, noise). */
  function stepSecond(): void {
    second++;
    const ts = cfg.origin + second * 1000;
    if (ts >= cfg.driftStart) drift = DRIFT_PHI * drift + DRIFT_SIGMA * gaussian(cfg.hrRng);
    lag += (cfg.targetAt(ts) - lag) * lagAlpha;
    const eps = NOISE_SD_BPM * gaussian(cfg.hrRng);
    hr = clamp(cfg.restingHr + lag + drift + cfg.responseAt(ts) + eps, HR_MIN, HR_MAX);
  }

  function hrAt(t: number): number {
    const s = Math.floor((t - cfg.origin) / 1000);
    while (second < s) stepSecond();
    return hr;
  }

  function deliver(tOcc: number, ms: number): void {
    const slot = Math.floor((tOcc - cfg.deliveryAnchor) / NOTIFICATION_INTERVAL_MS) + 1;
    out.push({ t: cfg.deliveryAnchor + slot * NOTIFICATION_INTERVAL_MS, ms: quantizeRr(ms) });
  }

  /** Applies the artefact model to the true beat sequence and queues what the strap would report. */
  function report(prevT: number, beat: TrueBeat): void {
    if (held !== null) {
      const h = held;
      held = null;
      if (h.ectopic) {
        const early = 0.6 * h.rr;
        deliver(h.prevT + early, early);
        deliver(beat.t, h.rr - early + beat.rr);
      } else {
        deliver(beat.t, h.rr + beat.rr);
      }
      return;
    }
    if (cfg.artifactRate > 0 && cfg.artifactRng() < cfg.artifactRate) {
      held = { prevT, rr: beat.rr, ectopic: cfg.artifactRng() < 0.5 };
      return;
    }
    deliver(beat.t, beat.rr);
  }

  function nextBeat(): void {
    const prevT = lastBeat;
    const h = hrAt(prevT);
    const stressLoad = clamp((h - cfg.restingHr) / STRESS_LOAD_SPAN_BPM, 0, 1);
    const rsaPhase = (RSA_FREQ_HZ * (prevT - cfg.origin)) / 1000;
    const rsa = RSA_AMP_MS * (1 - 0.5 * stressLoad) * portableMath.sinTurns(rsaPhase);
    const rr = clamp(60000 / h + rsa + RR_NOISE_SD_MS * gaussian(cfg.beatRng), RR_MIN_MS, RR_MAX_MS);
    lastBeat = prevT + rr;
    const beat: TrueBeat = { t: lastBeat, rr };
    recent.push(beat);
    if (recent.length > RECENT_BEATS_KEPT) recent.shift();
    report(prevT, beat);
  }

  function advanceTo(t: EpochMs): void {
    if (!Number.isFinite(t)) return;
    while (lastBeat <= t || held !== null) nextBeat();
  }

  return {
    advanceTo,
    bpmAt(t: EpochMs): number {
      advanceTo(t);
      let sum = 0;
      let n = 0;
      for (let i = recent.length - 1; i >= 0 && n < BPM_AVERAGE_BEATS; i--) {
        const b = recent[i]!;
        if (b.t > t) continue;
        sum += b.rr;
        n++;
      }
      if (n === 0) return Math.round(hr);
      return Math.round((60000 * n) / sum);
    },
    takeDelivered(upTo: EpochMs): RRInterval[] {
      let n = 0;
      while (n < out.length && out[n]!.t <= upTo) n++;
      return out.splice(0, n);
    },
    skipTo(t: EpochMs): void {
      if (!(t > lastBeat)) return;
      second = Math.floor((t - cfg.origin) / 1000) - 1;
      lag = cfg.targetAt(t);
      lastBeat = t;
      recent.length = 0;
      held = null;
      out.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Session timeline
// ---------------------------------------------------------------------------

interface PlannedPhase {
  phase: PhaseKind;
  t: EpochMs;
}

interface PlannedMarker {
  t: EpochMs;
  marker: MarkerKind;
  loggedBy: EventLogger;
}

/** Phase start times: SPEC shares jittered by ±20 % (one draw per phase) and renormalised; pre-op at `startedAt`. */
function planPhases(startedAt: EpochMs, durationMs: number, rng: Rng): PlannedPhase[] {
  const weights: number[] = [];
  let total = 0;
  for (const phase of PHASE_ORDER) {
    const w = PHASE_FRACTION[phase] * (1 + PHASE_JITTER * (2 * rng() - 1));
    weights.push(w);
    total += w;
  }
  const out: PlannedPhase[] = [];
  let acc = 0;
  for (let i = 0; i < PHASE_ORDER.length; i++) {
    out.push({ phase: PHASE_ORDER[i]!, t: startedAt + Math.round((durationMs * acc) / total) });
    acc += weights[i]!;
  }
  return out;
}

/** Relative frequency of marker kinds; complications and takeovers are more frequent for less experienced surgeons. */
function markerWeights(experience: number): readonly (readonly [MarkerKind, number])[] {
  return [
    ['complication', 0.12 + 0.12 * (1 - experience)],
    ['interruption', 0.3],
    ['equipment', 0.18],
    ['teaching', 0.15],
    ['takeover', 0.1 * (1 - experience)],
    ['note', 0.1],
  ];
}

/** Homogeneous Poisson process at `ratePerHour` over `[startedAt, endedAt)`: exponential gaps, 3 draws per marker. */
function planMarkers(
  startedAt: EpochMs,
  endedAt: EpochMs,
  ratePerHour: number,
  experience: number,
  rng: Rng,
): PlannedMarker[] {
  const out: PlannedMarker[] = [];
  if (!(ratePerHour > 0)) return out;
  const meanGapMs = HOUR_MS / ratePerHour;
  const weights = markerWeights(experience);
  let t = startedAt;
  while (out.length < MAX_MARKERS) {
    t += -portableMath.log(1 - rng()) * meanGapMs;
    if (!(t < endedAt)) break;
    const marker = pickWeighted(weights, rng());
    const loggedBy: EventLogger = rng() < 0.75 ? 'self' : 'team';
    out.push({ t: Math.floor(t), marker, loggedBy });
  }
  return out;
}

interface Dropout {
  start: EpochMs;
  end: EpochMs;
}

/** Sensor dropouts: Poisson starts at `ratePerMin` (checked each second), each lasting 5–40 s (uniform). */
function planDropouts(startedAt: EpochMs, endedAt: EpochMs, ratePerMin: number, rng: Rng): Dropout[] {
  const out: Dropout[] = [];
  if (!(ratePerMin > 0)) return out;
  const pPerSecond = 1 - portableMath.exp(-ratePerMin / 60);
  let t = startedAt;
  while (t < endedAt) {
    if (rng() < pPerSecond) {
      const length = 5000 + Math.floor(rng() * 35001);
      out.push({ start: t, end: Math.min(t + length, endedAt) });
      t += length;
    } else {
      t += 1000;
    }
  }
  return out;
}

function inDropout(dropouts: readonly Dropout[], t: EpochMs): boolean {
  for (const d of dropouts) if (t >= d.start && t < d.end) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Post-op report
// ---------------------------------------------------------------------------

/** SURG-TLX + self-report, correlated with mean HR above resting, markers, complexity and experience. */
function simulatePostOp(args: {
  samples: readonly HeartRateSample[];
  restingHr: number;
  markers: readonly PlannedMarker[];
  experience: number;
  complexity: number;
  endedAt: EpochMs;
  rng: Rng;
}): PostOpReport {
  const { rng } = args;
  let sum = 0;
  for (const s of args.samples) sum += s.bpm;
  const delta = args.samples.length > 0 ? sum / args.samples.length - args.restingHr : 0;
  let complications = 0;
  let interruptions = 0;
  let equipment = 0;
  for (const m of args.markers) {
    if (m.marker === 'complication') complications++;
    else if (m.marker === 'interruption') interruptions++;
    else if (m.marker === 'equipment') equipment++;
  }

  const latent =
    25 +
    1.6 * delta +
    10 * complications +
    4 * (interruptions + equipment) +
    15 * (1 - args.experience) +
    4 * (args.complexity - 3) +
    6 * gaussian(rng);
  const offsets: Record<SurgTlxDimension, number> = {
    mental: 10,
    physical: -8,
    temporal: 2,
    complexity: 4 + 4 * (args.complexity - 3),
    stress: 6 * complications,
    distraction: -14 + 6 * interruptions,
  };
  const ratings = {} as Record<SurgTlxDimension, number>;
  for (const d of SURG_TLX_ORDER) ratings[d] = clamp(round5(latent + offsets[d] + 7 * gaussian(rng)), 0, 100);

  // Pairwise comparisons (Hart & Staveland, 1988): 15 pairs, the more important source of workload wins.
  const weights = {} as Record<SurgTlxDimension, number>;
  for (const d of SURG_TLX_ORDER) weights[d] = 0;
  for (let i = 0; i < SURG_TLX_ORDER.length; i++) {
    for (let j = i + 1; j < SURG_TLX_ORDER.length; j++) {
      const a = SURG_TLX_ORDER[i]!;
      const b = SURG_TLX_ORDER[j]!;
      const winner = ratings[a] - ratings[b] + 15 * gaussian(rng) >= 0 ? a : b;
      weights[winner] += 1;
    }
  }

  const completedAt = args.endedAt + 2 * MINUTE_MS + Math.floor(rng() * 13 * MINUTE_MS);
  const performance = clamp(
    Math.round(8 - 0.1 * delta - 1.2 * complications + 1.2 * (args.experience - 0.5) + 0.8 * gaussian(rng)),
    0,
    10,
  );
  const perceivedStress = clamp(
    Math.round(1.5 + 0.18 * delta + 1.5 * complications + 0.6 * interruptions + gaussian(rng)),
    0,
    10,
  );
  const sleepHours = clamp(Math.round((7 + gaussian(rng)) * 2) / 2, 4, 9);
  const caffeine = rng() < 0.55;
  return {
    workload: { instrument: 'surg-tlx', ratings, weights, completedAt },
    performance,
    perceivedStress,
    sleepHours,
    caffeine,
    outcome: complications === 0 ? 'as-planned' : complications === 1 ? 'minor-deviation' : 'major-deviation',
  };
}

// ---------------------------------------------------------------------------
// simulateSession
// ---------------------------------------------------------------------------

/**
 * Simulates one completed surgical session following the physiology model in the module comment
 * (SPEC.md › sim/simulate.ts).
 *
 * The result:
 * - passes `parseSession`, with `samples`, `rr` and `events` already sorted;
 * - has `samples` every `sampleIntervalMs` on `[startedAt, startedAt + durationMin)`, minus dropouts, with
 *   integer `bpm`;
 * - has `rr` in beat order, delivered on the 1-second notification grid (empty when `includeRr` is false);
 * - has six phase events in `PHASE_ORDER` covering the whole duration, plus Poisson markers;
 * - optionally has a measured `baseline` (computed with `computeBaseline` over the simulated 5-minute rest window
 *   before `startedAt`) and a SURG-TLX `postOp` report;
 * - is tagged `simulated`, with `sensor.source: 'simulated'`.
 *
 * It is deterministic: the same options give byte-identical `JSON.stringify` output on every engine. It never
 * reads the clock and never calls `Math.random`.
 *
 * @throws RangeError when an option is outside its documented range (see {@link SimulateOptions}).
 */
export function simulateSession(opts: SimulateOptions = {}): SurgicalSession {
  const o = resolveSimulateOptions(opts);
  const rngs = createStreams(o.seed);
  const startedAt = o.startedAt;
  const durationMs = Math.max(1, Math.round(o.durationMin * MINUTE_MS));
  const endedAt = startedAt + durationMs;
  const gain = responseGain(o.reactivity, o.experience);

  const phases = planPhases(startedAt, durationMs, rngs.timeline);
  const markers = planMarkers(startedAt, endedAt, o.markerRate, o.experience, rngs.timeline);
  const dropouts = planDropouts(startedAt, endedAt, o.dropoutRate, rngs.dropout);

  const kernels: ResponseKernel[] = [];
  for (const m of markers) {
    const r = MARKER_RESPONSE[m.marker];
    if (r !== undefined) kernels.push({ onset: m.t, amp: r.amp * gain, tauMs: r.tauS * 1000 });
  }
  let phaseIndex = -1;
  const targetAt = (t: EpochMs): number => {
    if (t < startedAt) return 0;
    while (phaseIndex + 1 < phases.length && phases[phaseIndex + 1]!.t <= t) phaseIndex++;
    return phaseIndex < 0 ? 0 : PHASE_OFFSET_BPM[phases[phaseIndex]!.phase] * gain;
  };

  const baselineStart = startedAt - BASELINE_MS;
  const engine = createBeatEngine({
    origin: baselineStart - WARMUP_MS,
    driftStart: startedAt,
    deliveryAnchor: startedAt,
    restingHr: o.restingHr,
    artifactRate: o.artifactRate,
    targetAt,
    responseAt: (t) => responseSum(kernels, t),
    hrRng: rngs.hr,
    beatRng: rngs.beat,
    artifactRng: rngs.artifact,
  });

  // The beat sequence depends only on the random streams, never on which times we query, so the baseline
  // samples can be skipped when no baseline is wanted without changing anything else.
  const baselineSamples: HeartRateSample[] = [];
  if (o.withBaseline) {
    for (let k = 0; ; k++) {
      const t = baselineStart + Math.round(k * o.sampleIntervalMs);
      if (t >= startedAt) break;
      baselineSamples.push({ t, bpm: engine.bpmAt(t) });
    }
  }

  const samples: HeartRateSample[] = [];
  for (let k = 0; ; k++) {
    const t = startedAt + Math.round(k * o.sampleIntervalMs);
    if (t >= endedAt) break;
    if (inDropout(dropouts, t)) continue;
    samples.push({ t, bpm: engine.bpmAt(t) });
  }

  engine.advanceTo(endedAt);
  const delivered = engine.takeDelivered(endedAt);
  const baselineRr: RRInterval[] = [];
  const rr: RRInterval[] = [];
  for (const r of delivered) {
    if (r.t >= baselineStart && r.t < startedAt) baselineRr.push(r);
    else if (r.t >= startedAt && r.t < endedAt && !inDropout(dropouts, r.t)) rr.push(r);
  }

  let baseline: Baseline | null = null;
  if (o.withBaseline) {
    baseline = computeBaseline(baselineSamples, o.includeRr ? baselineRr : [], baselineStart, startedAt);
  }

  // Merge the (already sorted) phase and marker lists; phases first on ties. Ids follow the final order.
  const sessionId = uuidFromRng(rngs.id);
  const events: SessionEvent[] = [];
  let pi = 0;
  let mi = 0;
  while (pi < phases.length || mi < markers.length) {
    const p = phases[pi];
    const m = markers[mi];
    if (p !== undefined && (m === undefined || p.t <= m.t)) {
      events.push({ id: uuidFromRng(rngs.id), t: p.t, type: 'phase', phase: p.phase, loggedBy: 'self' });
      pi++;
    } else if (m !== undefined) {
      events.push({ id: uuidFromRng(rngs.id), t: m.t, type: 'marker', marker: m.marker, loggedBy: m.loggedBy });
      mi++;
    }
  }

  const snapshot: ParticipantSnapshot = {};
  if (o.trainingLevel !== undefined) snapshot.trainingLevel = o.trainingLevel;
  if (o.birthYear !== undefined) snapshot.birthYear = o.birthYear;
  snapshot.restingHr = o.restingHr;

  const session: SurgicalSession = {
    schemaVersion: SCHEMA_VERSION,
    id: sessionId,
    participantCode: o.participantCode,
    procedure: o.procedure,
    startedAt,
    endedAt,
    status: 'completed',
    sensor: { source: 'simulated', name: SENSOR_NAME, location: 'chest' },
    app: { version: SIM_APP_VERSION, platform: 'unknown' },
    participantSnapshot: snapshot,
    samples,
    rr: o.includeRr ? rr : [],
    events,
    tags: ['simulated'],
  };
  if (baseline !== null) session.baseline = baseline;
  if (o.withPostOp) {
    session.postOp = simulatePostOp({
      samples,
      restingHr: o.restingHr,
      markers,
      experience: o.experience,
      complexity: o.procedure.complexity ?? 3,
      endedAt,
      rng: rngs.postOp,
    });
  }
  return session;
}

// ---------------------------------------------------------------------------
// simulateCohort
// ---------------------------------------------------------------------------

/** Training levels assigned to participants in turn (2 consultants and 6 trainees per 8). */
const LEVEL_MIX: readonly TrainingLevel[] = [
  'consultant',
  'registrar',
  'resident',
  'fellow',
  'consultant',
  'resident',
  'intern',
  'registrar',
];

/** Experience (0–1) at the start of the study. */
const BASE_EXPERIENCE: Readonly<Record<TrainingLevel, number>> = {
  consultant: 0.85,
  fellow: 0.65,
  registrar: 0.45,
  resident: 0.25,
  intern: 0.1,
  student: 0.05,
  other: 0.5,
};

/** Years since graduation: [minimum, range]. */
const YEARS_EXPERIENCE: Readonly<Record<TrainingLevel, readonly [number, number]>> = {
  consultant: [8, 17],
  fellow: [5, 3],
  registrar: [3, 3],
  resident: [1, 2],
  intern: [0, 1],
  student: [0, 0],
  other: [2, 10],
};

const COMPLEXITY_WEIGHTS: readonly (readonly [1 | 2 | 3 | 4 | 5, number])[] = [
  [1, 0.1],
  [2, 0.3],
  [3, 0.35],
  [4, 0.18],
  [5, 0.07],
];
const URGENCY_WEIGHTS: readonly (readonly [Urgency, number])[] = [
  ['elective', 0.8],
  ['urgent', 0.15],
  ['emergency', 0.05],
];

/** Normalised negative-exponential learning curve: 0 at the first session, 1 at the last. */
function learningProgress(k: number, n: number): number {
  if (n <= 1) return 0;
  const x = k / (n - 1);
  return (1 - portableMath.exp(-2 * x)) / (1 - portableMath.exp(-2));
}

function catalogueSpecialties(): string[] {
  const out: string[] = [];
  for (const p of PROCEDURE_CATALOG) if (!out.includes(p.specialty)) out.push(p.specialty);
  return out;
}

/**
 * Simulates a longitudinal research cohort (SPEC.md › sim/simulate.ts).
 *
 * - Participants `SIM-001…` get a mix of training levels (consultants, fellows, registrars, residents, interns),
 *   a specialty, a resting HR, a trait reactivity, a birth year and a consent record.
 * - Each participant has `sessionsPerParticipant` sessions, `spacingDays` apart. Procedures come from
 *   `PROCEDURE_CATALOG` in the participant's specialty, with a random role, complexity and urgency. Duration and
 *   marker rate grow with complexity.
 * - **Learning curve:** experience grows along a negative-exponential curve across a participant's sessions
 *   (strongly for trainees, slightly for consultants), and trainees' reactivity habituates by up to 35 %. Since
 *   `gain = 0.5 + reactivity·(1 − 0.6·experience)`, trainees' HR response to the same procedure declines over time.
 * - A few sessions (≈ 8 %) have a loose strap with frequent dropouts, so the data-quality views have something to
 *   show.
 * - To stay under ≈ 25 MB of JSON, sessions use `sampleIntervalMs: 5000` and include RR only for every 3rd session
 *   of each participant (session index 0, 3, 6, …).
 *
 * Deterministic per seed (byte-identical JSON on every engine); never reads the clock.
 *
 * @throws RangeError for out-of-range options (see {@link SimulateCohortOptions}).
 */
export function simulateCohort(opts: SimulateCohortOptions = {}): SimulatedCohort {
  const fn = 'simulateCohort';
  const seed = seedOption(fn, opts.seed);
  const nParticipants = integerOption(fn, 'participants', opts.participants, 8, 0, 1000);
  const nSessions = integerOption(fn, 'sessionsPerParticipant', opts.sessionsPerParticipant, 12, 0, 1000);
  const start = epochOption(fn, 'start', opts.start, DEFAULT_STARTED_AT);
  const spacingMs = numberOption(fn, 'spacingDays', opts.spacingDays, 7, 0, 365) * DAY_MS;
  const startYear = new Date(start).getUTCFullYear();

  const specialties = catalogueSpecialties();
  const participants: ParticipantProfile[] = [];
  const planned: { session: SurgicalSession; p: number; k: number }[] = [];

  for (let p = 0; p < nParticipants; p++) {
    const rng = createRng(deriveSeed(seed, STREAM.cohort, p));
    const level = LEVEL_MIX[p % LEVEL_MIX.length]!;
    const trainee = level !== 'consultant';
    const code = `SIM-${String(p + 1).padStart(3, '0')}`;
    const specialty = specialties.length > 0 ? specialties[Math.floor(rng() * specialties.length)]! : undefined;
    const restingHr = Math.round(clamp(66 + 6 * gaussian(rng), 52, 82));
    const traitReactivity = clamp((trainee ? 0.55 : 0.3) + 0.4 * rng(), 0, 1);
    const [yearsMin, yearsRange] = YEARS_EXPERIENCE[level];
    const yearsExperience = yearsMin + Math.round(yearsRange * rng());
    const birthYear = startYear - (24 + yearsExperience + Math.round(4 * rng()));
    const artifactRate = 0.002 + 0.008 * rng();
    const baseExperience = BASE_EXPERIENCE[level];

    const profile: ParticipantProfile = { code, trainingLevel: level };
    if (specialty !== undefined) profile.specialty = specialty;
    profile.yearsExperience = yearsExperience;
    profile.birthYear = birthYear;
    profile.restingHr = restingHr;
    profile.consent = { version: 'PICF-1.0', givenAt: start - 14 * DAY_MS };
    participants.push(profile);

    const pool = PROCEDURE_CATALOG.filter((e) => e.specialty === specialty);
    const participantOffset = (p % 5) * DAY_MS;
    const jitterSpanMs = Math.min(6 * HOUR_MS, spacingMs / 2);

    for (let k = 0; k < nSessions; k++) {
      const progress = learningProgress(k, nSessions);
      const experience = clamp(baseExperience + (trainee ? 0.6 : 0.15) * (1 - baseExperience) * progress, 0, 1);
      const reactivity = clamp(traitReactivity * (1 - (trainee ? 0.35 : 0.05) * progress), 0, 1);

      const uProcedure = rng();
      const uRole = rng();
      const complexity = pickWeighted(COMPLEXITY_WEIGHTS, rng());
      const urgency = pickWeighted(URGENCY_WEIGHTS, rng());
      const uDuration = rng();
      const uDropout = rng();
      const uJitter = rng();
      const dayRestingHr = Math.round(clamp(restingHr + 2 * gaussian(rng), 45, 95));

      const entry = pool.length > 0 ? pool[Math.floor(uProcedure * pool.length)]! : undefined;
      const role: SurgeonRole = trainee
        ? uRole < 0.65
          ? 'primary'
          : 'assistant'
        : uRole < 0.7
          ? 'primary'
          : 'supervising';
      const approach: SurgicalApproach = entry?.defaultApproach ?? 'open';
      const procedure: ProcedureInfo =
        entry !== undefined
          ? { name: entry.name, catalogId: entry.id, specialty: entry.specialty, approach, role, complexity, urgency }
          : { ...defaultProcedure(), role, complexity, urgency };

      const urgencyMarkers = urgency === 'emergency' ? 0.6 : urgency === 'urgent' ? 0.3 : 0;
      const startedAt =
        start + participantOffset + k * spacingMs + Math.floor((uJitter * jitterSpanMs) / MINUTE_MS) * MINUTE_MS;

      const session = simulateSession({
        seed: deriveSeed(seed, STREAM.cohortSession, p, k),
        participantCode: code,
        procedure,
        startedAt,
        durationMin: Math.round(35 + 22 * complexity + 30 * uDuration),
        restingHr: dayRestingHr,
        reactivity,
        experience,
        sampleIntervalMs: 5000,
        includeRr: k % 3 === 0,
        artifactRate,
        dropoutRate: uDropout < 0.08 ? 0.6 : 0.02,
        markerRate: 0.6 + 0.25 * (complexity - 1) + urgencyMarkers,
        withBaseline: true,
        withPostOp: true,
        trainingLevel: level,
        birthYear,
      });
      // The snapshot reflects the participant's profile; the day's resting HR shows up in the measured baseline.
      session.participantSnapshot = { ...session.participantSnapshot, restingHr };
      planned.push({ session, p, k });
    }
  }

  // Total order (no ties), so the result doesn't depend on the engine's sort stability.
  planned.sort((a, b) => a.session.startedAt - b.session.startedAt || a.p - b.p || a.k - b.k);
  return { participants, sessions: planned.map((x) => x.session) };
}

// ---------------------------------------------------------------------------
// createLiveSimulator
// ---------------------------------------------------------------------------

/**
 * Real-time simulated sensor for the app's demo mode (SPEC.md › sim/simulate.ts). It uses the same physiology
 * as {@link simulateSession}, at 1 Hz with RR. HR starts at rest (no phase until {@link LiveSimulator.setPhase}).
 * `trigger('complication')` visibly raises HR within seconds (+15·gain bpm, decaying with τ = 180 s), and
 * `setPhase('critical')` raises it over the next minutes (+22·gain, through the 45 s lag).
 *
 * `startedAt` defaults to the `now` of the first `tick` call (that call returns no data), so the simulator never
 * reads the clock itself. The caller supplies time, e.g. `tick(Date.now())` once a second. Output is
 * deterministic for a given seed and sequence of calls.
 *
 * @throws RangeError for out-of-range options (see {@link LiveSimulatorOptions}).
 */
export function createLiveSimulator(opts: LiveSimulatorOptions = {}): LiveSimulator {
  const fn = 'createLiveSimulator';
  const seed = seedOption(fn, opts.seed);
  const restingHr = numberOption(fn, 'restingHr', opts.restingHr, DEFAULT_RESTING_HR, 30, 150);
  const reactivity = numberOption(fn, 'reactivity', opts.reactivity, 0.5, 0, 1);
  const experience = numberOption(fn, 'experience', opts.experience, 0.5, 0, 1);
  const artifactRate = numberOption(fn, 'artifactRate', opts.artifactRate, 0.005, 0, 0.5);
  const startedAtOption =
    opts.startedAt === undefined ? undefined : epochOption(fn, 'startedAt', opts.startedAt, 0);
  const gain = responseGain(reactivity, experience);
  const rngs = createStreams(seed);

  const kernels: ResponseKernel[] = [];
  const pending: { amp: number; tauMs: number }[] = [];
  let target = 0;
  let engine: BeatEngine | null = null;
  let anchor = 0;
  let lastNow = 0;
  let sampleIndex = 1;

  const start = (at: EpochMs): void => {
    anchor = at;
    lastNow = at;
    sampleIndex = 1;
    engine = createBeatEngine({
      origin: at - WARMUP_MS,
      driftStart: at,
      deliveryAnchor: at,
      restingHr,
      artifactRate,
      targetAt: () => target,
      responseAt: (t) => responseSum(kernels, t),
      hrRng: rngs.hr,
      beatRng: rngs.beat,
      artifactRng: rngs.artifact,
    });
    for (const p of pending) kernels.push({ onset: at, amp: p.amp, tauMs: p.tauMs });
    pending.length = 0;
    // Warm-up beats (before `startedAt`) only prime the strap-style HR average; they are never emitted.
    engine.advanceTo(at);
    engine.takeDelivered(at);
  };
  if (startedAtOption !== undefined) start(startedAtOption);

  return {
    tick(now: EpochMs): LiveSimulatorTick {
      if (typeof now !== 'number' || !Number.isFinite(now)) return { samples: [], rr: [] };
      if (engine === null) {
        start(now);
        return { samples: [], rr: [] };
      }
      if (!(now > lastNow)) return { samples: [], rr: [] };
      if (now - lastNow > LIVE_MAX_CATCH_UP_MS) {
        const resume = now - LIVE_MAX_CATCH_UP_MS;
        engine.skipTo(resume);
        sampleIndex = Math.floor((resume - anchor) / LIVE_SAMPLE_INTERVAL_MS) + 1;
      }
      const samples: HeartRateSample[] = [];
      for (;;) {
        const t = anchor + sampleIndex * LIVE_SAMPLE_INTERVAL_MS;
        if (t > now) break;
        samples.push({ t, bpm: engine.bpmAt(t) });
        sampleIndex++;
      }
      engine.advanceTo(now);
      const rr = engine.takeDelivered(now);
      lastNow = now;
      return { samples, rr };
    },
    setPhase(phase: PhaseKind): void {
      const offset: unknown = (PHASE_OFFSET_BPM as Readonly<Record<string, unknown>>)[phase];
      if (typeof offset === 'number' && Object.prototype.hasOwnProperty.call(PHASE_OFFSET_BPM, phase)) {
        target = offset * gain;
      }
    },
    trigger(marker: MarkerKind): void {
      if (!Object.prototype.hasOwnProperty.call(MARKER_RESPONSE, marker)) return;
      const r = MARKER_RESPONSE[marker];
      if (r === undefined) return;
      const kernel = { amp: r.amp * gain, tauMs: r.tauS * 1000 };
      if (engine === null) {
        pending.push(kernel);
        return;
      }
      // Drop responses that have faded out so a long demo doesn't accumulate them.
      for (let i = kernels.length - 1; i >= 0; i--) {
        const k = kernels[i]!;
        if (lastNow - k.onset > RESPONSE_HORIZON_TAUS * k.tauMs) kernels.splice(i, 1);
      }
      kernels.push({ onset: lastNow, ...kernel });
    },
  };
}
