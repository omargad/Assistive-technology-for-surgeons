/**
 * Per-session summary used by the app, the dashboard, CSV export and the insight engine.
 */
import { ANALYTICS_VERSION, MARKER_KINDS } from '../types';
import type {
  Baseline,
  DataQuality,
  MarkerKind,
  PhaseSummary,
  SessionSummary,
  SurgicalSession,
  ZoneDefinition,
} from '../types';
import { scoreWorkload } from '../instruments/tlx';
import { defaultEpisodeThreshold, detectStressEpisodes } from './episodes';
import { detectGaps, hrStats, isValidBpm, isValidSample, robustPeakHr, sliceByTime } from './hr';
import { DEFAULT_MAX_GAP_MS, hrvFromValidity } from './internal';
import { derivePhases, sessionEnd } from './phases';
import { MAX_HRV_ARTIFACT_RATIO, cleanRr, computeHrv, windowedStressIndex } from './rr';
import { median, stableSortBy } from './stats';
import { estimateMaxHr, timeInZones, zonesFromBaseline, zonesFromMaxHr } from './zones';

/** Options for {@link summarizeSession}. */
export interface SummaryOptions {
  /** Max HR override (bpm); otherwise the participant snapshot, otherwise Tanaka (2001) from birthYear. */
  maxHr?: number;
  /** Year used for the age-predicted max HR. Default: the UTC year of `startedAt`. */
  atYear?: number;
  /** Stress-episode threshold override (bpm). Default: {@link defaultEpisodeThreshold}. */
  episodeThresholdBpm?: number;
  /**
   * Largest sample spacing treated as continuous data. Default (also for `NaN`): {@link effectiveMaxGapMs} — 5000 ms,
   * or more for sparse health-store (watch) data.
   */
  maxGapMs?: number;
}

/** Shortest phase (s) whose HRV is reported; ultra-short RMSSD is unreliable below about a minute. */
export const MIN_PHASE_HRV_SEC = 60;
/** Upper limit of the data-driven gap rule for health-store data (15 min). */
const MAX_HEALTH_STORE_GAP_MS = 900_000;
/** Tags that mark synthetic data (the simulator's and the app's demo mode). */
const SYNTHETIC_TAGS: readonly string[] = ['simulated', 'demo'];

/**
 * The gap rule used for coverage, zone dwell and stress episodes when the caller gives no `maxGapMs` (an explicit
 * number other than `NaN` is used as given).
 *
 * Chest straps send about one sample per second, so 5000 ms ({@link DEFAULT_MAX_GAP_MS}) separates real dropouts
 * from normal spacing. Health-store imports (`healthkit`, `health-connect`) are sampled far more sparsely (often
 * once a minute or every few minutes), so for them the rule is `1.5 ×` the median spacing of consecutive valid
 * samples, at least 5000 ms and at most 15 min; with that, regular watch data is not reported as 90 % gaps.
 */
export function effectiveMaxGapMs(session: SurgicalSession, maxGapMs?: number): number {
  if (typeof maxGapMs === 'number' && !Number.isNaN(maxGapMs)) return maxGapMs;
  const source = session.sensor?.source;
  if (source !== 'healthkit' && source !== 'health-connect') return DEFAULT_MAX_GAP_MS;
  const ts: number[] = [];
  for (const x of session.samples) if (isValidSample(x) && Number.isFinite(x.t)) ts.push(x.t);
  ts.sort((a, b) => a - b);
  const spacing: number[] = [];
  for (let i = 1; i < ts.length; i++) if (ts[i]! > ts[i - 1]!) spacing.push(ts[i]! - ts[i - 1]!);
  const m = median(spacing);
  if (m === null) return DEFAULT_MAX_GAP_MS;
  return Math.min(MAX_HEALTH_STORE_GAP_MS, Math.max(DEFAULT_MAX_GAP_MS, 1.5 * m));
}

/** True for synthetic sessions: sensor source `simulated`, or a `simulated` / `demo` tag. */
export function isSyntheticSession(session: Pick<SurgicalSession, 'sensor' | 'tags'>): boolean {
  if (session.sensor?.source === 'simulated') return true;
  return (session.tags ?? []).some((t) => SYNTHETIC_TAGS.includes(t));
}

/**
 * A resting or maximum heart rate is used only when it is a plausible bpm ({@link isValidBpm}: finite, within
 * [25, 250]); anything else (e.g. a `0` meaning "not entered") counts as missing.
 */
function bpmOrNull(x: number | undefined | null): number | null {
  return typeof x === 'number' && isValidBpm(x) ? x : null;
}

