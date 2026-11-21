/**
 * expo-sqlite implementation of {@link SessionRepository} (iOS / Android).
 *
 * - One database file (`surgeonpulse.db`) in WAL mode, opened lazily.
 * - Versioned migrations recorded in `schema_version`.
 * - Signals live in their own tables and are appended in exclusive
 *   transactions using multi-row prepared INSERTs, so a crash mid-case loses
 *   at most one flush interval of data.
 * - Every write goes through a serial queue: exclusive transactions must not
 *   overlap (a concurrent write would fail with "database is locked").
 * - `getSession` reassembles and validates the session with core `parseSession`
 *   (signal rows outside the schema's limits are skipped, never fatal).
 * - `PRAGMA secure_delete` is on for every connection that writes, so deleted
 *   sessions are overwritten instead of lingering in free pages, and every
 *   delete is followed by `PRAGMA wal_checkpoint(TRUNCATE)` so the deleted
 *   data does not linger in the WAL file either.
 *
 * Never imported by the web bundle (see `index.web.ts`).
 */
import { parseSession } from '@surgeonpulse/core';
import type {
  HeartRateSample,
  ParticipantProfile,
  RRInterval,
  SessionSummary,
  SurgicalSession,
} from '@surgeonpulse/core';
import { openDatabaseAsync } from 'expo-sqlite';
import type { SQLiteBindValue, SQLiteDatabase } from 'expo-sqlite';
import { createSerialQueue } from '../util/serialQueue';
import { storableRr, storableSamples } from '../util/signals';
import { applyMetaPatch, safeJsonParse, toMeta } from './meta';
import type { SessionListItem, SessionMeta, SessionRepository } from './types';

export const DATABASE_NAME = 'surgeonpulse.db';

/** Rows per multi-row INSERT (4 params each → 800 bound params, below SQLite's historic 999 limit). */
const INSERT_CHUNK_ROWS = 200;

/**
 * Ordered migrations; index + 1 is the schema version it produces.
 * Never edit a released migration — append a new one.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    meta TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    summary TEXT NULL,
    updated_at INTEGER NOT NULL,
    sample_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions (started_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status);
  CREATE TABLE IF NOT EXISTS samples (
    session_id TEXT NOT NULL,
    t INTEGER NOT NULL,
    bpm REAL NOT NULL,
    contact INTEGER NULL
  );
  CREATE INDEX IF NOT EXISTS idx_samples_session_t ON samples (session_id, t);
  CREATE TABLE IF NOT EXISTS rr (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    t INTEGER NOT NULL,
    ms REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rr_session_seq ON rr (session_id, seq);
  CREATE TABLE IF NOT EXISTS profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    json TEXT NOT NULL
  );
  `,
];

interface SessionRow {
  id: string;
  meta: string;
  summary: string | null;
  sample_count: number;
}

interface SampleRow {
  t: number;
  bpm: number;
  contact: number | null;
}

interface RrRow {
  t: number;
  ms: number;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

async function migrate(db: SQLiteDatabase): Promise<void> {
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA secure_delete = ON;');
  await db.execAsync('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);');
  const row = await db.getFirstAsync<{ version: number }>('SELECT MAX(version) AS version FROM schema_version');
  const current = row?.version ?? 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v] as string;
    await db.withExclusiveTransactionAsync(async (txn) => {
      await txn.execAsync(sql);
      await txn.runAsync('INSERT INTO schema_version (version) VALUES (?)', v + 1);
    });
  }
}

// ---------------------------------------------------------------------------
// Batched inserts
// ---------------------------------------------------------------------------

function placeholders(rows: number, cols: number): string {
  const one = `(${Array.from({ length: cols }, () => '?').join(',')})`;
  return Array.from({ length: rows }, () => one).join(',');
}

/**
 * Insert `rows` (already flattened to `cols` values each) with a reusable
 * prepared statement for full chunks and a one-off statement for the remainder.
 */
