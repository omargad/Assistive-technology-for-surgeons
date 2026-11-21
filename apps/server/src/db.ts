/**
 * SQLite storage via the built-in `node:sqlite` (`DatabaseSync`): no native
 * add-ons to compile, so the server installs the same way on Linux, macOS
 * and Windows.
 *
 * - The data directory is created with mode 0700 and the database file with
 *   0600 (POSIX; on Windows the folder's NTFS permissions apply instead).
 * - WAL journal, `foreign_keys=ON`, `secure_delete=ON` (deleted research
 *   data is zeroed, not left in free pages), a busy timeout, and versioned
 *   migrations recorded in a `schema_version` table.
 */
import { closeSync, mkdirSync, openSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Database = DatabaseSync;

/** File name of the database inside `DATA_DIR`. */
export const DB_FILENAME = 'surgeonpulse.sqlite';

export interface DataDirStatus {
  /** True when the directory did not exist and was created (mode 0700). */
  created: boolean;
  /** True on POSIX when an existing directory is readable/writable by group or others. */
  insecure: boolean;
}

/**
 * Create the data directory (recursively, mode 0700) if it is missing.
 * Existing directories are left as they are, but reported when other users
 * can read them so the operator can tighten them.
 */
export function ensureDataDir(dir: string): DataDirStatus {
  const created = mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined;
  let insecure = false;
  if (process.platform !== 'win32') {
    insecure = (statSync(dir).mode & 0o077) !== 0;
  }
  return { created, insecure };
}

/** Path of the database file inside a data directory. */
export function databasePath(dataDir: string): string {
  return path.join(dataDir, DB_FILENAME);
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/** Connections with a transaction opened by {@link transaction} (tracked here: `db.isTransaction` needs Node ≥ 22.16). */
const openTransactions = new WeakSet<Database>();

/**
 * Run `fn` inside `BEGIN IMMEDIATE … COMMIT` (rolled back if it throws).
 * Calls made while a transaction is already open join it, so repository
 * methods can be composed into one atomic unit. `fn` must be synchronous.
 */
export function transaction<T>(db: Database, fn: () => T): T {
  if (openTransactions.has(db)) return fn();
  db.exec('BEGIN IMMEDIATE');
  openTransactions.add(db);
  try {
    const result = fn();
    if (result instanceof Promise) throw new TypeError('transaction() callbacks must be synchronous');
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Already rolled back by SQLite (e.g. after a failed COMMIT); keep the original error.
    }
    throw err;
  } finally {
    openTransactions.delete(db);
  }
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

export interface Migration {
  version: number;
  description: string;
  sql: string;
}

/** Ordered schema migrations. Never edit an applied migration; append a new one. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'participants, enrolments, sessions and audit log',
    sql: `
      CREATE TABLE participants (
        code         TEXT PRIMARY KEY,
        profile      TEXT NOT NULL CHECK (json_valid(profile)),
        created_at   INTEGER NOT NULL,
        withdrawn_at INTEGER
      );

      CREATE TABLE enrolments (
        id               TEXT PRIMARY KEY,
        participant_code TEXT NOT NULL REFERENCES participants(code) ON DELETE CASCADE,
        token_hash       TEXT NOT NULL UNIQUE,
        label            TEXT,
        created_at       INTEGER NOT NULL,
        last_used_at     INTEGER,
        revoked_at       INTEGER
      );
      CREATE INDEX enrolments_participant ON enrolments(participant_code);

      CREATE TABLE sessions (
        id               TEXT PRIMARY KEY,
        participant_code TEXT NOT NULL REFERENCES participants(code) ON DELETE CASCADE,
        started_at       INTEGER NOT NULL,
        ended_at         INTEGER,
        procedure_name   TEXT NOT NULL,
        specialty        TEXT,
        body             TEXT NOT NULL,
        sha256           TEXT NOT NULL,
        summary          TEXT NOT NULL,
        received_at      INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      );
      CREATE INDEX sessions_participant_started ON sessions(participant_code, started_at);
      CREATE INDEX sessions_started ON sessions(started_at);

      CREATE TABLE audit (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        at     INTEGER NOT NULL,
        actor  TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        detail TEXT
      );
    `,
  },
  {
    version: 2,
    description: 'server secrets (key for consistent per-participant export date shifts)',
    sql: `
      CREATE TABLE server_secrets (
        name       TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `,
  },
];

/** The highest applied migration version (0 for an empty database). */
export function schemaVersion(db: Database): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, applied_at INTEGER NOT NULL)');
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_version').get() as
    | { version: number }
    | undefined;
  return row?.version ?? 0;
}

/**
 * Apply pending migrations, each in its own transaction.
 *
 * @returns the schema version after migrating.
 * @throws Error if the database was created by a newer server version.
 */
export function migrate(db: Database, migrations: readonly Migration[] = MIGRATIONS, now: () => number = Date.now): number {
  let current = schemaVersion(db);
  const latest = migrations.reduce((max, m) => Math.max(max, m.version), 0);
  if (current > latest) {
    throw new Error(
      `The database schema (version ${current}) is newer than this server supports (version ${latest}). Upgrade the server.`,
    );
  }
  const insert = db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)');
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version <= current) continue;
    transaction(db, () => {
      db.exec(m.sql);
      insert.run(m.version, now());
    });
    current = m.version;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/**
 * Open (creating if needed) the database at `file`, configure it and run
 * migrations. Pass `':memory:'` for a throwaway database.
 */
export function openDatabase(file: string): Database {
  const inMemory = file === ':memory:';
  if (!inMemory) {
    // Create the file up front so it gets owner-only permissions (0600) on POSIX.
    closeSync(openSync(file, 'a', 0o600));
  }
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true });
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    // Overwrite deleted content with zeros, so a withdrawn participant's data cannot be recovered
    // from free pages of the database file (or from copies of it).
    db.exec('PRAGMA secure_delete = ON');
    if (!inMemory) {
      const row = db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode?: string } | undefined;
      if (row?.journal_mode?.toLowerCase() !== 'wal') {
        throw new Error(`Could not enable WAL journal mode (got ${String(row?.journal_mode)})`);
      }
      // Safe with WAL: a crash can lose the last transactions but never corrupts the database.
      db.exec('PRAGMA synchronous = NORMAL');
    }
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
