/// <reference types="jest" />
import { createSession } from '@surgeonpulse/core';
import type { SessionSummary, SurgicalSession } from '@surgeonpulse/core';
import { createMemoryRepository } from '../memory';
import type { StorageLike } from '../memory';

const T0 = Date.UTC(2026, 2, 2, 8, 0, 0);

function makeSession(id: string, startedAt = T0, status: SurgicalSession['status'] = 'recording'): SurgicalSession {
  const s = createSession({
    id,
    participantCode: 'SP-014',
    procedure: { name: 'Laparoscopic cholecystectomy', approach: 'laparoscopic' },
    sensor: { source: 'ble', name: 'Polar H10', id: 'AA:BB' },
    app: { version: '0.1.0', platform: 'ios' },
    startedAt,
  });
  return { ...s, status };
}

function samples(from: number, n: number, bpm = 70) {
  return Array.from({ length: n }, (_, i) => ({ t: from + i * 1000, bpm: bpm + (i % 3), contact: true }));
}

function rr(from: number, n: number) {
  return Array.from({ length: n }, (_, i) => ({ t: from + i * 1000, ms: 850 + (i % 5) }));
}

const fakeSummary = { sessionId: 'x', durationSec: 60 } as unknown as SessionSummary;

class MapStorage implements StorageLike {
  data = new Map<string, string>();
  quota = Infinity;
  writes = 0;
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.writes += 1;
    if (value.length > this.quota) throw new Error('QuotaExceededError');
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

describe('memory repository', () => {
  it('creates, appends signals, patches metadata and reassembles sessions', async () => {
    const repo = createMemoryRepository();
    await repo.init();
    await repo.createSession(makeSession('a'));
    await repo.appendSignals('a', samples(T0, 5), rr(T0, 5));
    await repo.appendSignals('a', samples(T0 + 5000, 3), []);
    await repo.updateMeta('a', { endedAt: T0 + 60_000, tags: ['x'] });

    const s = await repo.getSession('a');
    expect(s?.samples).toHaveLength(8);
    expect(s?.rr).toHaveLength(5);
    expect(s?.endedAt).toBe(T0 + 60_000);
    expect(s?.tags).toEqual(['x']);

    // `undefined` in a patch removes the key.
    await repo.updateMeta('a', { endedAt: undefined });
    expect((await repo.getSession('a'))?.endedAt).toBeUndefined();

    // Returned objects are copies.
    s!.samples.push({ t: 0, bpm: 1 });
    expect((await repo.getSession('a'))?.samples).toHaveLength(8);
  });

  it('lists newest first with sample counts and cached summaries', async () => {
    const repo = createMemoryRepository();
    await repo.createSession(makeSession('old', T0 - 86_400_000, 'completed'));
    await repo.createSession(makeSession('new', T0, 'completed'));
    await repo.appendSignals('new', samples(T0, 4), []);
    await repo.saveSummary('new', fakeSummary);

    const items = await repo.listSessions();
    expect(items.map((i) => i.meta.id)).toEqual(['new', 'old']);
    expect(items[0]?.sampleCount).toBe(4);
    expect(items[0]?.summary).toEqual(fakeSummary);
    expect(items[1]?.summary).toBeNull();
    expect(items[0]?.meta).not.toHaveProperty('samples');
  });

  it('saveSession replaces signals and clears the stale summary', async () => {
    const repo = createMemoryRepository();
    await repo.createSession(makeSession('a'));
    await repo.appendSignals('a', samples(T0, 10), []);
    await repo.saveSummary('a', fakeSummary);
    await repo.saveSession({ ...makeSession('a', T0, 'completed'), samples: samples(T0, 2) });
    const [item] = await repo.listSessions();
    expect(item?.sampleCount).toBe(2);
    expect(item?.summary).toBeNull();
    expect(item?.meta.status).toBe('completed');
  });

  it('finds interrupted sessions and deletes sessions with their signals', async () => {
    const repo = createMemoryRepository();
    await repo.createSession(makeSession('rec'));
    await repo.createSession(makeSession('done', T0 + 1, 'completed'));
    expect((await repo.findInterrupted()).map((m) => m.id)).toEqual(['rec']);
    await repo.deleteSession('rec');
    expect(await repo.getSession('rec')).toBeNull();
    await repo.deleteAll();
    expect(await repo.listSessions()).toEqual([]);
  });

  it('rejects duplicates and unknown ids', async () => {
    const repo = createMemoryRepository();
    await repo.createSession(makeSession('a'));
    await expect(repo.createSession(makeSession('a'))).rejects.toThrow(/already exists/);
    await expect(repo.appendSignals('nope', samples(T0, 1), [])).rejects.toThrow(/not found/);
    await expect(repo.updateMeta('nope', {})).rejects.toThrow(/not found/);
  });

  it('keeps signals sorted when an append arrives out of order', async () => {
    const repo = createMemoryRepository();
    await repo.createSession(makeSession('a'));
    await repo.appendSignals('a', samples(T0 + 5000, 2), []);
    await repo.appendSignals('a', samples(T0, 2), []);
    const s = await repo.getSession('a');
    expect(s?.samples.map((x) => x.t)).toEqual([T0, T0 + 1000, T0 + 5000, T0 + 6000]);
  });

  it('stores and returns the participant profile', async () => {
    const repo = createMemoryRepository();
    expect(await repo.getProfile()).toBeNull();
    await repo.saveProfile({ code: 'SP-014', trainingLevel: 'registrar' });
    expect(await repo.getProfile()).toEqual({ code: 'SP-014', trainingLevel: 'registrar' });
  });

  describe('localStorage persistence', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('debounces writes and round-trips sessions, summaries and the profile', async () => {
      const storage = new MapStorage();
      const repo = createMemoryRepository({ persist: { storage, debounceMs: 500 } });
      await repo.createSession(makeSession('a', T0, 'completed'));
      await repo.appendSignals('a', samples(T0, 30), rr(T0, 30));
      await repo.saveSummary('a', fakeSummary);
      await repo.saveProfile({ code: 'SP-014' });
      expect(storage.writes).toBe(0);
      jest.advanceTimersByTime(500);
      expect(storage.writes).toBe(1);

      const reloaded = createMemoryRepository({ persist: { storage } });
      await reloaded.init();
      const s = await reloaded.getSession('a');
      expect(s?.samples).toEqual(samples(T0, 30));
      expect(s?.rr).toEqual(rr(T0, 30));
      expect((await reloaded.listSessions())[0]?.summary).toEqual(fakeSummary);
      expect(await reloaded.getProfile()).toEqual({ code: 'SP-014' });
    });

    it('flushPersistence writes immediately', async () => {
      const storage = new MapStorage();
      const repo = createMemoryRepository({ persist: { storage, debounceMs: 10_000 } });
      await repo.createSession(makeSession('a'));
      repo.flushPersistence();
      expect(storage.writes).toBe(1);
    });

    it('drops signals of the oldest finished sessions when over the size budget, keeping metadata', async () => {
      const storage = new MapStorage();
      const repo = createMemoryRepository({ persist: { storage, maxBytes: 20_000 } });
      await repo.createSession(makeSession('old', T0 - 7 * 86_400_000, 'completed'));
      await repo.appendSignals('old', samples(T0 - 7 * 86_400_000, 2000), []);
      await repo.createSession(makeSession('live', T0));
      await repo.appendSignals('live', samples(T0, 200), []);
      repo.flushPersistence();

      const reloaded = createMemoryRepository({ persist: { storage } });
      const items = await reloaded.listSessions();
      expect(items.map((i) => i.meta.id).sort()).toEqual(['live', 'old']);
      expect((await reloaded.getSession('old'))?.samples).toEqual([]);
      expect((await reloaded.getSession('live'))?.samples).toHaveLength(200);
    });

    it('falls back to metadata only when storage throws a quota error', async () => {
      const storage = new MapStorage();
      storage.quota = 3_000;
      const onError = jest.fn();
      const repo = createMemoryRepository({ persist: { storage, onError } });
      await repo.createSession(makeSession('a'));
      await repo.appendSignals('a', samples(T0, 500), []);
      repo.flushPersistence();
      expect(onError).not.toHaveBeenCalled();
      const reloaded = createMemoryRepository({ persist: { storage } });
      expect((await reloaded.listSessions()).map((i) => i.meta.id)).toEqual(['a']);
    });

    it('ignores corrupt storage', async () => {
      const storage = new MapStorage();
      storage.data.set('surgeonpulse.sessions.v1', '{not json');
      const repo = createMemoryRepository({ persist: { storage } });
      await expect(repo.listSessions()).resolves.toEqual([]);
    });
  });
});
