/**
 * Optional `.env` file support that works the same on Windows, macOS and
 * Linux (no shell-specific `VAR=value` syntax needed): copy `.env.example`
 * to `.env` in the directory you start the server from. Variables already
 * set in the environment win over the file.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Load `<cwd>/.env` into `process.env` if it exists. @returns the file loaded, or null. */
export function loadDotEnv(cwd: string = process.cwd()): string | null {
  const file = path.resolve(cwd, '.env');
  if (!existsSync(file)) return null;
  process.loadEnvFile(file);
  return file;
}
