import { useEffect, useState } from 'react';

/** Current time (epoch ms), re-rendering every `intervalMs` while `enabled`. */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}

/** Milliseconds elapsed since `startedAt` (0 when not started), ticking every second. */
export function useElapsed(startedAt: number | null | undefined, intervalMs = 1000): number {
  const now = useNow(intervalMs, typeof startedAt === 'number');
  return typeof startedAt === 'number' ? Math.max(0, now - startedAt) : 0;
}
