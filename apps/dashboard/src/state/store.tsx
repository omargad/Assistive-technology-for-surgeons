/**
 * Dashboard state provider.
 *
 * After data loads, session summaries are computed progressively in
 * time-boxed chunks (core `summarizeSession`, memoised by session id), so a
 * cohort of ≈ 100 sessions never blocks the UI; pages render with whatever
 * summaries are ready and show a progress bar meanwhile.
 */
import { useEffect, useMemo, useReducer } from 'react';
import type { ReactNode } from 'react';
import { summarizeSession } from '@surgeonpulse/core';
import type { SessionSummary, SurgicalSession } from '@surgeonpulse/core';
import { runChunked } from '../lib/chunked';
import type { ChunkedOptions, Scheduler } from '../lib/chunked';
import { DerivedContext, DispatchContext, StateContext } from './context';
import type { DerivedData } from './context';
import { applyFilters, filterOptions, sessionFacets } from './filters';
import type { SessionFacets } from './filters';
import { dashboardReducer, initialState, pendingSummaryIds, summaryProgress } from './reducer';
import type { DashboardState, SummaryResult } from './reducer';

function computeSummary(session: SurgicalSession): SummaryResult {
  try {
    return { id: session.id, session, summary: summarizeSession(session) };
  } catch (err) {
    return { id: session.id, session, error: err instanceof Error ? err.message : String(err) };
  }
}

function derive(state: DashboardState): DerivedData {
  const facets: SessionFacets[] = [];
  const summaries: SessionSummary[] = [];
  for (const id of state.order) {
    const s = state.sessions.get(id);
    if (s === undefined) continue;
    facets.push(sessionFacets(s));
    const summary = state.summaries.get(id);
    if (summary !== undefined) summaries.push(summary);
  }
  const filteredFacets = applyFilters(facets, state.filters);
  const filteredIds = new Set(filteredFacets.map((f) => f.id));
  const progress = summaryProgress(state);
  return {
    facets,
    facetById: new Map(facets.map((f) => [f.id, f])),
    filteredFacets,
    summaries,
    filteredSummaries:
      filteredFacets.length === facets.length ? summaries : summaries.filter((s) => filteredIds.has(s.sessionId)),
    options: filterOptions(facets),
    progress,
    summarizing: progress.done < progress.total,
  };
}

export interface DashboardProviderProps {
  children: ReactNode;
  /** Initial state (tests). */
  initial?: DashboardState;
  /** Scheduler for progressive summaries (tests can make it synchronous). */
  scheduler?: Scheduler;
}

/** Provides state, derived data and dispatch to the app. */
export function DashboardProvider({ children, initial, scheduler }: DashboardProviderProps) {
  const [state, dispatch] = useReducer(dashboardReducer, initial ?? initialState);

  // Progressive, memoised summary computation. It (re)starts only when the set
  // of sessions changes (`revision`); already-computed summaries are kept, and
  // results for sessions replaced in the meantime are discarded by the reducer.
  useEffect(() => {
    const pending = pendingSummaryIds(state);
    if (pending.length === 0) return undefined;
    const items = pending.map((id) => state.sessions.get(id)!);
    const opts: ChunkedOptions<SurgicalSession, SummaryResult> = {
      items,
      work: computeSummary,
      onChunk: (results) => dispatch({ type: 'summaries/computed', results }),
    };
    if (scheduler !== undefined) opts.schedule = scheduler;
    return runChunked(opts);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on revision by design
  }, [state.revision, scheduler]);

  const derived = useMemo(() => derive(state), [state]);

  return (
    <DispatchContext.Provider value={dispatch}>
      <StateContext.Provider value={state}>
        <DerivedContext.Provider value={derived}>{children}</DerivedContext.Provider>
      </StateContext.Provider>
    </DispatchContext.Provider>
  );
}
