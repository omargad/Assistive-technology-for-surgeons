/**
 * Loads one session (with signals) for the detail and event-editor screens and
 * computes its summary with core `summarizeSession`. The summary is computed
 * fresh on every load (so retrospective edits are always reflected) and cached
 * through the repository when the list does not have one yet.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { summarizeSession } from '@surgeonpulse/core';
import type { ParticipantProfile, SessionSummary, SurgicalSession } from '@surgeonpulse/core';

import { repository } from '@/services/storage';
import { useSessions } from '@/state/sessions';

export interface SessionDetail {
  session: SurgicalSession | null;
  summary: SessionSummary | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/** Summary options derived from the participant profile. */
export function summaryOptions(profile: ParticipantProfile | null | undefined): { maxHr?: number } {
  return typeof profile?.maxHr === 'number' ? { maxHr: profile.maxHr } : {};
}

export function useSessionDetail(id: string | undefined): SessionDetail {
  const [session, setSession] = useState<SurgicalSession | null>(null);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const reload = useCallback(async () => {
    const req = ++requestId.current;
    if (!id) {
      setSession(null);
      setSummary(null);
      setLoading(false);
      setError('No session selected.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const loaded = await repository.getSession(id);
      if (req !== requestId.current) return;
      if (!loaded) {
        setSession(null);
        setSummary(null);
        setError('This session could not be found. It may have been deleted.');
        return;
      }
      const { profile, items } = useSessions.getState();
      const computed = summarizeSession(loaded, summaryOptions(profile));
      setSession(loaded);
      setSummary(computed);
      const cached = items.find((i) => i.meta.id === id)?.summary ?? null;
      if (loaded.status === 'completed' && cached == null) {
        // Fire-and-forget cache so History / Insights pick it up.
        repository
          .saveSummary(id, computed)
          .then(() => useSessions.getState().refresh())
          .catch(() => undefined);
      }
    } catch (e) {
      if (req !== requestId.current) return;
      setError(e instanceof Error ? e.message : 'Could not load this session.');
    } finally {
      if (req === requestId.current) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { session, summary, loading, error, reload };
}
