/**
 * Export and import of session data.
 *
 * - JSON bundles come from core `createExportBundle` and are de-identified by
 *   default (notes and sensor ids removed, free-text procedure names replaced
 *   with catalogue names).
 * - CSV exports use the core CSV writers. Single-session CSVs are also
 *   de-identified first, so event notes never leave the device by accident.
 * - The summaries CSV (one row per session) uses the cached summaries with the
 *   procedure name and specialty replaced by their de-identified values (a
 *   typed custom name becomes "Unspecified procedure"), and leaves out demo
 *   and simulator sessions (the CSV has no column that would mark them) and
 *   sessions whose participant code is not a study code.
 * - Every export path skips sessions whose participant code is not a
 *   pseudonymous study code instead of failing the whole export.
 * - Delivery is platform specific (`files.ts` on the web, `files.native.ts`
 *   on iOS/Android); this module only builds content and file names.
 */
import {
  createExportBundle,
  deidentifySession,
  eventsToCsv,
  isValidParticipantCode,
  rrToCsv,
  samplesToCsv,
  summariesToCsv,
} from '@surgeonpulse/core';
import type { ExportBundle, ParticipantProfile, SessionSummary, SurgicalSession } from '@surgeonpulse/core';
import { appInfo } from '../platform';
import type { SessionListItem, SessionMeta } from '../storage/types';
import { deliverTextFile, pickTextFile } from './files';
import { exportFileName } from './naming';

export type SessionCsvKind = 'samples' | 'rr' | 'events';

export interface BundleExport {
  filename: string;
  json: string;
  bundle: ExportBundle;
  /** Sessions left out because their participant code is not a pseudonymous study code. */
  skipped: number;
}

/** Build (without delivering) the export bundle and its file name. */
export function buildBundleExport(
  sessions: SurgicalSession[],
  opts: { deidentify?: boolean; profile?: ParticipantProfile | null; now?: number } = {},
): BundleExport {
  const now = opts.now ?? Date.now();
  const profile = opts.profile ?? null;
  const deidentify = opts.deidentify ?? true;
  // De-identification cannot repair a non-pseudonymous code: leave such (imported) sessions out.
  const included = deidentify ? sessions.filter((s) => isValidParticipantCode(s.participantCode)) : sessions;
  const bundle = createExportBundle({
    sessions: included,
    participants: profile && (!deidentify || isValidParticipantCode(profile.code)) ? [profile] : [],
    app: appInfo(),
    deidentify,
    now,
  });
  const code = profile?.code ?? included[0]?.participantCode ?? null;
  return {
    filename: exportFileName(code, now, 'json'),
    json: JSON.stringify(bundle),
    bundle,
    skipped: sessions.length - included.length,
  };
}

/**
 * Share/download a JSON export bundle of `sessions` (de-identified unless `deidentify: false`).
 * Resolves with how many sessions were exported and how many were skipped (non-study codes).
 */
export async function shareBundle(
  sessions: SurgicalSession[],
  opts?: { deidentify?: boolean; profile?: ParticipantProfile | null },
): Promise<{ exported: number; skipped: number }> {
  if (sessions.length === 0) throw new Error('There are no sessions to export.');
  const { filename, json, bundle, skipped } = buildBundleExport(sessions, opts);
  if (bundle.sessions.length === 0) {
    throw new Error('None of these sessions has a valid participant code, so they cannot be exported de-identified.');
  }
  await deliverTextFile(filename, json, 'application/json');
  return { exported: bundle.sessions.length, skipped };
}

/**
 * Build (without delivering) one de-identified CSV of a single session.
 * @throws Error (a plain message for the user) when the session's participant code is not a pseudonymous study code,
 *   which de-identification cannot repair (core would throw a technical RangeError).
 */
export function buildSessionCsv(session: SurgicalSession, kind: SessionCsvKind): { filename: string; csv: string } {
  if (!isValidParticipantCode(session.participantCode)) {
    throw new Error('This session has no valid participant code, so it cannot be exported de-identified.');
  }
  const clean = deidentifySession(session);
  const csv = kind === 'samples' ? samplesToCsv(clean) : kind === 'rr' ? rrToCsv(clean) : eventsToCsv(clean);
  return { filename: exportFileName(session.participantCode, session.startedAt, 'csv', kind), csv };
}

/** Share/download the samples, RR or events of one session as CSV. */
export async function shareSessionCsv(session: SurgicalSession, kind: SessionCsvKind): Promise<void> {
  const { filename, csv } = buildSessionCsv(session, kind);
  await deliverTextFile(filename, csv, 'text/csv');
}

/** Sessions left out of a summaries CSV, by reason. */
export interface SummariesCsvSkipped {
  /** Demo data (`demo` tag). */
  demo: number;
  /** Recorded with the simulator (`sensor.source: 'simulated'` or `simulated` tag). */
  simulated: number;
  /** Participant code is not a pseudonymous study code. */
  invalidCode: number;
  /** No cached summary yet (still recording, or never summarised). */
  noSummary: number;
}

export interface SummariesCsvExport {
  filename: string;
  csv: string;
  /** Rows written. */
  included: number;
  skipped: SummariesCsvSkipped;
}

/** The cached summary with every free-text field replaced by its de-identified value. */
function deidentifiedSummary(meta: SessionMeta, summary: SessionSummary): SessionSummary {
  const clean = deidentifySession({ ...meta, samples: [], rr: [] });
  const out: SessionSummary = { ...summary, procedureName: clean.procedure.name };
  if (clean.procedure.specialty !== undefined) out.specialty = clean.procedure.specialty;
  else delete out.specialty;
  return out;
}

/**
 * Build (without delivering) the summaries CSV for the History list items: one de-identified row per
 * real, summarised session. Demo and simulator sessions are left out because nothing in the CSV
 * would mark them as synthetic.
 */
export function buildSummariesCsv(items: readonly SessionListItem[], now: number = Date.now()): SummariesCsvExport {
  const skipped: SummariesCsvSkipped = { demo: 0, simulated: 0, invalidCode: 0, noSummary: 0 };
  const rows: SessionSummary[] = [];
  for (const { meta, summary } of items) {
    if (meta.tags?.includes('demo')) skipped.demo += 1;
    else if (meta.sensor?.source === 'simulated' || meta.tags?.includes('simulated')) skipped.simulated += 1;
    else if (!isValidParticipantCode(meta.participantCode)) skipped.invalidCode += 1;
    else if (summary == null) skipped.noSummary += 1;
    else rows.push(deidentifiedSummary(meta, summary));
  }
  const code = rows[0]?.participantCode ?? null;
  return { filename: exportFileName(code, now, 'csv', 'summaries'), csv: summariesToCsv(rows), included: rows.length, skipped };
}

/**
 * Share/download one wide, de-identified row per session (for SPSS / R / Stata).
 * Resolves with the number of rows and the sessions left out (see {@link buildSummariesCsv}).
 */
export async function shareSummariesCsv(items: readonly SessionListItem[]): Promise<{ included: number; skipped: SummariesCsvSkipped }> {
  const built = buildSummariesCsv(items);
  if (built.included === 0) throw new Error('There are no session summaries to export.');
  await deliverTextFile(built.filename, built.csv, 'text/csv');
  return { included: built.included, skipped: built.skipped };
}

/** Ask the user for an export file and return its text, or null when cancelled. */
export function pickImportFile(): Promise<string | null> {
  return pickTextFile('.json,application/json,text/plain');
}
