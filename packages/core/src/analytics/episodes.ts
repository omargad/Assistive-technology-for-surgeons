/**
 * Sustained heart-rate elevation ("stress episode") detection.
 */
import type {
  Baseline,
  HeartRateSample,
  HrStats,
  PhaseSegment,
  SessionEvent,
  StressEpisode,
} from '../types';
import { isValidBpm } from './hr';
import { phaseAt } from './phases';
import { stableSortBy } from './stats';

/** A data gap longer than this (ms) always ends a run of elevated samples. */
const EPISODE_MAX_SAMPLE_GAP_MS = 5000;
/** Events up to this long (ms) before an episode starts count as related to it. */
const RELATED_EVENT_LOOKBACK_MS = 120000;

/** Options for {@link detectStressEpisodes}. */
export interface StressEpisodeOptions {
  /** Samples with `bpm ≥ thresholdBpm` are elevated. */
  thresholdBpm: number;
  /** Shortest episode kept, `end − start` (default 60000 ms). */
  minDurationMs?: number;
  /** Runs separated by at most this much time are merged (default 30000 ms). */
  mergeGapMs?: number;
}

/** Optional context used to annotate episodes. */
export interface StressEpisodeContext {
  /** Phase segments (from `derivePhases`) used to label the phase at the peak. */
  segments?: readonly PhaseSegment[];
  /** Session events, used to list events within [start − 2 min, end]. */
  events?: readonly SessionEvent[];
}

/**
 * Default threshold for a stress episode: `baseline.restingHr + 20` bpm when a baseline exists, otherwise the
 * session's median HR + 15 bpm, or `null` without heart-rate data.
 */
export function defaultEpisodeThreshold(
  baseline: Baseline | null | undefined,
  hr: HrStats | null,
): number | null {
  if (baseline != null && Number.isFinite(baseline.restingHr)) return baseline.restingHr + 20;
  if (hr !== null) return hr.median + 15;
  return null;
}

interface Run {
  start: number;
  end: number;
  samples: HeartRateSample[];
}

/**
 * Detects sustained heart-rate elevations.
 *
 * 1. Maximal runs of consecutive valid samples with `bpm ≥ thresholdBpm`. A run breaks on a valid sample below
 *    the threshold or on a data gap > 5000 ms between consecutive valid samples (invalid samples are skipped).
 *    A run starts at its first sample t and ends at its last sample t.
 * 2. Runs separated by `≤ mergeGapMs` (earlier run's end → later run's start) are merged.
 * 3. Merged episodes with `end − start ≥ minDurationMs` are kept.
 * 4. `peakBpm`/`peakT` is the maximum of the episode's above-threshold samples (first occurrence wins),
 *    `meanBpm` their mean, `phase = phaseAt(segments, peakT)` (omitted when unknown) and `relatedEventIds` the
 *    ids of events with `start − 120000 ≤ t ≤ end`, in time order.
 */
export function detectStressEpisodes(
  samples: readonly HeartRateSample[],
  opts: StressEpisodeOptions,
  context: StressEpisodeContext = {},
): StressEpisode[] {
  const threshold = opts.thresholdBpm;
  const minDurationMs = opts.minDurationMs ?? 60000;
  const mergeGapMs = opts.mergeGapMs ?? 30000;
  const valid = stableSortBy(
    samples.filter((s) => isValidBpm(s.bpm) && Number.isFinite(s.t)),
    (s) => s.t,
  );

  // 1. Runs of elevated samples.
  const runs: Run[] = [];
  let current: Run | null = null;
  let prevT: number | null = null;
  for (const s of valid) {
    const gapBreak = prevT !== null && s.t - prevT > EPISODE_MAX_SAMPLE_GAP_MS;
    prevT = s.t;
    if (!(s.bpm >= threshold)) {
      current = null;
      continue;
    }
    if (current === null || gapBreak) {
      current = { start: s.t, end: s.t, samples: [s] };
      runs.push(current);
    } else {
      current.end = s.t;
      current.samples.push(s);
    }
  }

  // 2. Merge runs separated by ≤ mergeGapMs.
  const merged: Run[] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last !== undefined && run.start - last.end <= mergeGapMs) {
      last.end = run.end;
      // A loop rather than push(...xs): spreading long arrays can exceed engine argument limits (Hermes).
      for (const s of run.samples) last.samples.push(s);
    } else {
      merged.push({ start: run.start, end: run.end, samples: run.samples.slice() });
    }
  }

  const segments = context.segments ?? [];
  const events = context.events ? stableSortBy(context.events, (e) => e.t) : [];

  // 3–4. Filter by duration and describe.
  const out: StressEpisode[] = [];
  for (const ep of merged) {
    if (!(ep.end - ep.start >= minDurationMs)) continue;
    let peak = ep.samples[0]!;
    let sum = 0;
    for (const s of ep.samples) {
      sum += s.bpm;
      if (s.bpm > peak.bpm) peak = s;
    }
    const lookFrom = ep.start - RELATED_EVENT_LOOKBACK_MS;
    const relatedEventIds: string[] = [];
    for (const e of events) if (e.t >= lookFrom && e.t <= ep.end) relatedEventIds.push(e.id);
    const phase = phaseAt(segments, peak.t);
    out.push({
      start: ep.start,
      end: ep.end,
      durationSec: (ep.end - ep.start) / 1000,
      peakBpm: peak.bpm,
      peakT: peak.t,
      meanBpm: sum / ep.samples.length,
      ...(phase !== undefined ? { phase } : {}),
      relatedEventIds,
    });
  }
  return out;
}
