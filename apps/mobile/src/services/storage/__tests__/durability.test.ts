/// <reference types="jest" />
/**
 * Storage durability (mobile native-API / durability review):
 * - SP-MOB-1: signal values outside the session schema's limits (stored by an older version) never
 *   make a session unreadable, on SQLite or in web storage.
 * - DOC-N2: SQLite writes run with `PRAGMA secure_delete = ON` (each exclusive transaction is a new
 *   connection in expo-sqlite, so the pragma is set per transaction).
 * - SP-MOB-4: on the web, a quota error trims signals one session at a time (oldest finished first,
 *   in-progress recording last) instead of dropping every session's signals, and the sessions stored
 *   without signals are reported so the UI can ask the user to export them.
 */
import { createSession } from '@surgeonpulse/core';
import type { SurgicalSession } from '@surgeonpulse/core';
import { createMemoryRepository } from '../memory';
import type { PersistStatus } from '../memory';
import { createSqliteRepository } from '../sqlite';
import { getStorageWarning, reportStorageWarning, subscribeStorageWarning } from '../warnings';

interface MockNodeDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...p: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...p: unknown[]): unknown;
    all(...p: unknown[]): unknown[];
  };
}

jest.mock('expo-sqlite', () => {
  const { DatabaseSync } = jest.requireActual<{ DatabaseSync: new (path: string) => MockNodeDb }>('node:sqlite');
  const flat = (params: unknown[]): unknown[] => (params.length === 1 && Array.isArray(params[0]) ? params[0] : params);
  const databases = new Map<string, MockNodeDb>();
  function wrap(db: MockNodeDb) {
    const api = {
      execAsync: async (sql: string) => db.exec(sql),
      runAsync: async (sql: string, ...params: unknown[]) => {
        const r = db.prepare(sql).run(...flat(params));
        return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
      },
      getFirstAsync: async (sql: string, ...params: unknown[]) => db.prepare(sql).get(...flat(params)) ?? null,
      getAllAsync: async (sql: string, ...params: unknown[]) => db.prepare(sql).all(...flat(params)),
      prepareAsync: async (sql: string) => {
        const stmt = db.prepare(sql);
        return { executeAsync: async (params: unknown[]) => stmt.run(...params), finalizeAsync: async () => undefined };
      },
      // Like expo-sqlite: every exclusive transaction runs on a NEW connection to the same database.
      withExclusiveTransactionAsync: async (task: (txn: unknown) => Promise<void>) => {
        const conn = new DatabaseSync(dbPaths.get(db) as string);
        const txn = wrap(conn);
        conn.exec('BEGIN EXCLUSIVE');
        try {
          await task(txn);
          conn.exec('COMMIT');
        } catch (error) {
          conn.exec('ROLLBACK');
          throw error;
        }
        lastTxn.secureDelete = (conn.prepare('PRAGMA secure_delete').get() as { secure_delete: number }).secure_delete;
      },
    };
    return api;
  }
  const dbPaths = new Map<MockNodeDb, string>();
  const lastTxn = { secureDelete: -1 };
  return {
    __lastTxn: lastTxn,
    __paths: dbPaths,
    openDatabaseAsync: jest.fn(async (name: string) => {
      let db = databases.get(name);
      if (!db) {
        const tmp = require('os').tmpdir() as string;
        const path = `${tmp}/sp-durability-${process.pid}-${Date.now()}-${name}`;
        db = new DatabaseSync(path);
        databases.set(name, db);
        dbPaths.set(db, path);
      }
      return wrap(db);
    }),
  };
});

const T0 = Date.UTC(2026, 2, 2, 8, 0, 0);

afterAll(() => {
  const fs = require('fs') as { rmSync(p: string, o: { force: boolean }): void };
  const { __paths } = jest.requireMock<{ __paths: Map<unknown, string> }>('expo-sqlite');
  for (const path of __paths.values()) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(path + suffix, { force: true });
  }
});

function session(id: string, opts: { startedAt?: number; minutes?: number; status?: SurgicalSession['status'] } = {}): SurgicalSession {
  const startedAt = opts.startedAt ?? T0;
  const n = (opts.minutes ?? 2) * 60;
  const status = opts.status ?? 'completed';
  return {
    ...createSession({
      id,
      participantCode: 'SP-014',
      procedure: { name: 'Laparoscopic cholecystectomy', catalogId: 'laparoscopic-cholecystectomy' },
      sensor: { source: 'ble' },
      app: { version: '0.1.0', platform: 'web' },
      startedAt,
    }),
    status,
    ...(status === 'completed' ? { endedAt: startedAt + n * 1000 } : {}),
    samples: Array.from({ length: n }, (_, i) => ({ t: startedAt + i * 1000, bpm: 70 + (i % 10) })),
    rr: Array.from({ length: n }, (_, i) => ({ t: startedAt + i * 1000, ms: 800 + (i % 7) })),
  };
}

function memoryStorage(limitChars = Infinity) {
  const data = new Map<string, string>();
  const store = {
    data,
    limitChars,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (v.length > store.limitChars) throw Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' });
      data.set(k, v);
    },
    removeItem: (k: string) => void data.delete(k),
  };
  return store;
}

/** Characters one session takes in the persisted (column-encoded) payload. */
async function encodedSize(s: SurgicalSession): Promise<number> {
  const storage = memoryStorage();
  const repo = createMemoryRepository({ persist: { storage, key: 'k', debounceMs: 0 } });
  await repo.saveSession(s);
  repo.flushPersistence();
  return (storage.data.get('k') as string).length;
}

