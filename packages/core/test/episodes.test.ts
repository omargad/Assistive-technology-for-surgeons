import { describe, expect, it } from 'vitest';
import { defaultEpisodeThreshold, detectStressEpisodes } from '../src/analytics/episodes';
import type { Baseline, HeartRateSample, HrStats, PhaseSegment, SessionEvent } from '../src/types';

/** Samples from [seconds, bpm] pairs. */
const hr = (pairs: [number, number][]): HeartRateSample[] => pairs.map(([s, bpm]) => ({ t: s * 1000, bpm }));

describe('defaultEpisodeThreshold', () => {
  const baseline: Baseline = { startedAt: 0, endedAt: 0, restingHr: 65, source: 'manual' };
  const stats: HrStats = { count: 3, mean: 72, median: 70, min: 60, max: 90, sd: 5, p95: 88 };
  it('is restingHr + 20 with a baseline', () => {
    expect(defaultEpisodeThreshold(baseline, stats)).toBe(85);
    expect(defaultEpisodeThreshold(baseline, null)).toBe(85);
  });
  it('is median HR + 15 without a baseline', () => {
    expect(defaultEpisodeThreshold(null, stats)).toBe(85);
    expect(defaultEpisodeThreshold(undefined, stats)).toBe(85);
  });
  it('is null without HR or baseline', () => {
    expect(defaultEpisodeThreshold(null, null)).toBeNull();
  });
});

describe('detectStressEpisodes', () => {
  // 5-second sampling (a 5000 ms spacing is not a gap). Threshold 100.
  //   run A: 10–35 s (105, 110, 120, 110, 120, 105)
  //   run B: 55–70 s (108, 112, 108, 104)      → 20 s after A ends ≤ 30 s → merged with A: 10–70 s (60 s)
  //   run C: 150–155 s (130, 130)              → 80 s after B → separate, 5 s < 60 s → dropped
  const samples = hr([
    [0, 90],
    [5, 90],
    [10, 105],
    [15, 110],
    [20, 120],
    [25, 110],
    [30, 120],
    [35, 105],
    [40, 95],
    [45, 95],
    [50, 95],
    [55, 108],
    [60, 112],
    [65, 108],
    [70, 104],
    [75, 90],
    [150, 130],
    [155, 130],
  ]);

  it('finds runs, merges close ones and keeps episodes ≥ minDuration', () => {
    const eps = detectStressEpisodes(samples, { thresholdBpm: 100 });
    // above-threshold samples: 105+110+120+110+120+105+108+112+108+104 = 1102 → mean 110.2
    // peak 120 occurs at 20 s and 30 s → first occurrence (20 s) wins
    expect(eps).toEqual([
      {
        start: 10000,
        end: 70000,
        durationSec: 60,
        peakBpm: 120,
        peakT: 20000,
        meanBpm: 110.2,
        relatedEventIds: [],
      },
    ]);
    expect('phase' in eps[0]!).toBe(false);
  });

  it('applies minDurationMs and mergeGapMs', () => {
    expect(detectStressEpisodes(samples, { thresholdBpm: 100, minDurationMs: 60001 })).toEqual([]);
    // no merging: A (25 s) and B (15 s) are both too short
    expect(detectStressEpisodes(samples, { thresholdBpm: 100, mergeGapMs: 10000 })).toEqual([]);
    const all = detectStressEpisodes(samples, { thresholdBpm: 100, mergeGapMs: 10000, minDurationMs: 0 });
    expect(all.map((e) => [e.start, e.end])).toEqual([
      [10000, 35000],
      [55000, 70000],
      [150000, 155000],
    ]);
    expect(all[1]!.meanBpm).toBe(108); // (108 + 112 + 108 + 104) / 4
    expect(all[1]!.peakT).toBe(60000);
  });

  it('labels the phase at the peak and lists related events in time order', () => {
    const segments: PhaseSegment[] = [
      { phase: 'dissection', index: 0, start: 0, end: 15000 },
      { phase: 'critical', index: 1, start: 15000, end: 100000 },
    ];
    // episode 10000–70000 → related window [10000 − 120000, 70000] = [−110000, 70000]
    const events: SessionEvent[] = [
      { id: 'e3', t: 70000, type: 'marker', marker: 'complication' }, // = end → included
      { id: 'e4', t: 70001, type: 'marker', marker: 'interruption' }, // after end → excluded
      { id: 'e1', t: -200000, type: 'marker', marker: 'note' }, // too early → excluded
      { id: 'e2', t: 5000, type: 'phase', phase: 'dissection' }, // before start, within 2 min → included
      { id: 'e0', t: -110000, type: 'marker', marker: 'equipment' }, // exactly start − 2 min → included
    ];
    const [ep] = detectStressEpisodes(samples, { thresholdBpm: 100 }, { segments, events });
    expect(ep!.phase).toBe('critical');
    expect(ep!.relatedEventIds).toEqual(['e0', 'e2', 'e3']);
  });

  it('breaks runs on data gaps > 5000 ms between valid samples', () => {
    const gapped = hr([
      [200, 110],
      [210, 110],
    ]);
    expect(
      detectStressEpisodes(gapped, { thresholdBpm: 100, mergeGapMs: 0, minDurationMs: 0 }).map((e) => [
        e.start,
        e.end,
      ]),
    ).toEqual([
      [200000, 200000],
      [210000, 210000],
    ]);
    // …but the two runs are still merged when they are within mergeGapMs
    expect(
      detectStressEpisodes(gapped, { thresholdBpm: 100, minDurationMs: 0 }).map((e) => [e.start, e.end]),
    ).toEqual([[200000, 210000]]);
    // an invalid (0 bpm) sample is skipped: the gap is measured between valid samples (0 → 6 s)
    const withDropout = hr([
      [0, 110],
      [3, 0],
      [6, 110],
    ]);
    expect(detectStressEpisodes(withDropout, { thresholdBpm: 100, mergeGapMs: 0, minDurationMs: 0 })).toHaveLength(2);
  });

  it('does not break a run on an invalid sample or on a spacing of exactly 5000 ms', () => {
    const eps = detectStressEpisodes(
      hr([
        [300, 110],
        [302, 0],
        [304, 110],
        [309, 112],
      ]),
      { thresholdBpm: 100, mergeGapMs: 0, minDurationMs: 0 },
    );
    expect(eps).toHaveLength(1);
    expect(eps[0]!.start).toBe(300000);
    expect(eps[0]!.end).toBe(309000);
    expect(eps[0]!.peakBpm).toBe(112);
    expect(eps[0]!.meanBpm).toBeCloseTo(332 / 3, 12);
  });

  it('a sample below the threshold ends a run (bpm ≥ threshold counts as elevated)', () => {
    const eps = detectStressEpisodes(
      hr([
        [0, 100],
        [1, 99],
        [2, 100],
      ]),
      { thresholdBpm: 100, mergeGapMs: 0, minDurationMs: 0 },
    );
    expect(eps.map((e) => e.start)).toEqual([0, 2000]);
  });

  it('returns [] when nothing reaches the threshold or without samples', () => {
    expect(detectStressEpisodes(samples, { thresholdBpm: 200 })).toEqual([]);
    expect(detectStressEpisodes([], { thresholdBpm: 100 })).toEqual([]);
    expect(detectStressEpisodes(samples, { thresholdBpm: Number.NaN })).toEqual([]);
  });
});
