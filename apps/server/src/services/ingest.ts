/**
 * Session upload (SPEC: `POST /api/v1/sessions`).
 *
 * 1. `parseImport` (core) accepts an ExportBundle, a single session or an
 *    array of sessions. Sessions it skips become `rejected` entries.
 * 2. Every session must belong to the token's participant.
 * 3. Each accepted session is de-identified again server-side with core's
 *    `deidentifySession` defaults (defence in depth: notes, free-text
 *    procedure names and sensor ids are removed even if the app sent them),
 *    summarised with `summarizeSession`, and stored.
 * 4. Upsert by id with a SHA-256 of the canonical JSON: `created`, `updated`,
 *    or `unchanged` when the digest matches the stored one.
 * 5. A profile for the token's participant in the bundle replaces the stored
 *    profile (the code itself is immutable).
 *
 * CPU-heavy work (parsing, summaries, hashing) happens before the write
 * transaction; all writes and the audit row are then committed atomically.
 */
import { SessionParseError, deidentifySession, parseImport, summarizeSession } from '@surgeonpulse/core';
import type { ExportBundle, ParticipantProfile, SurgicalSession } from '@surgeonpulse/core';
import { canonicalJson, sha256Hex } from '../canonical';
import { HttpError } from '../http';
import type { Repo, SessionWrite } from '../repo';

export type UploadStatus = 'created' | 'updated' | 'unchanged';

export interface UploadResult {
  accepted: { id: string; status: UploadStatus }[];
  rejected: { index: number; id?: string; reason: string }[];
}

export interface IngestOutcome {
  result: UploadResult;
  profileUpdated: boolean;
}

/** Issues returned to the client for an unparseable upload are capped to keep responses small. */
const MAX_DETAILS = 20;
const MAX_REASON_LENGTH = 1000;

/** parseImport names skipped sessions as `Skipped sessions[<index>]: <issues>`. */
const SKIPPED_SESSION_RE = /\bsessions\[(\d+)\]\s*:?\s*([\s\S]*)$/;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Turn parseImport's warnings about skipped sessions into rejections keyed by upload index. */
function skippedSessions(warnings: readonly string[]): UploadResult['rejected'] {
  const rejected: UploadResult['rejected'] = [];
  for (const warning of warnings) {
    const match = SKIPPED_SESSION_RE.exec(warning);
    if (match === null) continue; // e.g. warnings about participants or app info
    const reason = match[2]?.trim() || 'invalid session';
    rejected.push({ index: Number(match[1]), reason: truncate(reason, MAX_REASON_LENGTH) });
  }
  return rejected;
}

/**
 * Map positions in `bundle.sessions` back to positions in the upload:
 * parseImport keeps valid sessions in order and drops the skipped indices.
 */
function originalIndices(count: number, skipped: ReadonlySet<number>): number[] {
  const out: number[] = [];
  for (let i = 0; out.length < count; i++) {
    if (!skipped.has(i)) out.push(i);
  }
  return out;
}

/** De-identify, summarise and hash one session for storage. */
export function prepareSession(session: SurgicalSession): SessionWrite {
  const clean = deidentifySession(session);
  const summary = summarizeSession(clean);
  return {
    id: clean.id,
    participantCode: clean.participantCode,
    startedAt: clean.startedAt,
    endedAt: clean.endedAt ?? summary.endedAt,
    procedureName: clean.procedure.name,
    specialty: clean.procedure.specialty ?? null,
    body: JSON.stringify(clean),
    sha256: sha256Hex(canonicalJson(clean)),
    summary,
  };
}

/**
 * The profile in the bundle for `code`, if it carries any information.
 * parseImport synthesises a bare `{ code }` for sessions without a profile;
 * that placeholder must not wipe a richer stored profile.
 */
