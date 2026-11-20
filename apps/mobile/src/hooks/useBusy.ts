import { useCallback, useRef, useState } from 'react';

/**
 * Tracks which async action is running (one at a time) so buttons can show a
 * spinner and ignore double taps. `run` returns undefined when another action
 * is already running, and re-throws errors for the caller to present.
 */
export function useBusy(): {
  busy: string | null;
  run: <T>(key: string, fn: () => Promise<T>) => Promise<T | undefined>;
} {
  const [busy, setBusy] = useState<string | null>(null);
  const running = useRef(false);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    if (running.current) return undefined;
    running.current = true;
    setBusy(key);
    try {
      return await fn();
    } finally {
      running.current = false;
      setBusy(null);
    }
  }, []);
  return { busy, run };
}

/** Human-readable message for an unknown error (never includes tokens or health data). */
export function errorMessage(e: unknown, fallback = 'Something went wrong.'): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string' && e) return e;
  return fallback;
}
