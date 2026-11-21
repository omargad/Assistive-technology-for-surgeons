/// <reference types="jest" />
/**
 * Runs the native SQLite repository against a real SQLite engine (Node's
 * built-in `node:sqlite`) through a minimal stand-in for the expo-sqlite
 * async API, so migrations, upserts, batching and ordering are exercised for
 * real without a device.
 */
import { createSession } from '@surgeonpulse/core';
import type { SessionSummary, SurgicalSession } from '@surgeonpulse/core';
import { createSqliteRepository } from '../sqlite';

interface MockStmt {
  run(...p: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...p: unknown[]): unknown;
  all(...p: unknown[]): unknown[];
}
interface MockNodeDb {
  exec(sql: string): void;
  prepare(sql: string): MockStmt;
}
interface MockLog {
  exclusive: number;
  prepared: number;
  statements: { sql: string; inTxn: boolean }[];
  failOn: RegExp | null;
}

jest.mock('expo-sqlite', () => {
  const { DatabaseSync } = jest.requireActual<{ DatabaseSync: new (path: string) => MockNodeDb }>('node:sqlite');
  const flat = (params: unknown[]): unknown[] => (params.length === 1 && Array.isArray(params[0]) ? params[0] : params);
  const databases = new Map<string, MockNodeDb>();

  function wrap(db: MockNodeDb, log: MockLog) {
    let inTxn = false;
    /** Record a statement (and whether it ran inside the exclusive transaction); throw when `log.failOn` matches. */
    const record = (sql: string) => {
      log.statements.push({ sql, inTxn });
      if (log.failOn?.test(sql)) throw new Error(`mock failure: ${sql}`);
    };
    const api = {
      log,
      execAsync: async (sql: string) => {
        record(sql);
        db.exec(sql);
      },
      runAsync: async (sql: string, ...params: unknown[]) => {
        record(sql);
        const r = db.prepare(sql).run(...flat(params));
        return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
      },
      getFirstAsync: async (sql: string, ...params: unknown[]) => {
        record(sql);
        return db.prepare(sql).get(...flat(params)) ?? null;
      },
      getAllAsync: async (sql: string, ...params: unknown[]) => db.prepare(sql).all(...flat(params)),
      prepareAsync: async (sql: string) => {
        log.prepared += 1;
        const stmt = db.prepare(sql);
        return {
          executeAsync: async (params: unknown[]) => {
            stmt.run(...params);
            return {};
          },
          finalizeAsync: async () => undefined,
        };
      },
      withExclusiveTransactionAsync: async (task: (txn: unknown) => Promise<void>) => {
        if (inTxn) throw new Error('database is locked (overlapping transactions)');
        inTxn = true;
        log.exclusive += 1;
        db.exec('BEGIN EXCLUSIVE');
        try {
          await task(api);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        } finally {
          inTxn = false;
        }
      },
    };
    return api;
  }

  const log: MockLog = { exclusive: 0, prepared: 0, statements: [], failOn: null };
  return {
    __log: log,
    openDatabaseAsync: jest.fn(async (name: string) => {
      let db = databases.get(name);
      if (!db) {
        db = new DatabaseSync(':memory:');
        databases.set(name, db);
      }
      return wrap(db, log);
    }),
  };
});

const T0 = Date.UTC(2026, 2, 2, 8, 0, 0);
let dbCounter = 0;

function freshRepo() {
  dbCounter += 1;
  return createSqliteRepository({ databaseName: `test-${dbCounter}.db`, now: () => T0 });
}

function makeSession(id: string, startedAt = T0, status: SurgicalSession['status'] = 'recording'): SurgicalSession {
  return {
    ...createSession({
      id,
      participantCode: 'SP-014',
      procedure: { name: 'Laparoscopic cholecystectomy', catalogId: 'laparoscopic-cholecystectomy' },
      sensor: { source: 'ble', name: 'Polar H10' },
      app: { version: '0.1.0', platform: 'android' },
      startedAt,
    }),
    status,
  };
}

const samples = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ t: from + i * 1000, bpm: 60 + (i % 40), ...(i % 2 ? { contact: true } : {}) }));
const rr = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ t: from + Math.floor(i / 2) * 1000, ms: 800 + i }));

