/**
 * Export and import of session data.
 *
 * - JSON bundles come from core `createExportBundle` and are de-identified by
 *   default (notes and sensor ids removed, free-text procedure names replaced
 *   with catalogue names).
 * - CSV exports use the core CSV writers. Single-session CSVs are also
 *   de-identified first, so event notes never leave the device by accident.
 * - Delivery is platform specific (`files.ts` on the web, `files.native.ts`
 *   on iOS/Android); this module only builds content and file names.
 */
import {
  createExportBundle,
  deidentifySession,
  eventsToCsv,
  rrToCsv,
  samplesToCsv,
  summariesToCsv,
} from '@surgeonpulse/core';
import type { ExportBundle, ParticipantProfile, SessionSummary, SurgicalSession } from '@surgeonpulse/core';
import { appInfo } from '../platform';
import { deliverTextFile, pickTextFile } from './files';
import { exportFileName } from './naming';

export type SessionCsvKind = 'samples' | 'rr' | 'events';

export interface BundleExport {
  filename: string;
  json: string;
  bundle: ExportBundle;
}

/** Build (without delivering) the export bundle and its file name. */
export function buildBundleExport(
  sessions: SurgicalSession[],
  opts: { deidentify?: boolean; profile?: ParticipantProfile | null; now?: number } = {},
): BundleExport {
  const now = opts.now ?? Date.now();
  const profile = opts.profile ?? null;
  const bundle = createExportBundle({
    sessions,
    participants: profile ? [profile] : [],
    app: appInfo(),
    deidentify: opts.deidentify ?? true,
    now,
  });
  const code = profile?.code ?? sessions[0]?.participantCode ?? null;
  return { filename: exportFileName(code, now, 'json'), json: JSON.stringify(bundle), bundle };
}

/** Share/download a JSON export bundle of `sessions` (de-identified unless `deidentify: false`). */
export async function shareBundle(
  sessions: SurgicalSession[],
  opts?: { deidentify?: boolean; profile?: ParticipantProfile | null },
): Promise<void> {
  if (sessions.length === 0) throw new Error('There are no sessions to export.');
  const { filename, json } = buildBundleExport(sessions, opts);
  await deliverTextFile(filename, json, 'application/json');
}

/** Build (without delivering) one CSV of a single session. */
export function buildSessionCsv(session: SurgicalSession, kind: SessionCsvKind): { filename: string; csv: string } {
  const clean = deidentifySession(session);
  const csv = kind === 'samples' ? samplesToCsv(clean) : kind === 'rr' ? rrToCsv(clean) : eventsToCsv(clean);
  return { filename: exportFileName(session.participantCode, session.startedAt, 'csv', kind), csv };
}

/** Share/download the samples, RR or events of one session as CSV. */
export async function shareSessionCsv(session: SurgicalSession, kind: SessionCsvKind): Promise<void> {
  const { filename, csv } = buildSessionCsv(session, kind);
  await deliverTextFile(filename, csv, 'text/csv');
}

/** Share/download one wide row per session (for SPSS / R / Stata). */
export async function shareSummariesCsv(summaries: SessionSummary[]): Promise<void> {
  if (summaries.length === 0) throw new Error('There are no session summaries to export.');
  const csv = summariesToCsv(summaries);
  const code = summaries[0]?.participantCode ?? null;
  await deliverTextFile(exportFileName(code, Date.now(), 'csv', 'summaries'), csv, 'text/csv');
}

/** Ask the user for an export file and return its text, or null when cancelled. */
export function pickImportFile(): Promise<string | null> {
  return pickTextFile('.json,application/json,text/plain');
}
