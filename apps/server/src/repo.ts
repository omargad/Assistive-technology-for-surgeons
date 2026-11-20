/**
 * Typed data access over the SQLite schema in `db.ts`.
 *
 * Every statement is prepared once (filtered session queries are prepared
 * on first use and cached per filter combination). Every write runs inside
 * {@link transaction}; callers can wrap several repository calls in
 * `repo.transaction(() => …)` to make them one atomic unit.
 *
 * JSON columns (`profile`, `body`, `summary`, `detail`) are written by this
 * server only, so they are parsed without re-validation.
 */
import type { StatementSync } from 'node:sqlite';
import type { ParticipantProfile, SessionSummary } from '@surgeonpulse/core';
import { transaction } from './db';
import type { Database } from './db';

// ---------------------------------------------------------------------------
// Record types
// ---------------------------------------------------------------------------

export interface ParticipantRecord {
  code: string;
  profile: ParticipantProfile;
  createdAt: number;
  withdrawnAt: number | null;
}

export interface ParticipantListItem extends ParticipantRecord {
  withdrawn: boolean;
  sessionCount: number;
  /** All enrolments ever issued, including revoked ones. */
  enrolmentCount: number;
  /** Enrolments that are not revoked. */
  activeEnrolmentCount: number;
  lastUploadAt: number | null;
}

export interface EnrolmentRecord {
  id: string;
  participantCode: string;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/** What authentication needs to know about the enrolment behind a token. */
export interface EnrolmentAuthRecord {
  id: string;
  participantCode: string;
  revokedAt: number | null;
  participantWithdrawnAt: number | null;
}

export interface SessionMeta {
  id: string;
  participantCode: string;
  sha256: string;
}

/** A session ready to store: the de-identified JSON, its digest and its summary. */
export interface SessionWrite {
  id: string;
  participantCode: string;
  startedAt: number;
  endedAt: number | null;
  procedureName: string;
  specialty: string | null;
  body: string;
  sha256: string;
  summary: SessionSummary;
}

export interface SessionListItem {
  id: string;
  participantCode: string;
  startedAt: number;
  endedAt: number | null;
  procedureName: string;
  specialty: string | null;
  receivedAt: number;
  summary: SessionSummary;
}

/** Filters shared by the session list and the exports. */
export interface SessionFilter {
  participant?: string;
  /** Inclusive lower bound on `startedAt` (epoch ms). */
  from?: number;
  /** Exclusive upper bound on `startedAt` (epoch ms). */
  to?: number;
  /** Case-insensitive exact match on the procedure specialty. */
  specialty?: string;
  limit?: number;
  offset?: number;
}

export interface AuditRecord {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string | null;
  detail: unknown;
}

export interface ParticipantStats {
  sessionCount: number;
  lastUploadAt: number | null;
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Params = Record<string, string | number | null>;

function getRow(stmt: StatementSync, params: Params = {}): Row | undefined {
  return stmt.get(params) as Row | undefined;
}

function allRows(stmt: StatementSync, params: Params = {}): Row[] {
  return stmt.all(params) as Row[];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : String(v);
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v);
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v);
}

function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : str(v);
}

function json<T>(v: unknown): T {
  return JSON.parse(str(v)) as T;
}

function toParticipant(r: Row): ParticipantRecord {
  return {
    code: str(r.code),
    profile: json<ParticipantProfile>(r.profile),
    createdAt: num(r.created_at),
    withdrawnAt: numOrNull(r.withdrawn_at),
  };
}

function toEnrolment(r: Row): EnrolmentRecord {
  return {
    id: str(r.id),
    participantCode: str(r.participant_code),
    label: strOrNull(r.label),
    createdAt: num(r.created_at),
    lastUsedAt: numOrNull(r.last_used_at),
    revokedAt: numOrNull(r.revoked_at),
  };
}

function toSessionListItem(r: Row): SessionListItem {
  return {
    id: str(r.id),
    participantCode: str(r.participant_code),
    startedAt: num(r.started_at),
    endedAt: numOrNull(r.ended_at),
    procedureName: str(r.procedure_name),
    specialty: strOrNull(r.specialty),
    receivedAt: num(r.received_at),
    summary: json<SessionSummary>(r.summary),
  };
}

