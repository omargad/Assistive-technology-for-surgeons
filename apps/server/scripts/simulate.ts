/**
 * Write a de-identified ExportBundle of simulated sessions, for trying the
 * upload endpoint without a phone:
 *
 *   npm run simulate -- <participantCode> <output.json> [sessions=3] [seed=1]
 *
 * The file is written directly (UTF-8) rather than to stdout, because
 * Windows PowerShell 5.1's `>` redirection would re-encode it as UTF-16.
 * Sessions are tagged as simulated by core's simulator (sensor source
 * `simulated`); never mix them into real study data.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createExportBundle, isValidParticipantCode, simulateSession } from '@surgeonpulse/core';

const [code, output, countArg = '3', seedArg = '1'] = process.argv.slice(2);
const count = Number(countArg);
const seed = Number(seedArg);

if (code === undefined || output === undefined || !Number.isInteger(count) || count < 1 || !Number.isInteger(seed)) {
  process.stderr.write('Usage: npm run simulate -- <participantCode> <output.json> [sessions=3] [seed=1]\n');
  process.exit(2);
}
if (!isValidParticipantCode(code)) {
  process.stderr.write(`"${code}" is not a valid participant code (2–32 letters, digits, "-" or "_").\n`);
  process.exit(2);
}

const DAY = 86_400_000;
const first = Date.UTC(2026, 0, 5, 8, 0);
const sessions = Array.from({ length: count }, (_, i) =>
  simulateSession({ participantCode: code, seed: seed + i, startedAt: first + i * 7 * DAY, durationMin: 60 }),
);
const bundle = createExportBundle({ sessions, deidentify: true, now: Date.now() });
const file = path.resolve(output);
writeFileSync(file, JSON.stringify(bundle), 'utf8');
process.stdout.write(`Wrote ${count} simulated session(s) for ${code} to ${file}\n`);