/**
 * The max HR {@link summarizeSession} uses for a session's %HRmax zones and `highIntensityFraction`:
 * `opts.maxHr ?? participantSnapshot.maxHr ??` Tanaka (2001) `208 − 0.7·age` from `participantSnapshot.birthYear`
 * (age at `opts.atYear ??` the UTC year of `startedAt`), else null. Each candidate is used only when it is a
 * plausible bpm (25–250), otherwise the next one is tried. Exported so a live display can colour zones exactly as
 * the stored summary will (from the session's own snapshot, not the current profile or the local calendar year).
 */
export function sessionMaxHr(
  session: Pick<SurgicalSession, 'startedAt' | 'participantSnapshot'>,
  opts: Pick<SummaryOptions, 'maxHr' | 'atYear'> = {},
): number | null {
  const snapshot = session.participantSnapshot;
  let maxHr = bpmOrNull(opts.maxHr) ?? bpmOrNull(snapshot?.maxHr);
  if (maxHr === null && typeof snapshot?.birthYear === 'number' && Number.isFinite(snapshot.birthYear)) {
    const atYear = opts.atYear ?? new Date(session.startedAt).getUTCFullYear();
    if (Number.isFinite(atYear)) maxHr = bpmOrNull(estimateMaxHr(snapshot.birthYear, atYear));
  }
  return maxHr;
}

/**
 * A fresh copy of a baseline with its keys in `types.ts` order. The summary therefore never shares an object with
 * the input session (a consumer editing `summary.baseline` cannot reach into the session), and it serialises to
 * the same JSON whatever produced the session: the app, the simulator, or `parseImport`, whose zod output orders
 * keys differently.
 */
function copyBaseline(b: Baseline): Baseline {
  const out: Partial<Baseline> = { startedAt: b.startedAt, endedAt: b.endedAt, restingHr: b.restingHr };
  if (b.rmssd !== undefined) out.rmssd = b.rmssd;
  if (b.sdnn !== undefined) out.sdnn = b.sdnn;
  out.source = b.source;
  return out as Baseline;
}

/**
 * Signal-quality metrics for a session.
 *
 * - `duration = sessionEnd − startedAt`; when ≤ 0, `coverage` is 0.
 * - Covered time is `Σ min(t[i+1] − t[i], maxGapMs)` over consecutive valid samples ({@link isValidSample}: valid
 *   bpm and not recorded with `contact: false`, so lost skin contact shows up as missing coverage), with
 *   each interval `[t[i], t[i] + dwell]` clipped to the session window; `coverage = min(1, covered/duration)`.
 * - `gapCount` / `longestGapSec` come from `detectGaps(samples, maxGapMs)`.
 * - `sampleRateHz = max(0, inWindow − 1) / (covered/1000)` when covered > 0, else 0, where `inWindow` counts the
 *   valid samples with `startedAt ≤ t ≤ sessionEnd` — the same window the covered time is clipped to, so samples
 *   recorded before the start or after the end do not inflate the rate.
 * - `rrArtifactRatio` is the `cleanRr` artefact ratio, or `null` without RR data.
 *
 * @param maxGapMs Default (also for `NaN`): {@link effectiveMaxGapMs}.
 */
export function dataQuality(session: SurgicalSession, maxGapMs?: number): DataQuality {
  return qualityWith(
    session,
    effectiveMaxGapMs(session, maxGapMs),
    session.rr.length > 0 ? cleanRr(session.rr).report.ratio : null,
  );
}

/** {@link dataQuality} with the RR artefact ratio supplied by the caller (so a summary cleans RR only once). */
function qualityWith(session: SurgicalSession, maxGapMs: number, rrArtifactRatio: number | null): DataQuality {
  const start = session.startedAt;
  const end = sessionEnd(session);
  const duration = end - start;
  const valid = stableSortBy(
    session.samples.filter((s) => isValidSample(s) && Number.isFinite(s.t)),
    (s) => s.t,
  );
  let covered = 0;
  let inWindow = 0;
  for (let i = 0; i < valid.length; i++) {
    const a = valid[i]!.t;
    if (a >= start && a <= end) inWindow++;
    if (i + 1 >= valid.length) break;
    const dwell = Math.min(valid[i + 1]!.t - a, maxGapMs);
    const lo = Math.max(a, start);
    const hi = Math.min(a + dwell, end);
    if (hi > lo) covered += hi - lo;
  }
  const coverage = duration > 0 ? Math.min(1, covered / duration) : 0;
  const gaps = detectGaps(session.samples, maxGapMs);
  let longestGapMs = 0;
  for (const g of gaps) if (g.durationMs > longestGapMs) longestGapMs = g.durationMs;
  return {
    coverage,
    gapCount: gaps.length,
    longestGapSec: longestGapMs / 1000,
    rrArtifactRatio,
    sampleRateHz: covered > 0 ? Math.max(0, inWindow - 1) / (covered / 1000) : 0,
  };
}

