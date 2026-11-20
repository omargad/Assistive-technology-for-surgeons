import { useMemo } from 'react';

import type { SessionSummary } from '@surgeonpulse/core';

import { useSessions } from '@/state/sessions';

/** Cached summaries of completed sessions, oldest first (input for trends & insights). */
export function useSummaries(): SessionSummary[] {
  const items = useSessions((s) => s.items);
  return useMemo(
    () =>
      items
        .filter((i) => i.meta.status === 'completed' && i.summary != null)
        .map((i) => i.summary as SessionSummary)
        .sort((a, b) => a.startedAt - b.startedAt),
    [items],
  );
}