async function insertRows(
  db: SQLiteDatabase,
  table: string,
  columns: readonly string[],
  rows: readonly SQLiteBindValue[][],
): Promise<void> {
  if (rows.length === 0) return;
  const cols = columns.length;
  const head = `INSERT INTO ${table} (${columns.join(',')}) VALUES `;
  const fullChunks = Math.floor(rows.length / INSERT_CHUNK_ROWS);
  if (fullChunks > 0) {
    const stmt = await db.prepareAsync(head + placeholders(INSERT_CHUNK_ROWS, cols));
    try {
      for (let c = 0; c < fullChunks; c++) {
        const params: SQLiteBindValue[] = [];
        for (let i = c * INSERT_CHUNK_ROWS; i < (c + 1) * INSERT_CHUNK_ROWS; i++) {
          for (const v of rows[i] as SQLiteBindValue[]) params.push(v);
        }
        await stmt.executeAsync(params);
      }
    } finally {
      await stmt.finalizeAsync();
    }
  }
  const rest = rows.length - fullChunks * INSERT_CHUNK_ROWS;
  if (rest > 0) {
    const params: SQLiteBindValue[] = [];
    for (let i = fullChunks * INSERT_CHUNK_ROWS; i < rows.length; i++) {
      for (const v of rows[i] as SQLiteBindValue[]) params.push(v);
    }
    await db.runAsync(head + placeholders(rest, cols), params);
  }
}

function sampleRows(sessionId: string, samples: readonly HeartRateSample[]): SQLiteBindValue[][] {
  return samples.map((s) => [sessionId, Math.round(s.t), s.bpm, s.contact === undefined ? null : s.contact ? 1 : 0]);
}

function rrRows(sessionId: string, rr: readonly RRInterval[], firstSeq: number): SQLiteBindValue[][] {
  return rr.map((x, i) => [sessionId, firstSeq + i, Math.round(x.t), x.ms]);
}

async function writeSignals(
  txn: SQLiteDatabase,
  id: string,
  samples: readonly HeartRateSample[],
  rr: readonly RRInterval[],
  firstSeq: number,
): Promise<void> {
  await insertRows(txn, 'samples', ['session_id', 't', 'bpm', 'contact'], sampleRows(id, samples));
  await insertRows(txn, 'rr', ['session_id', 'seq', 't', 'ms'], rrRows(id, rr, firstSeq));
}

/**
 * Copy every committed change into the database file and truncate the WAL file (`surgeonpulse.db-wal`).
 * `secure_delete` overwrites deleted rows in the database file, but the WAL keeps the original page images until a
 * checkpoint resets it, which otherwise happens only every ~1000 pages or when the last connection closes. Must run
 * outside a transaction (a checkpoint cannot run inside one). Never throws: it runs after a delete has already
 * committed, so a busy or failed checkpoint only means the WAL is reset by the next automatic checkpoint.
 */