/** Build the WHERE clause and parameters for a {@link SessionFilter}. */
function sessionWhere(filter: SessionFilter): { sql: string; params: Params } {
  const clauses: string[] = [];
  const params: Params = {};
  if (filter.participant !== undefined) {
    clauses.push('participant_code = :participant');
    params.participant = filter.participant;
  }
  if (filter.from !== undefined) {
    clauses.push('started_at >= :from');
    params.from = filter.from;
  }
  if (filter.to !== undefined) {
    clauses.push('started_at < :to');
    params.to = filter.to;
  }
  if (filter.specialty !== undefined) {
    clauses.push('specialty = :specialty COLLATE NOCASE');
    params.specialty = filter.specialty;
  }
  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** Append LIMIT/OFFSET (bound as parameters) when present. */
function paging(filter: SessionFilter, params: Params): string {
  if (filter.limit === undefined && filter.offset === undefined) return '';
  params.limit = filter.limit ?? -1; // SQLite: a negative LIMIT means "no limit"
  params.offset = filter.offset ?? 0;
  return 'LIMIT :limit OFFSET :offset';
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export type Repo = ReturnType<typeof createRepo>;

/** Create the repository for an open database. */
export function createRepo(db: Database) {
  const stmt = {
    ping: db.prepare('SELECT 1 AS ok'),

    getParticipant: db.prepare('SELECT * FROM participants WHERE code = :code'),
    insertParticipant: db.prepare(
      'INSERT INTO participants (code, profile, created_at, withdrawn_at) VALUES (:code, :profile, :now, NULL)',
    ),
    updateProfile: db.prepare('UPDATE participants SET profile = :profile WHERE code = :code'),
    markWithdrawn: db.prepare('UPDATE participants SET withdrawn_at = :now, profile = :profile WHERE code = :code'),
    listParticipants: db.prepare(`
      SELECT p.code, p.profile, p.created_at, p.withdrawn_at,
        (SELECT COUNT(*) FROM sessions s WHERE s.participant_code = p.code) AS session_count,
        (SELECT MAX(s.updated_at) FROM sessions s WHERE s.participant_code = p.code) AS last_upload_at,
        (SELECT COUNT(*) FROM enrolments e WHERE e.participant_code = p.code) AS enrolment_count,
        (SELECT COUNT(*) FROM enrolments e WHERE e.participant_code = p.code AND e.revoked_at IS NULL)
          AS active_enrolment_count
      FROM participants p
      ORDER BY p.code`),
    participantStats: db.prepare(
      'SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM sessions WHERE participant_code = :code',
    ),

    insertEnrolment: db.prepare(`
      INSERT INTO enrolments (id, participant_code, token_hash, label, created_at, last_used_at, revoked_at)
      VALUES (:id, :code, :hash, :label, :now, NULL, NULL)`),
    listEnrolments: db.prepare(
      'SELECT id, participant_code, label, created_at, last_used_at, revoked_at FROM enrolments ORDER BY created_at, id',
    ),
    getEnrolment: db.prepare(
      'SELECT id, participant_code, label, created_at, last_used_at, revoked_at FROM enrolments WHERE id = :id',
    ),
    revokeEnrolment: db.prepare('UPDATE enrolments SET revoked_at = :now WHERE id = :id AND revoked_at IS NULL'),
    revokeEnrolmentsOf: db.prepare(
      'UPDATE enrolments SET revoked_at = :now WHERE participant_code = :code AND revoked_at IS NULL',
    ),
    findEnrolmentByHash: db.prepare(`
      SELECT e.id, e.participant_code, e.revoked_at, p.withdrawn_at
      FROM enrolments e JOIN participants p ON p.code = e.participant_code
      WHERE e.token_hash = :hash`),
    touchEnrolment: db.prepare('UPDATE enrolments SET last_used_at = :now WHERE id = :id'),

    getSessionMeta: db.prepare('SELECT id, participant_code, sha256 FROM sessions WHERE id = :id'),
    getSessionBody: db.prepare('SELECT body FROM sessions WHERE id = :id'),
    insertSession: db.prepare(`
      INSERT INTO sessions (id, participant_code, started_at, ended_at, procedure_name, specialty, body, sha256,
                            summary, received_at, updated_at)
      VALUES (:id, :code, :startedAt, :endedAt, :procedureName, :specialty, :body, :sha256, :summary, :now, :now)`),
    updateSession: db.prepare(`
      UPDATE sessions SET started_at = :startedAt, ended_at = :endedAt, procedure_name = :procedureName,
        specialty = :specialty, body = :body, sha256 = :sha256, summary = :summary, updated_at = :now
      WHERE id = :id AND participant_code = :code`),
    deleteSession: db.prepare('DELETE FROM sessions WHERE id = :id'),
    deleteSessionsOf: db.prepare('DELETE FROM sessions WHERE participant_code = :code'),

    insertAudit: db.prepare(
      'INSERT INTO audit (at, actor, action, target, detail) VALUES (:now, :actor, :action, :target, :detail)',
    ),
    listAudit: db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT :limit'),
  };

  /** Cache of prepared statements for filtered session queries, keyed by SQL text. */
  const filtered = new Map<string, StatementSync>();
  function prepareCached(sql: string): StatementSync {
    let s = filtered.get(sql);
    if (s === undefined) {
      s = db.prepare(sql);
      filtered.set(sql, s);
    }
    return s;
  }

  function sessionParams(s: SessionWrite, now: number): Params {
    return {
      id: s.id,
      code: s.participantCode,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      procedureName: s.procedureName,
      specialty: s.specialty,
      body: s.body,
      sha256: s.sha256,
      summary: JSON.stringify(s.summary),
      now,
    };
  }

  return {
    /** Run several repository calls atomically (see {@link transaction}). */
    transaction<T>(fn: () => T): T {
      return transaction(db, fn);
    },

    /** Cheap liveness check for `/health`. */
    ping(): boolean {
      return getRow(stmt.ping)?.ok === 1;
    },

    // -- participants -------------------------------------------------------

    getParticipant(code: string): ParticipantRecord | undefined {
      const r = getRow(stmt.getParticipant, { code });
      return r === undefined ? undefined : toParticipant(r);
    },

    insertParticipant(profile: ParticipantProfile, now: number): void {
      transaction(db, () => {
        stmt.insertParticipant.run({ code: profile.code, profile: JSON.stringify(profile), now });
      });
    },

    updateParticipantProfile(profile: ParticipantProfile): void {
      transaction(db, () => {
        stmt.updateProfile.run({ code: profile.code, profile: JSON.stringify(profile) });
      });
    },

    /** Mark withdrawn and reduce the stored profile to the bare code. */
    markWithdrawn(code: string, now: number): void {
      transaction(db, () => {
        stmt.markWithdrawn.run({ code, now, profile: JSON.stringify({ code }) });
      });
    },

    listParticipants(): ParticipantListItem[] {
      return allRows(stmt.listParticipants).map((r) => {
        const base = toParticipant(r);
        return {
          ...base,
          withdrawn: base.withdrawnAt !== null,
          sessionCount: num(r.session_count),
          enrolmentCount: num(r.enrolment_count),
          activeEnrolmentCount: num(r.active_enrolment_count),
          lastUploadAt: numOrNull(r.last_upload_at),
        };
      });
    },

    /** Profiles for the given codes, in the given order (unknown codes are skipped). */
    participantProfiles(codes: readonly string[]): ParticipantProfile[] {
      const out: ParticipantProfile[] = [];
      for (const code of codes) {
        const r = getRow(stmt.getParticipant, { code });
        if (r !== undefined) out.push(toParticipant(r).profile);
      }
      return out;
    },

    participantStats(code: string): ParticipantStats {
      const r = getRow(stmt.participantStats, { code });
      return { sessionCount: num(r?.n ?? 0), lastUploadAt: numOrNull(r?.last) };
    },

    // -- enrolments ---------------------------------------------------------

    insertEnrolment(e: { id: string; participantCode: string; tokenHash: string; label: string | null }, now: number): void {
      transaction(db, () => {
        stmt.insertEnrolment.run({ id: e.id, code: e.participantCode, hash: e.tokenHash, label: e.label, now });
      });
    },

    listEnrolments(): EnrolmentRecord[] {
      return allRows(stmt.listEnrolments).map(toEnrolment);
    },

    getEnrolment(id: string): EnrolmentRecord | undefined {
      const r = getRow(stmt.getEnrolment, { id });
      return r === undefined ? undefined : toEnrolment(r);
    },

    /** @returns true when the enrolment was active and is now revoked. */
    revokeEnrolment(id: string, now: number): boolean {
      return transaction(db, () => num(stmt.revokeEnrolment.run({ id, now }).changes) > 0);
    },

    /** Revoke every active enrolment of a participant. @returns the number revoked. */
    revokeEnrolmentsOf(code: string, now: number): number {
      return transaction(db, () => num(stmt.revokeEnrolmentsOf.run({ code, now }).changes));
    },

    findEnrolmentByTokenHash(hash: string): EnrolmentAuthRecord | undefined {
      const r = getRow(stmt.findEnrolmentByHash, { hash });
      if (r === undefined) return undefined;
      return {
        id: str(r.id),
        participantCode: str(r.participant_code),
        revokedAt: numOrNull(r.revoked_at),
        participantWithdrawnAt: numOrNull(r.withdrawn_at),
      };
    },

    touchEnrolment(id: string, now: number): void {
      transaction(db, () => {
        stmt.touchEnrolment.run({ id, now });
      });
    },

    // -- sessions -----------------------------------------------------------

    getSessionMeta(id: string): SessionMeta | undefined {
      const r = getRow(stmt.getSessionMeta, { id });
      if (r === undefined) return undefined;
      return { id: str(r.id), participantCode: str(r.participant_code), sha256: str(r.sha256) };
    },

    /** The stored (de-identified) session JSON text. */
    getSessionBody(id: string): string | undefined {
      const r = getRow(stmt.getSessionBody, { id });
      return r === undefined ? undefined : str(r.body);
    },

    insertSession(s: SessionWrite, now: number): void {
      transaction(db, () => {
        stmt.insertSession.run(sessionParams(s, now));
      });
    },

    updateSession(s: SessionWrite, now: number): void {
      transaction(db, () => {
        stmt.updateSession.run(sessionParams(s, now));
      });
    },

    /** @returns true when a session was deleted. */
    deleteSession(id: string): boolean {
      return transaction(db, () => num(stmt.deleteSession.run({ id }).changes) > 0);
    },

    /** @returns the number of sessions deleted. */
    deleteSessionsOf(code: string): number {
      return transaction(db, () => num(stmt.deleteSessionsOf.run({ code }).changes));
    },

    countSessions(filter: SessionFilter): number {
      const { sql, params } = sessionWhere(filter);
      return num(getRow(prepareCached(`SELECT COUNT(*) AS n FROM sessions ${sql}`), params)?.n ?? 0);
    },

    /** Session metadata and summaries, ordered by `startedAt` then id. */
    listSessions(filter: SessionFilter): SessionListItem[] {
      const { sql, params } = sessionWhere(filter);
      const page = paging(filter, params);
      const query = `
        SELECT id, participant_code, started_at, ended_at, procedure_name, specialty, received_at, summary
        FROM sessions ${sql} ORDER BY started_at, id ${page}`;
      return allRows(prepareCached(query), params).map(toSessionListItem);
    },

    /** Stored session JSON texts, ordered by `startedAt` then id. */
    sessionBodies(filter: SessionFilter): string[] {
      const { sql, params } = sessionWhere(filter);
      const page = paging(filter, params);
      const query = `SELECT body FROM sessions ${sql} ORDER BY started_at, id ${page}`;
      return allRows(prepareCached(query), params).map((r) => str(r.body));
    },

    // -- audit --------------------------------------------------------------

    /** Append an audit row. `detail` is stored as JSON and must never contain health data or secrets. */
    audit(entry: { actor: string; action: string; target?: string | null; detail?: unknown }, now: number): void {
      transaction(db, () => {
        stmt.insertAudit.run({
          now,
          actor: entry.actor,
          action: entry.action,
          target: entry.target ?? null,
          detail: entry.detail === undefined ? null : JSON.stringify(entry.detail),
        });
      });
    },

    /** Latest audit rows, newest first. */
    listAudit(limit: number): AuditRecord[] {
      return allRows(stmt.listAudit, { limit }).map((r) => ({
        id: num(r.id),
        at: num(r.at),
        actor: str(r.actor),
        action: str(r.action),
        target: strOrNull(r.target),
        detail: r.detail === null || r.detail === undefined ? null : json<unknown>(r.detail),
      }));
    },
  };
}
