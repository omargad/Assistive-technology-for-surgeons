import { useMemo } from 'react';

import type { SessionSummary, SurgicalSession } from '@surgeonpulse/core';

import type { SessionListItem, SessionMeta } from '@/services/storage/types';
import { useSessions } from '@/state/sessions';

/**
 * Demo data (`demo` tag) or a case recorded with the simulator (`sensor.source: 'simulated'` or a `simulated` tag).
 * These are never part of a participant's own feedback, exports or uploads.
 */
export function isPracticeSession(meta: Pick<SessionMeta, 'tags' | 'sensor'>): boolean {
  const tags = meta.tags ?? [];
  return tags.includes('demo') || tags.includes('simulated') || meta.sensor?.source === 'simulated';
}

/** Input for trends and core `generateInsights` (summaries plus their sessions' events). */
export interface InsightData {
  /** Cached summaries of completed sessions, oldest first. */
  summaries: SessionSummary[];
  /**
   * The same sessions without signals (metadata and events only) for `generateInsights(summaries, { sessions })`;
   * the "rises after complications/interruptions" observation needs the events' marker kinds.
   */
  sessions: SurgicalSession[];
}

export interface InsightSources {
  /** The participant's own recorded cases. */
  own: InsightData;
  /** Demo and simulator sessions, kept apart so they are never presented as the participant's own. */
  practice: InsightData;
}

function toData(items: readonly SessionListItem[]): InsightData {
  const done = items
    .filter((i) => i.meta.status === 'completed' && i.summary != null)
    .sort((a, b) => (a.summary as SessionSummary).startedAt - (b.summary as SessionSummary).startedAt);
  return {
    summaries: done.map((i) => i.summary as SessionSummary),
    sessions: done.map((i) => ({ ...i.meta, samples: [], rr: [] })),
  };
}

/** Completed sessions split into the participant's own cases and demo/simulator practice sessions. */
export function splitInsightSources(items: readonly SessionListItem[]): InsightSources {
  const own: SessionListItem[] = [];
  const practice: SessionListItem[] = [];
  for (const item of items) (isPracticeSession(item.meta) ? practice : own).push(item);
  return { own: toData(own), practice: toData(practice) };
}

export function useInsightSources(): InsightSources {
  const items = useSessions((s) => s.items);
  return useMemo(() => splitInsightSources(items), [items]);
}

/** Cached summaries of the participant's own completed sessions (no demo/simulator data), oldest first. */
export function useSummaries(): SessionSummary[] {
  return useInsightSources().own.summaries;
}
