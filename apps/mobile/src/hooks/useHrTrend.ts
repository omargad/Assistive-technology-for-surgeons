import { useMemo } from 'react';

import { mean, sliceByTime } from '@surgeonpulse/core';
import type { HeartRateSample } from '@surgeonpulse/core';

export type HrTrend = 'up' | 'down' | 'flat';

/**
 * Direction of the live heart rate for the trend arrow: mean of the last
 * `recentSec` vs the preceding `priorSec`; ±`thresholdBpm` counts as a change.
 */
export function hrTrend(
  samples: readonly HeartRateSample[],
  { recentSec = 10, priorSec = 30, thresholdBpm = 3 }: { recentSec?: number; priorSec?: number; thresholdBpm?: number } = {},
): HrTrend {
  const last = samples[samples.length - 1];
  if (!last) return 'flat';
  const end = last.t + 1;
  const recent = sliceByTime(samples, end - recentSec * 1000, end).map((s) => s.bpm);
  const prior = sliceByTime(samples, end - (recentSec + priorSec) * 1000, end - recentSec * 1000).map((s) => s.bpm);
  const a = mean(recent);
  const b = mean(prior);
  if (a == null || b == null) return 'flat';
  if (a - b >= thresholdBpm) return 'up';
  if (b - a >= thresholdBpm) return 'down';
  return 'flat';
}

export function useHrTrend(samples: readonly HeartRateSample[] | undefined): HrTrend {
  return useMemo(() => hrTrend(samples ?? []), [samples]);
}
