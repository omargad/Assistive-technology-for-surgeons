/**
 * Resting baseline measured before the case.
 */
import type { Baseline, EpochMs, HeartRateSample, RRInterval } from '../types';
import { hrStats, sliceByTime } from './hr';
import { computeHrv } from './rr';

/**
 * Computes a measured resting baseline from the data in `[start, end)`.
 *
 * `restingHr` is the {@link hrStats} mean of the samples in the window. `rmssd`/`sdnn` come from
 * {@link computeHrv} with `minIntervals: 20` and are omitted when it returns null (short resting recordings,
 * cf. the ESC/NASPE Task Force 1996 note that short-term HRV needs a stable recording).
 *
 * @returns `null` when the window contains no valid heart-rate sample.
 */
export function computeBaseline(
  samples: readonly HeartRateSample[],
  rr: readonly RRInterval[],
  start: EpochMs,
  end: EpochMs,
): Baseline | null {
  const hr = hrStats(sliceByTime(samples, start, end));
  if (hr === null) return null;
  const baseline: Baseline = { startedAt: start, endedAt: end, restingHr: hr.mean, source: 'measured' };
  const { hrv } = computeHrv(sliceByTime(rr, start, end), { minIntervals: 20 });
  if (hrv !== null) {
    baseline.rmssd = hrv.rmssd;
    baseline.sdnn = hrv.sdnn;
  }
  return baseline;
}
