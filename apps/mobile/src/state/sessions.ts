/**
 * Session list + participant profile store (zustand).
 *
 * Also hosts the data-management actions of the Settings screen: delete,
 * demo data (core simulator, tagged `demo`, never uploaded) and import of
 * export bundles (core `parseImport`).
 */
import { parseImport, sessionEnd, simulateCohort, summarizeSession } from '@surgeonpulse/core';
import type { ParticipantProfile, SurgicalSession } from '@surgeonpulse/core';
import { create } from 'zustand';
import { repository as defaultRepository } from '../services/storage';
import type { SessionRepository } from '../services/storage/types';
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
}

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
        } catch {
          if (seq === refreshSeq) set({ loading: false });
        }
      },

      async saveProfile(profile) {
        await repo.saveProfile(profile);
        set({ profile });
      },

      async deleteSession(id) {
        await repo.deleteSession(id);
        set({ items: get().items.filter((item) => item.meta.id !== id) });
        await get().refresh();
      },

      async deleteAll() {
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
        for (const [index, original] of parsed.bundle.sessions.entries()) {
          let session = original;
          if (session.status === 'recording') {
            // A session cannot be "in progress" on this device; close it at its last data point.
            session = { ...session, status: 'completed', endedAt: session.endedAt ?? sessionEnd(session) };
            warnings.push(`Session ${index + 1} was still recording when exported and was imported as completed.`);
          }
          try {
            await repo.saveSession(session);
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

export const useSessions = createSessionsStore({ repository: defaultRepository });
