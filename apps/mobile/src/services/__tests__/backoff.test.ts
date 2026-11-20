/// <reference types="jest" />
import { BACKOFF_MAX_MS, backoffDelayMs } from '../sensors/backoff';
import { createSerialQueue } from '../util/serialQueue';

describe('backoffDelayMs', () => {
  it('doubles from 1 s and caps at 30 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffDelayMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
    expect(backoffDelayMs(0)).toBe(1000);
    expect(BACKOFF_MAX_MS).toBe(30000);
  });
});

describe('createSerialQueue', () => {
  it('runs tasks one at a time in order, even when one fails', async () => {
    const queue = createSerialQueue();
    const log: string[] = [];
    const slow = queue.run(async () => {
      await new Promise((r) => setTimeout(r, 20));
      log.push('a');
    });
    const failing = queue.run(async () => {
      log.push('b');
      throw new Error('boom');
    });
    const last = queue.run(async () => {
      log.push('c');
      return 42;
    });
    await expect(slow).resolves.toBeUndefined();
    await expect(failing).rejects.toThrow('boom');
    await expect(last).resolves.toBe(42);
    await queue.idle();
    expect(log).toEqual(['a', 'b', 'c']);
  });
});
