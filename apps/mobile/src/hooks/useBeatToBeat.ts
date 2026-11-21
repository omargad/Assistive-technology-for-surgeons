import type { SensorStatus } from '@/services/sensors/types';
import { useRecording } from '@/state/recording';

import { useNow } from './useNow';

/** Beat-to-beat (RR interval) data from a live sensor: arriving, or not sent at all. */
export type BeatToBeat = 'receiving' | 'missing';

/** RR counts as "receiving" when an interval arrived within this window (ms). */
export const RR_RECENT_MS = 15_000;
/** How long a sensor must have streamed heart rate before missing RR is reported (ms). */
export const RR_GRACE_MS = 10_000;

/**
 * RR status of a connected sensor, or null when there is nothing to say yet (not streaming, or streaming
 * for less than {@link RR_GRACE_MS}). HRV, stress-index and per-phase RMSSD outcomes need RR intervals.
 */
export function beatToBeatStatus(
  status: Pick<SensorStatus, 'state'>,
  streamSince: number | null,
  rrSeenAt: number | null,
  now: number,
): BeatToBeat | null {
  if (status.state !== 'streaming' && status.state !== 'connected') return null;
  if (rrSeenAt != null && now - rrSeenAt <= RR_RECENT_MS) return 'receiving';
  if (streamSince == null || now - streamSince < RR_GRACE_MS) return null;
  return 'missing';
}

/** Live RR status of the current sensor connection (re-evaluated every second). */
export function useBeatToBeat(): BeatToBeat | null {
  const sensorStatus = useRecording((s) => s.sensorStatus);
  const streamSince = useRecording((s) => s.streamSince);
  const rrSeenAt = useRecording((s) => s.rrSeenAt);
  const now = useNow(1000, sensorStatus.state === 'streaming' || sensorStatus.state === 'connected');
  return beatToBeatStatus(sensorStatus, streamSince ?? null, rrSeenAt ?? null, now);
}
