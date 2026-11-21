import type {
  HeartRateSample,
  ParticipantProfile,
  RRInterval,
  SessionSummary,
  SurgicalSession,
} from '@surgeonpulse/core';

/** Session metadata = everything except the bulky signal arrays. */
export type SessionMeta = Omit<SurgicalSession, 'samples' | 'rr'>;

/** Row shown in the History list (no signal data loaded). */
export interface SessionListItem {
  meta: SessionMeta;
  /** Cached summary (computed on completion / import); null while recording or if not yet computed. */
  summary: SessionSummary | null;
  sampleCount: number;
}

/**
 * Persistent local storage for sessions and the participant profile.
 *
 * Implementations:
 * - `sqlite.ts`  — expo-sqlite (iOS/Android). Signals are stored in their own
 *   tables and appended in batched transactions so a crash mid-case loses at
 *   most one flush interval of data.
 * - `memory.ts`  — in-memory (tests) with optional localStorage persistence (web).
 *
 * All methods must be safe to call concurrently (serialise writes internally).
 */
export interface SessionRepository {
  init(): Promise<void>;

  listSessions(): Promise<SessionListItem[]>; // newest first
  getSession(id: string): Promise<SurgicalSession | null>;
  /** Insert a new session (typically status 'recording' with empty arrays). */
  createSession(session: SurgicalSession): Promise<void>;
  /** Append signal data to a session (ordered append; caller guarantees non-decreasing t per call). */
  appendSignals(id: string, samples: readonly HeartRateSample[], rr: readonly RRInterval[]): Promise<void>;
  /** Replace metadata fields (events, postOp, status, endedAt, baseline, procedure, tags…). */
  updateMeta(id: string, patch: Partial<SessionMeta>): Promise<void>;
  /** Insert or fully replace a session including signals (imports, demo data, retrospective HR import). */
  saveSession(session: SurgicalSession): Promise<void>;
  saveSummary(id: string, summary: SessionSummary): Promise<void>;
  deleteSession(id: string): Promise<void>;
  /** Delete every session and its signals. The profile is kept (see `deleteProfile`). */
  deleteAll(): Promise<void>;
  /** Sessions left in status 'recording' (app was killed mid-case) — offered for recovery on launch. */
  findInterrupted(): Promise<SessionMeta[]>;

  getProfile(): Promise<ParticipantProfile | null>;
  saveProfile(profile: ParticipantProfile): Promise<void>;
  /** Remove the stored profile (participant code, consent record, optional fields). Used by "Delete all data". */
  deleteProfile(): Promise<void>;
}
