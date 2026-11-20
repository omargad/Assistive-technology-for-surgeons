/**
 * Online backup without the `sqlite3` CLI (handy on Windows and in the
 * container): `npm run backup -- [destination.sqlite]`.
 *
 * Uses SQLite's `VACUUM INTO`, which writes a consistent, compacted snapshot
 * while the server keeps running. Reads `DATA_DIR` from the environment or
 * `.env` (ADMIN_TOKEN is not needed). The default destination is
 * `<DATA_DIR>/backups/surgeonpulse-<UTC timestamp>.sqlite`. Copy backups to
 * encrypted, access-controlled storage: they contain research data.
 */
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileTimestamp } from './context';
import { loadDotEnv } from './env';
import { installWarningFilter } from './warnings';

async function main(): Promise<number> {
  installWarningFilter();
  loadDotEnv();
  const { DatabaseSync } = await import('node:sqlite');
  const { databasePath } = await import('./db');

  const dataDir = path.resolve(process.env.DATA_DIR?.trim() || './data');
  const source = databasePath(dataDir);
  if (!existsSync(source)) {
    process.stderr.write(`No database found at ${source}. Set DATA_DIR to the server's data directory.\n`);
    return 1;
  }

  const arg = process.argv[2];
  const destination = path.resolve(
    arg !== undefined && arg.trim() !== ''
      ? arg
      : path.join(dataDir, 'backups', `surgeonpulse-${fileTimestamp(Date.now())}.sqlite`),
  );
  if (existsSync(destination)) {
    process.stderr.write(`Refusing to overwrite existing file ${destination}.\n`);
    return 1;
  }
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });

  const db = new DatabaseSync(source);
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    db.prepare('VACUUM INTO ?').run(destination);
  } finally {
    db.close();
  }
  if (process.platform !== 'win32') chmodSync(destination, 0o600);
  process.stdout.write(`Backup written to ${destination}\n`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`Backup failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
