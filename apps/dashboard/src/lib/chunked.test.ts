import { describe, expect, it, vi } from 'vitest';
import { runChunked, scheduleIdle } from './chunked';

/** A manual scheduler: queued callbacks run only when `flush` is called. */
function manualScheduler() {
  const queue: (() => void)[] = [];
  return {
    schedule: (cb: () => void) => {
      queue.push(cb);
      return () => {
        const i = queue.indexOf(cb);
        if (i >= 0) queue.splice(i, 1);
      };
    },
    flush: () => {
      const cb = queue.shift();
      cb?.();
      return cb !== undefined;
    },
    get pending() {
      return queue.length;
    },
  };
}

describe('runChunked', () => {
  it('processes items in time-boxed slices and never synchronously', () => {
    const sched = manualScheduler();
    let clock = 0;
    const chunks: number[][] = [];
    const onDone = vi.fn();
    runChunked({
      items: [1, 2, 3, 4, 5],
      work: (x) => {
        clock += 5; // each item "takes" 5 ms
        return x * 10;
      },
      onChunk: (r) => chunks.push(r),
      onDone,
      budgetMs: 12,
      schedule: sched.schedule,
      now: () => clock,
    });
    expect(chunks).toEqual([]);
    while (sched.flush()) {
      // drain
    }
    expect(chunks).toEqual([[10, 20, 30], [40, 50]]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('always makes progress even when one item exceeds the budget', () => {
    const sched = manualScheduler();
    let clock = 0;
    const chunks: string[][] = [];
    runChunked({
      items: ['a', 'b'],
      work: (x) => {
        clock += 100;
        return x;
      },
      onChunk: (r) => chunks.push(r),
      schedule: sched.schedule,
      now: () => clock,
    });
    while (sched.flush()) {
      // drain
    }
    expect(chunks).toEqual([['a'], ['b']]);
  });

  it('stops after cancel', () => {
    const sched = manualScheduler();
    let clock = 0;
    const onChunk = vi.fn();
    const onDone = vi.fn();
    const cancel = runChunked({
      items: [1, 2, 3],
      work: (x) => {
        clock += 20;
        return x;
      },
      onChunk,
      onDone,
      schedule: sched.schedule,
      now: () => clock,
    });
    sched.flush();
    expect(onChunk).toHaveBeenCalledTimes(1);
    cancel();
    expect(sched.pending).toBe(0);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('finishes immediately for no items', () => {
    const onDone = vi.fn();
    runChunked({ items: [], work: (x: number) => x, onChunk: vi.fn(), onDone });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('falls back to setTimeout when requestIdleCallback is missing (Safari)', async () => {
    const g = globalThis as { requestIdleCallback?: unknown };
    const saved = g.requestIdleCallback;
    delete g.requestIdleCallback;
    try {
      const ran = await new Promise<boolean>((resolve) => {
        scheduleIdle(() => resolve(true));
      });
      expect(ran).toBe(true);
    } finally {
      if (saved !== undefined) g.requestIdleCallback = saved;
    }
  });
});
