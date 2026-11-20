/**
 * Participant lifecycle: registration, enrolment tokens and withdrawal.
 * Each operation is one transaction that also writes its audit row.
 */
import { randomUUID } from 'node:crypto';
import { ParticipantProfileSchema } from '@surgeonpulse/core';
import type { ParticipantProfile } from '@surgeonpulse/core';
import { generateEnrolmentToken, hashToken } from '../auth';
import type { AuthContext } from '../auth';
import { HttpError, zodDetails } from '../http';
import type { ParticipantRecord, Repo } from '../repo';

/** Audit actor for an authenticated request: `admin` or `participant:<code>`. */
export function actorOf(auth: AuthContext | null): string {
  if (auth === null) return 'anonymous';
  return auth.kind === 'admin' ? 'admin' : `participant:${auth.participantCode}`;
}

/** Validate profile fields with core's schema; `code` always comes from the caller. */
export function parseProfile(code: string, fields: Record<string, unknown> | undefined): ParticipantProfile {
  const parsed = ParticipantProfileSchema.safeParse({ ...(fields ?? {}), code });
  if (!parsed.success) throw new HttpError(400, 'invalid profile', zodDetails(parsed.error).map((d) => `profile.${d}`));
  return { ...parsed.data, code };
}

function withdrawnConflict(code: string): HttpError {
  return new HttpError(409, 'participant has withdrawn', [
    `participant ${code} withdrew from the study; withdrawn codes are retired, so enrol them under a new code if they re-consent`,
  ]);
}

/**
 * Create a participant or replace their profile (SPEC: `POST /admin/participants`).
 * Without `profile`, an existing participant is left unchanged.
 *
 * @throws HttpError 409 if the participant has withdrawn.
 */
export function upsertParticipant(
  repo: Repo,
  input: { code: string; profile?: Record<string, unknown> },
  actor: string,
  now: number,
): { created: boolean; participant: ParticipantRecord } {
  const profile = parseProfile(input.code, input.profile);
  return repo.transaction(() => {
    const existing = repo.getParticipant(input.code);
    if (existing === undefined) {
      repo.insertParticipant(profile, now);
      repo.audit({ actor, action: 'participant.create', target: input.code }, now);
    } else {
      if (existing.withdrawnAt !== null) throw withdrawnConflict(input.code);
      if (input.profile !== undefined) {
        repo.updateParticipantProfile(profile);
        repo.audit({ actor, action: 'participant.update', target: input.code, detail: { fields: Object.keys(profile) } }, now);
      }
    }
    const participant = repo.getParticipant(input.code);
    if (participant === undefined) throw new Error('participant missing after upsert');
    return { created: existing === undefined, participant };
  });
}

export interface CreatedEnrolment {
  id: string;
  /** The bearer token. Returned once; only its hash is stored. */
  token: string;
  participantCode: string;
  label: string | null;
  createdAt: number;
}

/**
 * Issue an enrolment token for a participant, creating the participant if
 * missing (SPEC: `POST /admin/enrolments`).
 *
 * @throws HttpError 409 if the participant has withdrawn.
 */
export function createEnrolment(
  repo: Repo,
  input: { participantCode: string; label?: string },
  actor: string,
  now: number,
): CreatedEnrolment {
  const token = generateEnrolmentToken();
  const enrolment: CreatedEnrolment = {
    id: randomUUID(),
    token,
    participantCode: input.participantCode,
    label: input.label ?? null,
    createdAt: now,
  };
  repo.transaction(() => {
    const existing = repo.getParticipant(input.participantCode);
    if (existing === undefined) {
      repo.insertParticipant({ code: input.participantCode }, now);
      repo.audit({ actor, action: 'participant.create', target: input.participantCode }, now);
    } else if (existing.withdrawnAt !== null) {
      throw withdrawnConflict(input.participantCode);
    }
    repo.insertEnrolment(
      { id: enrolment.id, participantCode: input.participantCode, tokenHash: hashToken(token), label: enrolment.label },
      now,
    );
    repo.audit(
      { actor, action: 'enrolment.create', target: enrolment.id, detail: { participantCode: input.participantCode } },
      now,
    );
  });
  return enrolment;
}

/** Revoke one enrolment. @returns false if no enrolment has that id. Revoking twice is a no-op. */
export function revokeEnrolment(repo: Repo, id: string, actor: string, now: number): boolean {
  return repo.transaction(() => {
    const enrolment = repo.getEnrolment(id);
    if (enrolment === undefined) return false;
    if (repo.revokeEnrolment(id, now)) {
      repo.audit({ actor, action: 'enrolment.revoke', target: id, detail: { participantCode: enrolment.participantCode } }, now);
    }
    return true;
  });
}

export interface WithdrawalResult {
  deletedSessions: number;
  revokedEnrolments: number;
}

/**
 * Withdraw a participant (both the participant's own request and the
 * researcher-actioned path): delete all their sessions, revoke all their
 * enrolments, mark them withdrawn and reduce the stored profile to the bare
 * code. Idempotent.
 *
 * @returns null if the participant does not exist.
 */
export function withdrawParticipant(repo: Repo, code: string, actor: string, now: number): WithdrawalResult | null {
  return repo.transaction(() => {
    const participant = repo.getParticipant(code);
    if (participant === undefined) return null;
    const deletedSessions = repo.deleteSessionsOf(code);
    const revokedEnrolments = repo.revokeEnrolmentsOf(code, now);
    if (participant.withdrawnAt === null) repo.markWithdrawn(code, now);
    repo.audit({ actor, action: 'participant.withdraw', target: code, detail: { deletedSessions, revokedEnrolments } }, now);
    return { deletedSessions, revokedEnrolments };
  });
}