/**
 * Computes the full {@link SessionSummary} of a session (see SPEC.md "analytics/summary.ts").
 *
 * - Whole-session HR ({@link hrStats}) and HRV ({@link computeHrv}, Task Force of ESC/NASPE 1996) over the
 *   artefact-free RR intervals; the Baevsky stress index is {@link windowedStressIndex} (median over 5-min windows),
 *   so it does not drift with case length. HRV and the stress index are null when more than
 *   {@link MAX_HRV_ARTIFACT_RATIO} of the intervals were removed as artefacts.
 * - Samples recorded with `contact: false` are ignored everywhere ({@link isValidSample}).
 * - `maxGapMs`: {@link effectiveMaxGapMs} unless given (larger for sparse watch data); used for coverage, zone dwell
 *   and the stress-episode run rule, and reported as `summary.maxGapMs`.
 * - `peakHr` = {@link robustPeakHr} (highest 11-s rolling median) and `peakHrDelta = peakHr − restingHr`, so a single
 *   spike cannot dominate; `hr.max` stays the raw maximum.
 * - Baseline: `session.baseline`, else a `'profile'` baseline from `participantSnapshot.restingHr`, else null.
 *   A resting HR that is not a plausible bpm (finite, 25–250) counts as missing, so e.g. `restingHr: 0` never
 *   yields zones from 0 bpm or a 20 bpm episode threshold.
 * - Max HR ({@link sessionMaxHr}): `opts.maxHr ?? participantSnapshot.maxHr ??` Tanaka (2001) `208 − 0.7·age`
 *   from `birthYear` (age at `opts.atYear ??` the UTC year of `startedAt`), else null; each candidate is used only
 *   when it is a plausible bpm (25–250), otherwise the next one is tried.
 * - Zones: baseline-relative zones when a baseline exists, else %HRmax zones, else `[]`.
 * - `highIntensityFraction`: time-weighted fraction of dwell time with bpm ≥ 70 % of max HR; null without
 *   max HR or when no dwell time was recorded (fewer than two valid samples), because 0/0 is "not enough data",
 *   not "no time at high intensity".
 * - RR is cleaned once ({@link cleanRr}); the whole-session HRV, artefact report, stress index and data quality all
 *   reuse that result.
 * - Per-phase HR/HRV on `[start, end)` (HRV with `minIntervals: 20`, only for phases of at least
 *   {@link MIN_PHASE_HRV_SEC} s and at most {@link MAX_HRV_ARTIFACT_RATIO} artefacts), stress episodes, marker
 *   counts, SURG-TLX/NASA-TLX score, self-ratings and data quality.
 * - Provenance and covariates: `sensorSource`, `simulated` ({@link isSyntheticSession}), `tzOffsetMin` (omitted when
 *   unknown), `sleepHours`/`caffeine`/`outcome` from postOp (null when unanswered), `maxGapMs` and
 *   `analyticsVersion` ({@link ANALYTICS_VERSION}).
 */
