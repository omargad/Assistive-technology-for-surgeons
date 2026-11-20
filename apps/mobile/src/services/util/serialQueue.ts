/**
 * A tiny promise queue that runs async tasks one at a time, in submission
 * order. Used to serialise storage writes (SQLite exclusive transactions must
 * not overlap) and the recording store's flushes.
 *
 * A failing task rejects its own promise only; later tasks still run.
 */
export interface SerialQueue {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Resolves once every task submitted so far has settled. */
  idle(): Promise<void>;
}

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      // `tail` never rejects (see below), so `task` always runs after its predecessor settles.
      const result = tail.then(() => task());
      // Keep the chain alive regardless of this task's outcome.
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    idle(): Promise<void> {
      return tail.then(() => undefined);
    },
  };
}
