import { statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DB_FILENAME, MIGRATIONS, databasePath, ensureDataDir, migrate, openDatabase, schemaVersion, transaction } from '../src/db';
import type { Database } from '../src/db';
import { makeTempDir, removeDir } from './helpers';

const LATEST = Math.max(...MIGRATIONS.map((m) => m.version));
const posixOnly = process.platform === 'win32' ? it.skip : it;

describe('database', () => {
  const dirs: string[] = [];
  const dbs: Database[] = [];

  async function tempDb(): Promise<{ dir: string; db: Database }> {
    const dir = await makeTempDir();
    dirs.push(dir);
    const db = openDatabase(databasePath(dir));
    dbs.push(db);
    return { dir, db };
  }

  afterEach(async () => {
    for (const db of dbs.splice(0)) {
      try {
        db.close();
      } catch {
        // already closed by the test
      }
    }
    for (const dir of dirs.splice(0)) await removeDir(dir);
  });

  it('uses WAL, enforces foreign keys and records the schema version', async () => {
    const { db } = await tempDb();
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare('PRAGMA secure_delete').get()).toEqual({ secure_delete: 1 });
    expect(schemaVersion(db)).toBe(LATEST);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(['audit', 'enrolments', 'participants', 'schema_version', 'server_secrets', 'sessions']);
  });

  it('is idempotent when reopened', async () => {
    const { dir, db } = await tempDb();
    db.close();
    const again = openDatabase(path.join(dir, DB_FILENAME));
    dbs.push(again);
    expect(schemaVersion(again)).toBe(LATEST);
    expect(again.prepare('SELECT COUNT(*) AS n FROM schema_version').get()).toEqual({ n: MIGRATIONS.length });
  });

  it('refuses a database created by a newer server', async () => {
    const { db } = await tempDb();
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(LATEST + 1, 0);
    expect(() => migrate(db)).toThrow(/newer than this server supports/);
  });

  it('rejects orphan rows (foreign keys) and cascades participant deletes', async () => {
    const { db } = await tempDb();
    expect(() =>
      db
        .prepare("INSERT INTO enrolments (id, participant_code, token_hash, created_at) VALUES ('e1', 'NOPE', 'h', 0)")
        .run(),
    ).toThrow(/FOREIGN KEY/);
    db.prepare("INSERT INTO participants (code, profile, created_at) VALUES ('SP-1', '{}', 0)").run();
    db.prepare("INSERT INTO enrolments (id, participant_code, token_hash, created_at) VALUES ('e1', 'SP-1', 'h', 0)").run();
    db.prepare("DELETE FROM participants WHERE code = 'SP-1'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM enrolments').get()).toEqual({ n: 0 });
  });

  it('rolls back a failed transaction and joins nested ones', async () => {
    const { db } = await tempDb();
    const insert = db.prepare("INSERT INTO audit (at, actor, action) VALUES (0, 'test', ?)");
    expect(() =>
      transaction(db, () => {
        insert.run('a');
        transaction(db, () => insert.run('b'));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit').get()).toEqual({ n: 0 });
    transaction(db, () => insert.run('c'));
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit').get()).toEqual({ n: 1 });
  });

  posixOnly('creates the data directory with mode 0700 and the database file with 0600', async () => {
    const parent = await makeTempDir();
    dirs.push(parent);
    const dir = path.join(parent, 'nested', 'data');
    expect(ensureDataDir(dir)).toEqual({ created: true, insecure: false });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const db = openDatabase(databasePath(dir));
    dbs.push(db);
    expect(statSync(databasePath(dir)).mode & 0o777).toBe(0o600);
    expect(ensureDataDir(dir)).toEqual({ created: false, insecure: false });
  });
});