function bundleProfile(bundle: ExportBundle, code: string): ParticipantProfile | null {
  const profile = bundle.participants.find((p) => p.code === code);
  if (profile === undefined) return null;
  if (Object.keys(profile).every((k) => k === 'code')) return null;
  return { ...profile, code };
}

function parseUpload(text: string | undefined): { bundle: ExportBundle; warnings: string[] } {
  if (text === undefined || text.trim() === '') throw new HttpError(400, 'empty body');
  try {
    return parseImport(text);
  } catch (err) {
    if (err instanceof SessionParseError) {
      const details = err.issues.slice(0, MAX_DETAILS).map((d) => truncate(d, MAX_REASON_LENGTH));
      throw new HttpError(400, 'invalid upload', details);
    }
    throw err;
  }
}

export interface IngestInput {
  /** Raw request body (JSON text). */
  text: string | undefined;
  /** Participant the enrolment token belongs to. */
  participantCode: string;
  repo: Repo;
  now: number;
  /** Called when a session cannot be processed (index only; never data). */
  onProcessingError?: (index: number, error: unknown) => void;
}

/**
 * Validate, de-identify, summarise and store an upload.
 *
 * @throws HttpError 400 for an empty or unparseable body, or one with no sessions.
 */
export function ingestUpload(input: IngestInput): IngestOutcome {
  const { participantCode, repo, now } = input;
  const { bundle, warnings } = parseUpload(input.text);

  const rejected = skippedSessions(warnings);
  if (bundle.sessions.length === 0 && rejected.length === 0) {
    throw new HttpError(400, 'no sessions in upload');
  }

  const indices = originalIndices(bundle.sessions.length, new Set(rejected.map((r) => r.index)));
  const prepared: { index: number; write: SessionWrite }[] = [];
  bundle.sessions.forEach((session, position) => {
    const index = indices[position] ?? position;
    if (session.participantCode !== participantCode) {
      rejected.push({ index, id: session.id, reason: 'participantCode does not match the enrolment token' });
      return;
    }
    try {
      prepared.push({ index, write: prepareSession(session) });
    } catch (err) {
      input.onProcessingError?.(index, err);
      rejected.push({ index, id: session.id, reason: 'session could not be processed' });
    }
  });

  const statuses = new Map<number, { id: string; status: UploadStatus }>();
  const profile = bundleProfile(bundle, participantCode);
  let profileUpdated = false;

  repo.transaction(() => {
    for (const { index, write } of prepared) {
      const existing = repo.getSessionMeta(write.id);
      if (existing === undefined) {
        repo.insertSession(write, now);
        statuses.set(index, { id: write.id, status: 'created' });
      } else if (existing.participantCode !== participantCode) {
        rejected.push({ index, id: write.id, reason: 'session id conflicts with an existing session' });
      } else if (existing.sha256 === write.sha256) {
        statuses.set(index, { id: write.id, status: 'unchanged' });
      } else {
        repo.updateSession(write, now);
        statuses.set(index, { id: write.id, status: 'updated' });
      }
    }

    if (profile !== null) {
      const stored = repo.getParticipant(participantCode);
      if (stored !== undefined && canonicalJson(stored.profile) !== canonicalJson(profile)) {
        repo.updateParticipantProfile(profile);
        profileUpdated = true;
      }
    }

    const accepted = [...statuses.values()];
    repo.audit(
      {
        actor: `participant:${participantCode}`,
        action: 'sessions.upload',
        target: participantCode,
        detail: {
          created: accepted.filter((a) => a.status === 'created').length,
          updated: accepted.filter((a) => a.status === 'updated').length,
          unchanged: accepted.filter((a) => a.status === 'unchanged').length,
          rejected: rejected.length,
          profileUpdated,
        },
      },
      now,
    );
  });

  const accepted = [...statuses.entries()].sort((a, b) => a[0] - b[0]).map(([, entry]) => entry);
  rejected.sort((a, b) => a.index - b.index);
  return { result: { accepted, rejected }, profileUpdated };
}