describe('SQLite repository', () => {
  it('migrates once and round-trips a session with batched signal inserts', async () => {
    const repo = freshRepo();
    await repo.init();
    await repo.init();
    await repo.createSession(makeSession('a'));
    // 450 samples → two full 200-row chunks with one prepared statement + a 50-row remainder.
    await repo.appendSignals('a', samples(T0, 450), rr(T0, 7));
    await repo.appendSignals('a', samples(T0 + 450_000, 3), rr(T0 + 450_000, 3));

    const s = await repo.getSession('a');
    expect(s?.samples).toEqual([...samples(T0, 450), ...samples(T0 + 450_000, 3)]);
    // RR keeps beat order (sequence numbers continue across appends), including equal timestamps.
    expect(s?.rr).toEqual([...rr(T0, 7), ...rr(T0 + 450_000, 3)]);
    expect((await repo.listSessions())[0]?.sampleCount).toBe(453);
  });

  it('patches metadata (including removing keys) and caches summaries', async () => {
    const repo = freshRepo();
    await repo.createSession(makeSession('a'));
    await repo.updateMeta('a', { status: 'completed', endedAt: T0 + 60_000, tags: ['uploaded:x'] });
    await repo.saveSummary('a', { sessionId: 'a', durationSec: 60 } as unknown as SessionSummary);
    let [item] = await repo.listSessions();
    expect(item?.meta).toMatchObject({ id: 'a', status: 'completed', endedAt: T0 + 60_000, tags: ['uploaded:x'] });
    expect(item?.summary).toEqual({ sessionId: 'a', durationSec: 60 });
    expect(await repo.findInterrupted()).toEqual([]);

    await repo.updateMeta('a', { endedAt: undefined, status: 'recording' });
    [item] = await repo.listSessions();
    expect(item?.meta.endedAt).toBeUndefined();
    expect((await repo.findInterrupted()).map((m) => m.id)).toEqual(['a']);
  });

  it('saveSession upserts, replaces signals and clears the stale summary', async () => {
    const repo = freshRepo();
    await repo.createSession(makeSession('a'));
    await repo.appendSignals('a', samples(T0, 10), rr(T0, 4));
    await repo.saveSummary('a', { sessionId: 'a' } as unknown as SessionSummary);
    await repo.saveSession({ ...makeSession('a', T0, 'completed'), endedAt: T0 + 5000, samples: samples(T0, 2), rr: [] });
    const [item] = await repo.listSessions();
    expect(item?.sampleCount).toBe(2);
    expect(item?.summary).toBeNull();
    const s = await repo.getSession('a');
    expect(s?.rr).toEqual([]);
    expect(s?.status).toBe('completed');
  });

  it('lists newest first, deletes with signals, and keeps the profile', async () => {
    const repo = freshRepo();
    await repo.saveSession({ ...makeSession('old', T0 - 86_400_000, 'completed'), samples: samples(T0, 5) });
    await repo.saveSession({ ...makeSession('new', T0, 'completed'), samples: samples(T0, 5) });
    await repo.saveProfile({ code: 'SP-014', trainingLevel: 'consultant' });
    await repo.saveProfile({ code: 'SP-014', trainingLevel: 'fellow' });
    expect((await repo.listSessions()).map((i) => i.meta.id)).toEqual(['new', 'old']);
    await repo.deleteSession('old');
    expect(await repo.getSession('old')).toBeNull();
    await repo.deleteAll();
    expect(await repo.listSessions()).toEqual([]);
    expect(await repo.getProfile()).toEqual({ code: 'SP-014', trainingLevel: 'fellow' });
    // "Delete all data" also removes the profile (DOC-S1).
    await repo.deleteProfile();
    expect(await repo.getProfile()).toBeNull();
  });

  it('checkpoints and truncates the WAL after each delete, outside the write transaction (M3)', async () => {
    const { __log: log } = jest.requireMock<{ __log: MockLog }>('expo-sqlite');
    const repo = freshRepo();
    await repo.saveSession({ ...makeSession('a', T0, 'completed'), samples: samples(T0, 5) });
    await repo.saveProfile({ code: 'SP-014' });
    const CHECKPOINT = 'PRAGMA wal_checkpoint(TRUNCATE)';
    const after = async (fn: () => Promise<void>) => {
      log.statements = [];
      await fn();
      return log.statements;
    };

    // Other writes do not checkpoint.
    const summaryWrite = await after(() => repo.saveSummary('a', { sessionId: 'a' } as unknown as SessionSummary));
    expect(summaryWrite.map((x) => x.sql)).not.toContain(CHECKPOINT);

    for (const remove of [() => repo.deleteSession('a'), () => repo.deleteAll(), () => repo.deleteProfile()]) {
      const statements = await after(remove);
      const checkpoints = statements.filter((x) => x.sql === CHECKPOINT);
      expect(checkpoints).toEqual([{ sql: CHECKPOINT, inTxn: false }]);
      // ... and only after the delete: it is the last statement, following the DELETE statements.
      expect(statements.at(-1)?.sql).toBe(CHECKPOINT);
      expect(statements.findIndex((x) => x.sql.startsWith('DELETE'))).toBeLessThan(statements.length - 1);
    }
  });

  it('a failed checkpoint does not fail the delete; a failed delete still throws (M3)', async () => {
    const { __log: log } = jest.requireMock<{ __log: MockLog }>('expo-sqlite');
    const repo = freshRepo();
    await repo.saveSession({ ...makeSession('a', T0, 'completed'), samples: samples(T0, 5) });
    await repo.saveSession({ ...makeSession('b', T0, 'completed'), samples: samples(T0, 5) });
    try {
      log.failOn = /wal_checkpoint/;
      await expect(repo.deleteSession('a')).resolves.toBeUndefined();
      expect(await repo.getSession('a')).toBeNull();

      log.failOn = /^DELETE FROM sessions/;
      log.statements = [];
      await expect(repo.deleteSession('b')).rejects.toThrow(/mock failure/);
      expect(log.statements.map((x) => x.sql)).not.toContain('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      log.failOn = null;
    }
    expect((await repo.getSession('b'))?.samples).toHaveLength(5); // rolled back
  });

  it('serialises concurrent writes (exclusive transactions never overlap)', async () => {
    const repo = freshRepo();
    await repo.createSession(makeSession('a'));
    await Promise.all([
      repo.appendSignals('a', samples(T0, 300), []),
      repo.updateMeta('a', { tags: ['x'] }),
      repo.appendSignals('a', samples(T0 + 300_000, 300), []),
      repo.saveSummary('a', { sessionId: 'a' } as unknown as SessionSummary),
    ]);
    expect((await repo.getSession('a'))?.samples).toHaveLength(600);
  });

  it('rolls back a failed write and reports unknown sessions', async () => {
    const repo = freshRepo();
    await expect(repo.appendSignals('missing', samples(T0, 3), [])).rejects.toThrow(/not found/);
    await expect(repo.updateMeta('missing', {})).rejects.toThrow(/not found/);
    expect(await repo.getSession('missing')).toBeNull();
    await repo.createSession(makeSession('a'));
    await expect(repo.createSession(makeSession('a'))).rejects.toThrow();
    expect((await repo.listSessions())).toHaveLength(1);
  });
});