describe('SQLite repository durability', () => {
  it('reads a session whose stored signals include out-of-range values (SP-MOB-1)', async () => {
    const repo = createSqliteRepository({ databaseName: 'poisoned.db' });
    const s = { ...session('p'), status: 'recording' as const, samples: [], rr: [] };
    await repo.createSession(s);
    // What an older version stored straight from a glitching strap.
    await repo.appendSignals(
      'p',
      [
        { t: T0, bpm: 72 },
        { t: T0 + 1000, bpm: 400 },
        { t: T0 + 2000, bpm: 74 },
      ],
      [
        { t: T0, ms: 800 },
        { t: T0 + 1000, ms: 6000 },
        { t: T0 + 2000, ms: 810 },
      ],
    );
    const read = await repo.getSession('p');
    expect(read?.samples.map((x) => x.bpm)).toEqual([72, 74]);
    expect(read?.rr.map((x) => x.ms)).toEqual([800, 810]);
  });

  it('runs every write transaction with secure_delete on (DOC-N2)', async () => {
    const sqlite = jest.requireMock<{ __lastTxn: { secureDelete: number } }>('expo-sqlite');
    const repo = createSqliteRepository({ databaseName: 'secure-delete.db' });
    await repo.saveSession(session('d'));
    sqlite.__lastTxn.secureDelete = -1;
    await repo.deleteSession('d');
    expect(sqlite.__lastTxn.secureDelete).toBe(1);
  });
});

describe('web (localStorage) repository durability', () => {
  it('reloads a session whose persisted signals include out-of-range values (SP-MOB-1)', async () => {
    const storage = memoryStorage();
    const repo = createMemoryRepository({ persist: { storage, key: 'k', debounceMs: 0 } });
    await repo.saveSession(session('p'));
    repo.flushPersistence();
    // Simulate an older version that stored a 400 bpm sample and a 6 s RR interval.
    const doc = JSON.parse(storage.data.get('k') as string) as {
      sessions: { samples: { bpm: number[] }; rr: { ms: number[] } }[];
    };
    doc.sessions[0]!.samples.bpm[3] = 400;
    doc.sessions[0]!.rr.ms[5] = 6000;
    storage.data.set('k', JSON.stringify(doc));

    const reloaded = createMemoryRepository({ persist: { storage, key: 'k' } });
    const read = await reloaded.getSession('p');
    expect(read).not.toBeNull();
    expect(read!.samples).toHaveLength(119);
    expect(read!.rr).toHaveLength(119);
  });

  it('a quota error trims oldest finished sessions first and keeps the live recording (SP-MOB-4)', async () => {
    const one = await encodedSize(session('x', { minutes: 60 }));
    const storage = memoryStorage(Math.round(one * 2.5)); // room for two of the three hours
    const statuses: PersistStatus[] = [];
    const onError = jest.fn();
    const repo = createMemoryRepository({
      persist: { storage, key: 'k', debounceMs: 0, onError, onPersistStatus: (s) => statuses.push(s) },
    });
    await repo.saveSession(session('old', { startedAt: T0, minutes: 60 }));
    await repo.saveSession(session('mid', { startedAt: T0 + 86_400_000, minutes: 60 }));
    await repo.saveSession(session('live', { startedAt: T0 + 2 * 86_400_000, minutes: 60, status: 'recording' }));
    repo.flushPersistence();

    const reloaded = createMemoryRepository({ persist: { storage, key: 'k' } });
    expect((await reloaded.getSession('live'))?.samples).toHaveLength(3600);
    expect((await reloaded.getSession('old'))?.samples).toHaveLength(0);
    expect((await reloaded.listSessions()).map((i) => i.meta.id).sort()).toEqual(['live', 'mid', 'old']);
    expect(onError).not.toHaveBeenCalled(); // recovered by trimming
    const last = statuses[statuses.length - 1];
    expect(last?.ok).toBe(true);
    expect(last?.droppedSignals).toContain('old');
    expect(last?.droppedSignals).not.toContain('live');
  });

  it('reports sessions left out by the size budget, and clears the report once they fit', async () => {
    const storage = memoryStorage();
    const statuses: PersistStatus[] = [];
    const one = await encodedSize(session('x', { minutes: 30 }));
    const repo = createMemoryRepository({
      persist: { storage, key: 'k', debounceMs: 0, maxBytes: Math.round(one * 1.5), onPersistStatus: (s) => statuses.push(s) },
    });
    await repo.saveSession(session('a', { startedAt: T0, minutes: 30 }));
    await repo.saveSession(session('b', { startedAt: T0 + 86_400_000, minutes: 30 }));
    repo.flushPersistence();
    expect(statuses[statuses.length - 1]).toEqual({ ok: true, droppedSignals: ['a'] });
    await repo.deleteSession('a');
    repo.flushPersistence();
    expect(statuses[statuses.length - 1]).toEqual({ ok: true, droppedSignals: [] });
  });

  it('reports a failed write when nothing can be stored', async () => {
    const storage = memoryStorage(10);
    const statuses: PersistStatus[] = [];
    const repo = createMemoryRepository({ persist: { storage, key: 'k', debounceMs: 0, onPersistStatus: (s) => statuses.push(s) } });
    await repo.saveSession(session('a'));
    repo.flushPersistence();
    expect(statuses[statuses.length - 1]?.ok).toBe(false);
  });
});

describe('storage warning channel', () => {
  it('notifies subscribers only when the warning changes', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeStorageWarning(listener);
    reportStorageWarning({ writeFailed: false, unsavedSignalSessionIds: ['a'] });
    reportStorageWarning({ writeFailed: false, unsavedSignalSessionIds: ['a'] });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getStorageWarning().unsavedSignalSessionIds).toEqual(['a']);
    reportStorageWarning({ writeFailed: false, unsavedSignalSessionIds: [] });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getStorageWarning()).toEqual({ writeFailed: false, unsavedSignalSessionIds: [] });
    unsubscribe();
  });
});
