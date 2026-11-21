/**
 * Session list + participant profile store (zustand).
 *
 * Also hosts the data-management actions of the Settings screen: delete,
 * demo data (core simulator, tagged `demo`, never uploaded) and import of
 * export bundles (core `parseImport`; sessions whose participant code is not a
 * pseudonymous study code, and sessions already on this device, are skipped
 * with a warning). Delete actions refuse the session the recording flow owns.
 */
import {
  ANALYTICS_VERSION,
  isValidParticipantCode,
  parseImport,
  sessionEnd,
  simulateCohort,
  summarizeSession,
} from '@surgeonpulse/core';
import type { ParticipantProfile, SurgicalSession } from '@surgeonpulse/core';
import { create } from 'zustand';
import { repository as defaultRepository } from '../services/storage';
import type { SessionListItem, SessionRepository } from '../services/storage/types';
import { activeSessionId } from './activeSession';
import type { SessionsStore } from './types';

export const DEMO_TAG = 'demo';
/** Code used for demo data when no participant code has been entered yet. */
export const DEMO_PARTICIPANT_CODE = 'DEMO-001';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEMO_SESSIONS = 12;
const DEMO_SPACING_DAYS = 7;
const DEMO_SEED = 20_260_105;

export interface SessionsDeps {
  repository: SessionRepository;
  now?: () => number;
  /** Id of the session the recording flow owns (never deleted from here); see `activeSession.ts`. */
  activeSessionId?: () => string | null;
}

/** Thrown by deleteSession / deleteAll while the recording flow owns a session. */
export const CASE_IN_PROGRESS_ERROR =
  'This case is still in progress. End it on the live screen (and save or skip the debrief) before deleting it.';

function withTag(tags: readonly string[] | undefined, tag: string): string[] {
  return tags?.includes(tag) ? [...tags] : [...(tags ?? []), tag];
}

function describeImportError(error: unknown): Error {
  const issues = (error as { issues?: unknown }).issues;
  const detail =
    Array.isArray(issues) && issues.length > 0
      ? issues.slice(0, 3).map(String).join('; ')
      : error instanceof Error
        ? error.message
        : '';
  return new Error(`This file is not a valid SurgeonPulse export${detail ? `: ${detail}` : '.'}`);
}

