/**
 * Builders for the Export page. All CSV/JSON content comes from core
 * (`samplesToCsv`, `eventsToCsv`, `rrToCsv`, `summariesToCsv`,
 * `createExportBundle`); this module only concatenates and packages it.
 */
import {
  createExportBundle,
  eventsToCsv,
  rrToCsv,
  samplesToCsv,
  sessionEnd,
} from '@surgeonpulse/core';
import type { AppInfo, ExportBundle, ParticipantProfile, SurgicalSession } from '@surgeonpulse/core';
import { concatCsv } from './download';

/** App info written into bundles exported by the dashboard. */
export const DASHBOARD_APP: AppInfo = { version: '0.1.0', platform: 'web' };

/** Long-format heart-rate samples for many sessions (one header). */
export function longSamplesCsv(sessions: readonly SurgicalSession[]): string {
  return concatCsv(sessions.map((s) => samplesToCsv(s)));
}

/** The session with every event's free-text `note` removed (notes may name patients or staff). */
function withoutEventNotes(s: SurgicalSession): SurgicalSession {
  if (!s.events.some((e) => e.note !== undefined)) return s;
  return {
    ...s,
    events: s.events.map((e) => {
      if (e.note === undefined) return e;
      const { note: _note, ...rest } = e;
      return rest as typeof e;
    }),
  };
}

/**
 * Long-format events (phases and markers) for many sessions. The `note` column is always empty:
 * free-text notes never leave the dashboard, even when a file that was not de-identified is loaded.
 * (The samples and RR CSVs carry no free text.)
 */
export function longEventsCsv(sessions: readonly SurgicalSession[]): string {
  return concatCsv(sessions.map((s) => eventsToCsv(withoutEventNotes(s))));
}

/** Long-format RR intervals for the sessions that have them. */
export function longRrCsv(sessions: readonly SurgicalSession[]): string {
  return concatCsv(sessions.filter((s) => s.rr.length > 0).map((s) => rrToCsv(s)));
}

/** Cryptographically strong uniform number in [0, 1) (falls back to Math.random). */
export function secureRandom(): number {
  try {
    const c = globalThis.crypto;
    if (c !== undefined && typeof c.getRandomValues === 'function') {
      return c.getRandomValues(new Uint32Array(1))[0]! / 4294967296;
    }
  } catch {
    // fall through
  }
  return Math.random();
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A random, non-zero shift of whole weeks in [−maxWeeks, −1] ∪ [1, maxWeeks].
 * Whole weeks keep each session's weekday and time of day (useful for
 * circadian/rota analyses) while hiding calendar dates.
 */
export function randomWeekShift(maxWeeks: number, random: () => number = secureRandom): number {
  const max = Math.max(1, Math.floor(maxWeeks));
  const magnitude = 1 + Math.min(max - 1, Math.floor(random() * max));
  return random() < 0.5 ? -magnitude : magnitude;
}

/** Options for {@link buildDeidentifiedBundle}. Notes and sensor ids are always removed. */
export interface DeidentifiedExportOptions {
  /** Shift every timestamp by a random number of weeks, the same shift within a participant. */
  shiftDates: boolean;
  /** Largest shift in weeks (default 52). */
  maxShiftWeeks?: number;
  dropTzOffset: boolean;
  dropBirthYear: boolean;
}

export interface DeidentifiedExport {
  bundle: ExportBundle;
  /** Number of participants that received a shift. The shift values themselves are never shown or saved. */
  shiftedParticipants: number;
}

/**
 * Build a de-identified export bundle with core `createExportBundle`.
 *
 * With `shiftDates`, each participant gets one random shift applied to all of
 * their sessions and their consent record, so intervals and within-participant
 * spacing are preserved but dates cannot be linked to theatre lists. Because
 * shifts differ between participants, `exportedAt` is set to the latest
 * shifted session end rather than the real export time (which would bound
 * the offsets).
 */
export function buildDeidentifiedBundle(
  sessions: readonly SurgicalSession[],
  participants: readonly ParticipantProfile[],
  opts: DeidentifiedExportOptions,
  env: { now: number; random?: () => number },
): DeidentifiedExport {
  const byCode = new Map<string, SurgicalSession[]>();
  for (const s of sessions) {
    const list = byCode.get(s.participantCode);
    if (list) list.push(s);
    else byCode.set(s.participantCode, [s]);
  }
  const profiles = new Map(participants.map((p) => [p.code, p]));
  const random = env.random ?? secureRandom;

  const outSessions: SurgicalSession[] = [];
  const outParticipants: ParticipantProfile[] = [];
  let latest = Number.NEGATIVE_INFINITY;

  for (const [code, list] of byCode) {
    const timeShiftMs = opts.shiftDates ? randomWeekShift(opts.maxShiftWeeks ?? 52, random) * WEEK_MS : 0;
    const profile = profiles.get(code);
    const part = createExportBundle({
      sessions: list,
      participants: profile ? [profile] : [],
      app: DASHBOARD_APP,
      now: env.now,
      deidentify: {
        dropNotes: true,
        dropSensorId: true,
        timeShiftMs,
        dropTzOffset: opts.dropTzOffset,
        dropBirthYear: opts.dropBirthYear,
      },
    });
    for (const s of part.sessions) {
      outSessions.push(s);
      latest = Math.max(latest, sessionEnd(s));
    }
    outParticipants.push(...part.participants);
  }

  outSessions.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const bundle: ExportBundle = {
    format: 'surgeonpulse-export',
    version: 1,
    exportedAt: opts.shiftDates && Number.isFinite(latest) ? latest : env.now,
    app: { ...DASHBOARD_APP },
    deidentified: true,
    participants: outParticipants,
    sessions: outSessions,
  };
  return { bundle, shiftedParticipants: opts.shiftDates ? byCode.size : 0 };
}
