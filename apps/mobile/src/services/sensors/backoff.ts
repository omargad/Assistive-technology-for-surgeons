/**
 * Exponential reconnect back-off shared by the BLE sources:
 * 1 s, 2 s, 4 s, 8 s, 16 s, then capped at 30 s.
 */
export const BACKOFF_INITIAL_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;

/** Delay before reconnect attempt `attempt` (1-based). */
export function backoffDelayMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(BACKOFF_MAX_MS, BACKOFF_INITIAL_MS * 2 ** (n - 1));
}