export function createSessionsStore(deps: SessionsDeps) {
  const repo = deps.repository;
  const now = deps.now ?? Date.now;

  return create<SessionsStore>()((set, get) => {
    let refreshSeq = 0;
    let recomputing = false;

    /**
     * Recompute cached summaries of completed sessions that were computed by older analytics definitions
     * (`summary.analyticsVersion` differs), so History, Insights and the summaries CSV never mix two
     * definitions after an update. Runs in the background after a refresh; returns whether anything changed.
     */
    async function refreshStaleSummaries(items: readonly SessionListItem[]): Promise<boolean> {
      if (recomputing) return false;
      const stale = items.filter(
        (i) => i.meta.status === 'completed' && i.summary != null && i.summary.analyticsVersion !== ANALYTICS_VERSION,
      );
      if (stale.length === 0) return false;
      recomputing = true;
      let changed = false;
      try {
        for (const item of stale) {
          try {
            const session = await repo.getSession(item.meta.id);
            if (!session || session.status !== 'completed') continue;
            await repo.saveSummary(session.id, summarizeSession(session));
            changed = true;
          } catch {
            // Keep the old summary; the session screen recomputes it when opened.
          }
        }
      } finally {
        recomputing = false;
      }
      return changed;
    }

    async function currentProfile(): Promise<ParticipantProfile | null> {
      return get().profile ?? (await repo.getProfile());
    }

    return {
      items: [],
      profile: null,
      loading: false,

      async refresh() {
        const seq = ++refreshSeq;
        set({ loading: true });
        try {
          await repo.init();
          const [items, profile] = await Promise.all([repo.listSessions(), repo.getProfile()]);
          // Ignore results of a refresh that a newer one has overtaken.
          if (seq === refreshSeq) set({ items, profile, loading: false });
          void refreshStaleSummaries(items).then((changed) => {
            if (changed) void get().refresh();
          });
        } catch {
          if (seq === refreshSeq) set({ loading: false });
        }
      },

      async saveProfile(profile) {
        await repo.saveProfile(profile);
        set({ profile });
      },

      async deleteSession(id) {
        if (deps.activeSessionId?.() === id) throw new Error(CASE_IN_PROGRESS_ERROR);
        await repo.deleteSession(id);
        set({ items: get().items.filter((item) => item.meta.id !== id) });
        await get().refresh();
      },

      async deleteAll() {
        if (deps.activeSessionId?.() != null) throw new Error(CASE_IN_PROGRESS_ERROR);
        await repo.deleteAll();
        set({ items: [] });
        await get().refresh();
      },

      async loadDemoData() {
        const profile = await currentProfile();
        const code = profile?.code ?? DEMO_PARTICIPANT_CODE;

        // Replace earlier demo data rather than duplicating it.
        for (const item of await repo.listSessions()) {
          if (item.meta.tags?.includes(DEMO_TAG)) await repo.deleteSession(item.meta.id);
        }

        const start = now() - (DEMO_SESSIONS * DEMO_SPACING_DAYS + 1) * DAY_MS;
        const cohort = simulateCohort({
          seed: DEMO_SEED,
          participants: 1,
          sessionsPerParticipant: DEMO_SESSIONS,
          start,
          spacingDays: DEMO_SPACING_DAYS,
        });
        for (const simulated of cohort.sessions) {
          const session: SurgicalSession = {
            ...simulated,
            participantCode: code,
            tags: withTag(simulated.tags, DEMO_TAG),
          };
          await repo.saveSession(session);
          try {
            await repo.saveSummary(session.id, summarizeSession(session));
          } catch {
            // the session detail recomputes a missing summary
          }
        }
        await get().refresh();
      },

      async importBundle(text) {
        let parsed: ReturnType<typeof parseImport>;
        try {
          parsed = parseImport(text);
        } catch (error) {
          throw describeImportError(error);
        }
        const warnings = [...parsed.warnings];
        let imported = 0;
        // Never replace a session that is already on this device: an export is de-identified (notes,
        // free-text procedure names, sensor ids and upload tags removed), so re-importing it would
        // silently overwrite the richer local copy (or the case being recorded).
        const known = new Set((await repo.listSessions()).map((item) => item.meta.id));
        const active = deps.activeSessionId?.();
        if (active) known.add(active);
        for (const [index, original] of parsed.bundle.sessions.entries()) {
          if (known.has(original.id)) {
            warnings.push(`Session ${index + 1} is already on this device and was skipped (the local copy is kept).`);
            continue;
          }
          if (!isValidParticipantCode(original.participantCode)) {
            // It could never be exported or uploaded de-identified, and it is not a study participant's data.
            warnings.push(`Session ${index + 1} was skipped: its participant code is not a pseudonymous study code.`);
            continue;
          }
          let session = original;
          if (session.status === 'recording') {
            // A session cannot be "in progress" on this device; close it at its last data point.
            session = { ...session, status: 'completed', endedAt: session.endedAt ?? sessionEnd(session) };
            warnings.push(`Session ${index + 1} was still recording when exported and was imported as completed.`);
          }
          try {
            await repo.saveSession(session);
            known.add(session.id);
            imported += 1;
          } catch {
            warnings.push(`Session ${index + 1} could not be saved.`);
            continue;
          }
          try {
            await repo.saveSummary(session.id, summarizeSession(session));
          } catch {
            warnings.push(`Session ${index + 1} was imported but could not be summarised.`);
          }
        }
        await get().refresh();
        return { imported, warnings };
      },
    };
  });
}

export const useSessions = createSessionsStore({ repository: defaultRepository, activeSessionId });
