/**
 * Per-session summary used by the app, the dashboard, CSV export and the insight engine.
 */
import { MARKER_KINDS } from '../types';
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
import { detectGaps, hrStats, isValidBpm, sliceByTime } from './hr';
import { hrvFromValidity, resolveMaxGapMs } from './internal';
import { derivePhases, sessionEnd } from './phases';
import { baevskyStressIndex, cleanRr, computeHrv } from './rr';
import { stableSortBy } from './stats';
import { estimateMaxHr, timeInZones, zonesFromBaseline, zonesFromMaxHr } from './zones';

/** Options for {@link summarizeSession}. */
export interface SummaryOptions {
  /** Max HR override (bpm); otherwise the participant snapshot, otherwise Tanaka (2001) from birthYear. */
  maxHr?: number;
  /** Year used for the age-predicted max HR. Default: the UTC year of `startedAt`. */
  atYear?: number;
  /** Stress-episode threshold override (bpm). Default: {@link defaultEpisodeThreshold}. */
  episodeThresholdBpm?: number;
  /** Largest sample spacing treated as continuous data (default 5000 ms; `NaN` also means the default). */
  maxGapMs?: number;
}

/**
 * A resting or maximum heart rate is used only when it is a plausible bpm ({@link isValidBpm}: finite, within
 * [25, 250]); anything else (e.g. a `0` meaning "not entered") counts as missing.
 */
function bpmOrNull(x: number | undefined | null): number | null {
  return typeof x === 'number' && isValidBpm(x) ? x : null;
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
 * - Covered time is `Σ min(t[i+1] − t[i], maxGapMs)` over consecutive valid samples ({@link isValidBpm}), with
 *   each interval `[t[i], t[i] + dwell]` clipped to the session window; `coverage = min(1, covered/duration)`.
 * - `gapCount` / `longestGapSec` come from `detectGaps(samples, maxGapMs)`.
 * - `sampleRateHz = max(0, inWindow − 1) / (covered/1000)` when covered > 0, else 0, where `inWindow` counts the
 *   valid samples with `startedAt ≤ t ≤ sessionEnd` — the same window the covered time is clipped to, so samples
 *   recorded before the start or after the end do not inflate the rate.
 * - `rrArtifactRatio` is the `cleanRr` artefact ratio, or `null` without RR data.
 *
 * @param maxGapMs Default 5000 ms; `NaN` also means the default.
 */
export function dataQuality(session: SurgicalSession, maxGapMs = 5000): DataQuality {
  return qualityWith(session, resolveMaxGapMs(maxGapMs), session.rr.length > 0 ? cleanRr(session.rr).report.ratio : null);
}

/** {@link dataQuality} with the RR artefact ratio supplied by the caller (so a summary cleans RR only once). */
function qualityWith(session: SurgicalSession, maxGapMs: number, rrArtifactRatio: number | null): DataQuality {
  const start = session.startedAt;
  const end = sessionEnd(session);
  const duration = end - start;
  const valid = stableSortBy(
    session.samples.filter((s) => isValidBpm(s.bpm) && Number.isFinite(s.t)),
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
 * - Whole-session HR ({@link hrStats}), HRV ({@link computeHrv}, Task Force of ESC/NASPE 1996) and Baevsky
 *   stress index over the artefact-free RR intervals.
 * - Baseline: `session.baseline`, else a `'profile'` baseline from `participantSnapshot.restingHr`, else null.
 *   A resting HR that is not a plausible bpm (finite, 25–250) counts as missing, so e.g. `restingHr: 0` never
 *   yields zones from 0 bpm or a 20 bpm episode threshold.
 * - Max HR: `opts.maxHr ?? participantSnapshot.maxHr ??` Tanaka (2001) `208 − 0.7·age` from `birthYear`
 *   (age at `opts.atYear ??` the UTC year of `startedAt`), else null; each candidate is used only when it is a
 *   plausible bpm (25–250), otherwise the next one is tried.
 * - Zones: baseline-relative zones when a baseline exists, else %HRmax zones, else `[]`.
 * - `highIntensityFraction`: time-weighted fraction of dwell time with bpm ≥ 70 % of max HR; null without
 *   max HR or when no dwell time was recorded (fewer than two valid samples), because 0/0 is "not enough data",
 *   not "no time at high intensity".
 * - RR is cleaned once ({@link cleanRr}); the whole-session HRV, artefact report, stress index and data quality all
 *   reuse that result.
 * - Per-phase HR/HRV on `[start, end)` (HRV with `minIntervals: 20`), stress episodes, marker counts,
 *   SURG-TLX/NASA-TLX score, self-ratings and data quality.
 */
export function summarizeSession(session: SurgicalSession, opts: SummaryOptions = {}): SessionSummary {
  const maxGapMs = resolveMaxGapMs(opts.maxGapMs);
  const startedAt = session.startedAt;
  const endedAt = sessionEnd(session);
  const snapshot = session.participantSnapshot;

  const hr = hrStats(session.samples);
  // One cleaning pass over the whole RR series (it dominates the cost of a summary, especially on Hermes).
  const cleaned = cleanRr(session.rr);
  const artifacts = cleaned.report;
  const hrv = hrvFromValidity(session.rr, cleaned.valid, 3000, 30).hrv;
  const validRrMs: number[] = [];
  for (let i = 0; i < session.rr.length; i++) if (cleaned.valid[i]) validRrMs.push(session.rr[i]!.ms);
  const stressIndex = baevskyStressIndex(validRrMs);

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

  let maxHr = bpmOrNull(opts.maxHr) ?? bpmOrNull(snapshot?.maxHr);
  if (maxHr === null && typeof snapshot?.birthYear === 'number' && Number.isFinite(snapshot.birthYear)) {
    const atYear = opts.atYear ?? new Date(startedAt).getUTCFullYear();
    if (Number.isFinite(atYear)) maxHr = bpmOrNull(estimateMaxHr(snapshot.birthYear, atYear));
  }

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
    const phaseHrv = computeHrv(sliceByTime(session.rr, seg.start, seg.end), { minIntervals: 20 }).hrv;
    return {
      phase: seg.phase,
      index: seg.index,
      start: seg.start,
      end: seg.end,
      durationSec: (seg.end - seg.start) / 1000,
      hr: phaseHr,
      hrv: phaseHrv,
      meanHrDelta: phaseHr !== null && restingHr !== null ? phaseHr.mean - restingHr : null,
    };
  });

  const threshold = opts.episodeThresholdBpm ?? defaultEpisodeThreshold(baseline, hr);
  const episodes =
    threshold !== null && Number.isFinite(threshold)
      ? detectStressEpisodes(session.samples, { thresholdBpm: threshold }, { segments, events: session.events })
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
    peakHrDelta: hr !== null && restingHr !== null ? hr.max - restingHr : null,
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
  };
  return summary;
}
