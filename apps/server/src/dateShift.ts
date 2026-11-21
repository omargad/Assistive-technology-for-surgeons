/**
 * Consistent, secret per-participant date shifts for shareable exports
 * (`GET /export?shiftDates=true`, `GET /export/summaries.csv?shiftDates=true`).
 *
 * Each participant's timestamps move by a whole number of weeks in
 * [−52, −1] ∪ [1, 52], derived with HMAC-SHA256 from a random key kept in the
 * database (`server_secrets`), so:
 * - intervals, weekday and local time of day are unchanged (circadian and
 *   rota analyses still work) while calendar dates cannot be matched to
 *   theatre lists;
 * - a participant gets the same shift in every export (comparing several
 *   exports does not narrow the real dates down), and different participants
 *   get independent shifts;
 * - the shift and key are never returned by the API.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { SessionSummary } from '@surgeonpulse/core';
import type { Repo } from './repo';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_WEEKS = 52;
const KEY_NAME = 'export-date-shift-key';

/** Shift in ms for `code` under `key` (hex): ±1–52 whole weeks, never 0. */
export function participantShiftMs(keyHex: string, code: string): number {
  const digest = createHmac('sha256', Buffer.from(keyHex, 'hex')).update(`date-shift:${code}`, 'utf8').digest();
  const weeks = 1 + (digest.readUInt32BE(0) % MAX_WEEKS);
  const sign = (digest[4]! & 1) === 0 ? 1 : -1;
  return sign * weeks * WEEK_MS;
}

/** A function giving each participant's shift (creating the server's key on first use). */
export function dateShifter(repo: Repo, now: number): (code: string) => number {
  const key = repo.secret(KEY_NAME, () => randomBytes(32).toString('hex'), now);
  const cache = new Map<string, number>();
  return (code) => {
    let shift = cache.get(code);
    if (shift === undefined) {
      shift = participantShiftMs(key, code);
      cache.set(code, shift);
    }
    return shift;
  };
}

/** A copy of `s` with every absolute timestamp moved by `shiftMs` (durations unchanged). */
export function shiftSummary(s: SessionSummary, shiftMs: number): SessionSummary {
  return {
    ...s,
    startedAt: s.startedAt + shiftMs,
    endedAt: s.endedAt + shiftMs,
    baseline: s.baseline === null ? null : { ...s.baseline, startedAt: s.baseline.startedAt + shiftMs, endedAt: s.baseline.endedAt + shiftMs },
    phases: s.phases.map((p) => ({ ...p, start: p.start + shiftMs, end: p.end + shiftMs })),
    episodes: s.episodes.map((e) => ({ ...e, start: e.start + shiftMs, end: e.end + shiftMs, peakT: e.peakT + shiftMs })),
  };
}
