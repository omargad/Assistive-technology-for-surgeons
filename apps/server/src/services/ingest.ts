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
 * Participant codes are compared case-insensitively (stored codes are upper
 * case; the app upper-cases them too) and each stored session carries the
 * enrolment's code. An upload whose profile records withdrawn consent is
 * refused (409). Simulated and demo sessions are rejected unless the server
 * runs with `ACCEPT_SIMULATED=true`. Session and event ids must be short
 * machine identifiers (so ids cannot carry free text and every stored session
 * is addressable by `/sessions/:id`), and server-side de-identification also
 * drops a specialty outside core's catalogue and a non-standard sensor
 * location.
 *
 * CPU-heavy work (parsing, summaries, hashing) happens before the write
 * transaction; all writes and the audit row are then committed atomically.
 */
import {
  ANALYTICS_VERSION,
  PROCEDURE_SPECIALTIES,
  SessionParseError,
  deidentifySession,
  isSyntheticSession,
  parseImport,
  summarizeSession,
} from '@surgeonpulse/core';
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

/** Session and event ids: 1–100 characters (Fastify's default route-parameter limit), no free text. */
export const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

/** Body Sensor Location values (BLE characteristic 0x2A38) as core's parser names them. */
export const SENSOR_LOCATIONS: readonly string[] = ['other', 'chest', 'wrist', 'finger', 'hand', 'ear-lobe', 'foot'];

/**
 * Whether a session is simulated or demo data rather than a real recording (sensor source 'simulated' or a
 * 'simulated'/'demo' tag, which core's de-identification keeps). Core's definition, re-exported so the
 * server, the summaries' `simulated` column and the app all agree.
 */
export { isSyntheticSession };

/** Reason to reject a session whose ids could carry free text or not be addressable, or null. */
function idProblem(session: SurgicalSession): string | null {
  if (!SAFE_ID_RE.test(session.id)) return 'session id must be 1–100 letters, digits, ".", "_", ":" or "-"';
  if (session.events.some((e) => !SAFE_ID_RE.test(e.id))) {
    return 'event ids must be 1–100 letters, digits, ".", "_", ":" or "-"';
  }
  return null;
}

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

/**
 * Core de-identification plus the server's own rules for fields core keeps as typed: a specialty
 * is kept only when it is one of core's catalogue specialties (in the catalogue's spelling), and
 * `sensor.location` only when it is a standard Body Sensor Location value.
 */
function deidentifyForStorage(session: SurgicalSession): SurgicalSession {
  const clean = deidentifySession(session);
  withKnownSpecialty(clean.procedure);
  if (clean.participantSnapshot !== undefined) withKnownSpecialty(clean.participantSnapshot);
  if (clean.sensor.location !== undefined && !SENSOR_LOCATIONS.includes(clean.sensor.location)) {
    delete clean.sensor.location;
  }
  return clean;
}

/** Replace `specialty` with core's catalogue spelling, or remove it when it is not a catalogue specialty. */
function withKnownSpecialty(target: { specialty?: string }): void {
  const typed = target.specialty;
  if (typed === undefined) return;
  const known = PROCEDURE_SPECIALTIES.find((sp) => sp.toLowerCase() === typed.trim().toLowerCase());
  if (known === undefined) delete target.specialty;
  else target.specialty = known;
}

/** De-identify, summarise and hash one session for storage. */
export function prepareSession(session: SurgicalSession): SessionWrite {
  const clean = deidentifyForStorage(session);
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
  const profile = bundle.participants.find((p) => sameCode(p.code, code));
  if (profile === undefined) return null;
  if (Object.keys(profile).every((k) => k === 'code')) return null;
  const out: ParticipantProfile = { ...profile, code };
  withKnownSpecialty(out);
  return out;
}

/** Participant codes match case-insensitively (`sp-014` is `SP-014`). */
function sameCode(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase();
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
  /** Store simulated/demo sessions instead of rejecting them (config `ACCEPT_SIMULATED`). Default false. */
  acceptSimulated?: boolean;
  /** Called when a session cannot be processed (index only; never data). */
  onProcessingError?: (index: number, error: unknown) => void;
}

/**
 * Validate, de-identify, summarise and store an upload.
 *
 * @throws HttpError 400 for an empty or unparseable body, or one with no sessions;
 *   409 when the bundle's profile for this participant records withdrawn consent.
 */
export function ingestUpload(input: IngestInput): IngestOutcome {
  const { participantCode, repo, now } = input;
  const { bundle, warnings } = parseUpload(input.text);

  // A device that recorded the participant's withdrawal must not keep adding data.
  const sent = bundle.participants.find((p) => sameCode(p.code, participantCode));
  if (sent?.consent?.withdrawnAt !== undefined) {
    throw new HttpError(409, 'consent withdrawn', [
      'the uploaded profile records that the participant withdrew consent, so no data is accepted; ' +
        'the participant or the research team can remove data already held with the withdrawal endpoints',
    ]);
  }

  const rejected = skippedSessions(warnings);
  if (bundle.sessions.length === 0 && rejected.length === 0) {
    throw new HttpError(400, 'no sessions in upload');
  }

  const indices = originalIndices(bundle.sessions.length, new Set(rejected.map((r) => r.index)));
  const prepared: { index: number; write: SessionWrite }[] = [];
  bundle.sessions.forEach((original, position) => {
    const index = indices[position] ?? position;
    if (!sameCode(original.participantCode, participantCode)) {
      rejected.push({ index, id: original.id, reason: 'participantCode does not match the enrolment token' });
      return;
    }
    if (input.acceptSimulated !== true && isSyntheticSession(original)) {
      rejected.push({ index, id: original.id, reason: 'simulated or demo data is not accepted by this server' });
      return;
    }
    const badId = idProblem(original);
    if (badId !== null) {
      rejected.push({ index, reason: badId });
      return;
    }
    // Store the enrolment's spelling of the code.
    const session = original.participantCode === participantCode ? original : { ...original, participantCode };
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
        // Same data, but a summary from older analytics definitions is refreshed so exports never mix versions.
        if (existing.analyticsVersion !== ANALYTICS_VERSION) repo.updateSummary(write.id, write.summary);
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