export function summarizeSession(session: SurgicalSession, opts: SummaryOptions = {}): SessionSummary {
  const maxGapMs = effectiveMaxGapMs(session, opts.maxGapMs);
  const startedAt = session.startedAt;
  const endedAt = sessionEnd(session);
  const snapshot = session.participantSnapshot;

  const hr = hrStats(session.samples);
  // One cleaning pass over the whole RR series (it dominates the cost of a summary, especially on Hermes).
  const cleaned = cleanRr(session.rr);
  const artifacts = cleaned.report;
  // Too many removed beats: the HRV would describe the artefact cleaning, not the heart.
  const rrUsable = artifacts.ratio <= MAX_HRV_ARTIFACT_RATIO;
  const hrv = rrUsable ? hrvFromValidity(session.rr, cleaned.valid, 3000, 30).hrv : null;
  const stressIndex = rrUsable ? windowedStressIndex(session.rr, cleaned.valid) : null;
  const peakHr = robustPeakHr(session.samples);

  let baseline: Baseline | null =
    session.baseline !== undefined && bpmOrNull(session.baseline.restingHr) !== null
      ? copyBaseline(session.baseline)
      : null;
  if (baseline === null && snapshot !== undefined) {
    const restingHr = bpmOrNull(snapshot.restingHr);
    if (restingHr !== null) {
      baseline = copyBaseline({ source: 'profile', restingHr, startedAt, endedAt: startedAt });
    }
  }
  const restingHr = baseline !== null ? baseline.restingHr : null;

  const maxHr = sessionMaxHr(session, opts);

  let zoneDefs: ZoneDefinition[] = [];
  if (restingHr !== null) zoneDefs = zonesFromBaseline(restingHr);
  else if (maxHr !== null) zoneDefs = zonesFromMaxHr(maxHr);
  const zones = zoneDefs.length > 0 ? timeInZones(session.samples, zoneDefs, maxGapMs) : [];

  let highIntensityFraction: number | null = null;
  if (maxHr !== null) {
    const threshold = (maxHr * 70) / 100;
    const split = timeInZones(
      session.samples,
      [
        { id: 'below', label: 'below', minBpm: Number.NEGATIVE_INFINITY, maxBpm: threshold },
        { id: 'high', label: 'high', minBpm: threshold, maxBpm: Number.POSITIVE_INFINITY },
      ],
      maxGapMs,
    );
    const total = split[0]!.seconds + split[1]!.seconds;
    highIntensityFraction = total > 0 ? split[1]!.fraction : null;
  }

  const segments = derivePhases(session);
  const phases: PhaseSummary[] = segments.map((seg) => {
    const phaseHr = hrStats(sliceByTime(session.samples, seg.start, seg.end));
    const durationSec = (seg.end - seg.start) / 1000;
    let phaseHrv: PhaseSummary['hrv'] = null;
    if (durationSec >= MIN_PHASE_HRV_SEC) {
      const res = computeHrv(sliceByTime(session.rr, seg.start, seg.end), { minIntervals: 20 });
      if (res.artifacts.ratio <= MAX_HRV_ARTIFACT_RATIO) phaseHrv = res.hrv;
    }
    return {
      phase: seg.phase,
      index: seg.index,
      start: seg.start,
      end: seg.end,
      durationSec,
      hr: phaseHr,
      hrv: phaseHrv,
      meanHrDelta: phaseHr !== null && restingHr !== null ? phaseHr.mean - restingHr : null,
    };
  });

  const threshold = opts.episodeThresholdBpm ?? defaultEpisodeThreshold(baseline, hr);
  const episodes =
    threshold !== null && Number.isFinite(threshold)
      ? detectStressEpisodes(
          session.samples,
          { thresholdBpm: threshold, maxSampleGapMs: maxGapMs },
          { segments, events: session.events },
        )
      : [];

  const counts = new Map<MarkerKind, number>();
  for (const e of session.events) {
    if (e.type === 'marker') counts.set(e.marker, (counts.get(e.marker) ?? 0) + 1);
  }
  const markerCounts: Partial<Record<MarkerKind, number>> = {};
  for (const kind of MARKER_KINDS) {
    const c = counts.get(kind);
    if (c !== undefined && c > 0) markerCounts[kind] = c;
  }

  const postOp = session.postOp;
  const procedure = session.procedure;
  const summary: SessionSummary = {
    sessionId: session.id,
    participantCode: session.participantCode,
    procedureName: procedure.name,
    ...(procedure.specialty !== undefined ? { specialty: procedure.specialty } : {}),
    ...(procedure.approach !== undefined ? { approach: procedure.approach } : {}),
    ...(procedure.role !== undefined ? { role: procedure.role } : {}),
    ...(procedure.urgency !== undefined ? { urgency: procedure.urgency } : {}),
    ...(procedure.complexity !== undefined ? { complexity: procedure.complexity } : {}),
    ...(snapshot?.trainingLevel !== undefined ? { trainingLevel: snapshot.trainingLevel } : {}),
    startedAt,
    endedAt,
    durationSec: (endedAt - startedAt) / 1000,
    hr,
    hrv,
    rrArtifacts: session.rr.length > 0 ? artifacts : null,
    stressIndex,
    baseline,
    meanHrDelta: hr !== null && restingHr !== null ? hr.mean - restingHr : null,
    peakHrDelta: peakHr !== null && restingHr !== null ? peakHr - restingHr : null,
    maxHr,
    zones,
    highIntensityFraction,
    phases,
    episodes,
    markerCounts,
    workload: postOp?.workload ? scoreWorkload(postOp.workload) : null,
    performance: postOp?.performance ?? null,
    perceivedStress: postOp?.perceivedStress ?? null,
    quality: qualityWith(session, maxGapMs, session.rr.length > 0 ? artifacts.ratio : null),
    peakHr,
    sensorSource: session.sensor.source,
    simulated: isSyntheticSession(session),
    ...(typeof session.tzOffsetMin === 'number' && Number.isFinite(session.tzOffsetMin)
      ? { tzOffsetMin: session.tzOffsetMin }
      : {}),
    sleepHours: postOp?.sleepHours ?? null,
    caffeine: postOp?.caffeine ?? null,
    outcome: postOp?.outcome ?? null,
    maxGapMs,
    analyticsVersion: ANALYTICS_VERSION,
  };
  return summary;
}
