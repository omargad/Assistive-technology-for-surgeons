/**
 * Cooperative chunked processing for the main thread.
 *
 * Work is done in short time slices; between slices control returns to the
 * browser so input, scrolling and painting stay responsive (≈ 100 sessions
 * take about a second to summarise). Uses `requestIdleCallback` where
 * available and falls back to `setTimeout` — Safari (macOS and iPadOS) does
 * not implement `requestIdleCallback`.
 */

/** Schedule `cb` to run soon; returns a function that cancels it. */
export type Scheduler = (cb: () => void) => () => void;

/** Idle-time scheduler with a deadline so slow or background tabs still progress. */
export const scheduleIdle: Scheduler = (cb) => {
  const g = globalThis as typeof globalThis & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (typeof g.requestIdleCallback === 'function' && typeof g.cancelIdleCallback === 'function') {
    const handle = g.requestIdleCallback(cb, { timeout: 100 });
    return () => g.cancelIdleCallback?.(handle);
  }
  const handle = setTimeout(cb, 0);
  return () => clearTimeout(handle);
};

export interface ChunkedOptions<T, R> {
  items: readonly T[];
  /** Process one item. Exceptions are the caller's responsibility (wrap them into `R`). */
  work: (item: T) => R;
  /** Receives the results of each slice, in item order. */
  onChunk: (results: R[]) => void;
  /** Called once after the last slice (not after cancellation). */
  onDone?: () => void;
  /** Time budget per slice in ms (at least one item is processed per slice). Default 12. */
  budgetMs?: number;
  schedule?: Scheduler;
  now?: () => number;
}

/**
 * Process `items` in time-boxed slices. The first slice is scheduled, not run
 * synchronously, so the caller can render a progress indicator first.
 *
 * @returns a cancel function; after cancelling no further callbacks fire.
 */
export function runChunked<T, R>(opts: ChunkedOptions<T, R>): () => void {
  const { items, work, onChunk, onDone } = opts;
  const budget = Math.max(1, opts.budgetMs ?? 12);
  const schedule = opts.schedule ?? scheduleIdle;
  const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  let index = 0;
  let cancelled = false;
  let cancelPending: (() => void) | null = null;

  const slice = (): void => {
    cancelPending = null;
    if (cancelled) return;
    const started = now();
    const results: R[] = [];
    do {
      results.push(work(items[index]!));
      index++;
    } while (index < items.length && now() - started < budget && !cancelled);
    if (cancelled) return;
    onChunk(results);
    if (cancelled) return;
    if (index < items.length) cancelPending = schedule(slice);
    else onDone?.();
  };

  if (items.length === 0) {
    onDone?.();
    return () => {};
  }
  cancelPending = schedule(slice);
  return () => {
    cancelled = true;
    cancelPending?.();
    cancelPending = null;
  };
}