async function purgeJournal(handle: SQLiteDatabase): Promise<void> {
  try {
    await handle.getFirstAsync('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // The delete itself succeeded; SQLite checkpoints the WAL again on its own.
  }
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface SqliteRepositoryOptions {
  databaseName?: string;
  /** Injectable clock (tests). */
  now?: () => number;
}

export function createSqliteRepository(options: SqliteRepositoryOptions = {}): SessionRepository {
  const databaseName = options.databaseName ?? DATABASE_NAME;
  const now = options.now ?? Date.now;
  const writes = createSerialQueue();
  let dbPromise: Promise<SQLiteDatabase> | null = null;

  function db(): Promise<SQLiteDatabase> {
    if (!dbPromise) {
      dbPromise = (async () => {
        const handle = await openDatabaseAsync(databaseName);
        await migrate(handle);
        return handle;
      })();
      // Allow a retry on the next call if opening failed.
      dbPromise.catch(() => {
        dbPromise = null;
      });
    }
    return dbPromise;
  }

  /**
   * Run a write in an exclusive transaction, serialised with every other write. `purge`: the write deletes health
   * data, so once it has committed the WAL is checkpointed and truncated ({@link purgeJournal}), still inside the
   * write queue so no other write's transaction is open meanwhile. A failed write throws and is not followed by one.
   */
  function write(task: (txn: SQLiteDatabase) => Promise<void>, opts: { purge?: boolean } = {}): Promise<void> {
    return writes.run(async () => {
      const handle = await db();
      await handle.withExclusiveTransactionAsync(async (txn) => {
        // expo-sqlite runs each exclusive transaction on a new connection, and secure_delete is a
        // per-connection setting: set it here so deleted health data is overwritten, not left in free pages.
        await txn.execAsync('PRAGMA secure_delete = ON;');
        await task(txn);
      });
      if (opts.purge) await purgeJournal(handle);
    });
  }

  async function readMeta(handle: SQLiteDatabase, id: string): Promise<SessionMeta | null> {
    const row = await handle.getFirstAsync<{ meta: string }>('SELECT meta FROM sessions WHERE id = ?', id);
    const meta = safeJsonParse(row?.meta);
    return typeof meta === 'object' && meta !== null ? (meta as SessionMeta) : null;
  }

  return {
    async init() {
      await db();
    },

    async listSessions(): Promise<SessionListItem[]> {
      const handle = await db();
      const rows = await handle.getAllAsync<SessionRow>(
        'SELECT id, meta, summary, sample_count FROM sessions ORDER BY started_at DESC',
      );
      const items: SessionListItem[] = [];
      for (const row of rows) {
        const meta = safeJsonParse(row.meta);
        if (typeof meta !== 'object' || meta === null) continue;
        const summary = safeJsonParse(row.summary);
        items.push({
          meta: meta as SessionMeta,
          summary: typeof summary === 'object' && summary !== null ? (summary as SessionSummary) : null,
          sampleCount: row.sample_count,
        });
      }
      return items;
    },

    async getSession(id: string): Promise<SurgicalSession | null> {
      const handle = await db();
      const meta = await readMeta(handle, id);
      if (!meta) return null;
      const sampleRowsRead = await handle.getAllAsync<SampleRow>(
        'SELECT t, bpm, contact FROM samples WHERE session_id = ? ORDER BY t, rowid',
        id,
      );
      const rrRowsRead = await handle.getAllAsync<RrRow>(
        'SELECT t, ms FROM rr WHERE session_id = ? ORDER BY seq',
        id,
      );
      const samples: HeartRateSample[] = sampleRowsRead.map((r) =>
        r.contact === null ? { t: r.t, bpm: r.bpm } : { t: r.t, bpm: r.bpm, contact: r.contact === 1 },
      );
      const rr: RRInterval[] = rrRowsRead.map((r) => ({ t: r.t, ms: r.ms }));
      // Rows the schema rejects (written by an older version that stored out-of-range sensor values)
      // are left out rather than making the whole session unreadable.
      return parseSession({ ...meta, samples: storableSamples(samples), rr: storableRr(rr) });
    },

    createSession(session: SurgicalSession): Promise<void> {
      return write(async (txn) => {
        await txn.runAsync(
          'INSERT INTO sessions (id, meta, started_at, status, summary, updated_at, sample_count) VALUES (?, ?, ?, ?, NULL, ?, ?)',
          session.id,
          JSON.stringify(toMeta(session)),
          session.startedAt,
          session.status,
          now(),
          session.samples.length,
        );
        await writeSignals(txn, session.id, session.samples, session.rr, 0);
      });
    },

    appendSignals(id, samples, rr): Promise<void> {
      if (samples.length === 0 && rr.length === 0) return Promise.resolve();
      return write(async (txn) => {
        const exists = await txn.getFirstAsync<{ id: string }>('SELECT id FROM sessions WHERE id = ?', id);
        if (!exists) throw new Error(`Session ${id} not found`);
        const seqRow = await txn.getFirstAsync<{ next: number }>(
          'SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM rr WHERE session_id = ?',
          id,
        );
        await writeSignals(txn, id, samples, rr, seqRow?.next ?? 0);
        await txn.runAsync(
          'UPDATE sessions SET sample_count = sample_count + ?, updated_at = ? WHERE id = ?',
          samples.length,
          now(),
          id,
        );
      });
    },

    updateMeta(id, patch): Promise<void> {
      return write(async (txn) => {
        const meta = await readMeta(txn, id);
        if (!meta) throw new Error(`Session ${id} not found`);
        const next = applyMetaPatch(meta, patch);
        await txn.runAsync(
          'UPDATE sessions SET meta = ?, started_at = ?, status = ?, updated_at = ? WHERE id = ?',
          JSON.stringify(next),
          next.startedAt,
          next.status,
          now(),
          id,
        );
      });
    },

    saveSession(session: SurgicalSession): Promise<void> {
      return write(async (txn) => {
        await txn.runAsync('DELETE FROM samples WHERE session_id = ?', session.id);
        await txn.runAsync('DELETE FROM rr WHERE session_id = ?', session.id);
        // Signals may have changed, so any cached summary is cleared (callers re-summarise).
        await txn.runAsync(
          `INSERT INTO sessions (id, meta, started_at, status, summary, updated_at, sample_count)
           VALUES (?, ?, ?, ?, NULL, ?, ?)
           ON CONFLICT(id) DO UPDATE SET meta = excluded.meta, started_at = excluded.started_at,
             status = excluded.status, summary = NULL, updated_at = excluded.updated_at,
             sample_count = excluded.sample_count`,
          session.id,
          JSON.stringify(toMeta(session)),
          session.startedAt,
          session.status,
          now(),
          session.samples.length,
        );
        await writeSignals(txn, session.id, session.samples, session.rr, 0);
      });
    },

    saveSummary(id: string, summary: SessionSummary): Promise<void> {
      return write(async (txn) => {
        await txn.runAsync(
          'UPDATE sessions SET summary = ?, updated_at = ? WHERE id = ?',
          JSON.stringify(summary),
          now(),
          id,
        );
      });
    },

    deleteSession(id: string): Promise<void> {
      return write(
        async (txn) => {
          await txn.runAsync('DELETE FROM samples WHERE session_id = ?', id);
          await txn.runAsync('DELETE FROM rr WHERE session_id = ?', id);
          await txn.runAsync('DELETE FROM sessions WHERE id = ?', id);
        },
        { purge: true },
      );
    },

    deleteAll(): Promise<void> {
      return write(
        async (txn) => {
          await txn.execAsync('DELETE FROM samples; DELETE FROM rr; DELETE FROM sessions;');
        },
        { purge: true },
      );
    },

    async findInterrupted(): Promise<SessionMeta[]> {
      const handle = await db();
      const rows = await handle.getAllAsync<{ meta: string }>(
        "SELECT meta FROM sessions WHERE status = 'recording' ORDER BY started_at DESC",
      );
      const out: SessionMeta[] = [];
      for (const row of rows) {
        const meta = safeJsonParse(row.meta);
        if (typeof meta === 'object' && meta !== null) out.push(meta as SessionMeta);
      }
      return out;
    },

    async getProfile(): Promise<ParticipantProfile | null> {
      const handle = await db();
      const row = await handle.getFirstAsync<{ json: string }>('SELECT json FROM profile WHERE id = 1');
      const profile = safeJsonParse(row?.json);
      return typeof profile === 'object' && profile !== null ? (profile as ParticipantProfile) : null;
    },

    saveProfile(profile: ParticipantProfile): Promise<void> {
      return write(async (txn) => {
        await txn.runAsync(
          'INSERT INTO profile (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json',
          JSON.stringify(profile),
        );
      });
    },

    deleteProfile(): Promise<void> {
      return write(
        async (txn) => {
          await txn.execAsync('DELETE FROM profile;');
        },
        { purge: true },
      );
    },
  };
}
