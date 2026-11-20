/**
 * Dashboard state and reducer.
 *
 * Sessions are keyed by id. Summaries are memoised by session id: each one is
 * computed once (progressively, see `store.tsx`) and is dropped only when its
 * session is replaced by a newer copy or the data is cleared.
 */
import type { ParticipantProfile, SessionSummary, SurgicalSession } from '@surgeonpulse/core';
import { EMPTY_FILTERS } from './filters';
import type { SessionFilters } from './filters';
import { mergeParticipants } from './merge';

/** Where a batch of data came from. */
export type SourceKind = 'file' | 'demo' | 'server';

/** One loaded data source, listed on the Data page. */
export interface SourceInfo {
  id: number;
  kind: SourceKind;
  /** e.g. file names, "Simulated cohort (seed 1)", server host. */
  label: string;
  sessionCount: number;
  participantCount: number;
  warnings: string[];
  loadedAt: number;
  deidentified: boolean;
  /** Seed of a simulated cohort. */
  seed?: number;
}

/** A long-running load in progress. */
export interface BusyState {
  kind: SourceKind;
  message: string;
}

export interface DashboardState {
  sessions: ReadonlyMap<string, SurgicalSession>;
  /** Session ids in chronological order (start time, then id). */
  order: readonly string[];
  participants: ReadonlyMap<string, ParticipantProfile>;
  summaries: ReadonlyMap<string, SessionSummary>;
  /** Sessions whose summary could not be computed, with the reason. */
  summaryErrors: ReadonlyMap<string, string>;
  filters: SessionFilters;
  sources: readonly SourceInfo[];
  /** True while the loaded data is the simulated demo cohort. */
  simulated: boolean;
  busy: BusyState | null;
  /** Last load error (user-facing message). */
  error: string | null;
  /** Incremented whenever the set of sessions changes. */
  revision: number;
  nextSourceId: number;
}

export const initialState: DashboardState = {
  sessions: new Map(),
  order: [],
  participants: new Map(),
  summaries: new Map(),
  summaryErrors: new Map(),
  filters: { ...EMPTY_FILTERS },
  sources: [],
  simulated: false,
  busy: null,
  error: null,
  revision: 0,
  nextSourceId: 1,
};

/** Payload of a completed load. */
export interface LoadedData {
  sessions: readonly SurgicalSession[];
  participants: readonly ParticipantProfile[];
  source: Omit<SourceInfo, 'id' | 'sessionCount' | 'participantCount'>;
}

/** One computed summary (or failure) for the session object it was computed from. */
export interface SummaryResult {
  id: string;
  /** The exact session object summarised; stale results are discarded. */
  session: SurgicalSession;
  summary?: SessionSummary;
  error?: string;
}

export type DashboardAction =
  | { type: 'load/started'; busy: BusyState }
  | { type: 'load/failed'; error: string }
  | { type: 'data/loaded'; data: LoadedData }
  | { type: 'data/cleared' }
  | { type: 'summaries/computed'; results: readonly SummaryResult[] }
  | { type: 'filters/changed'; patch: Partial<SessionFilters> }
  | { type: 'filters/reset' }
  | { type: 'error/dismissed' };

/** Chronological order of session ids (stable, platform-independent). */
export function chronologicalOrder(sessions: ReadonlyMap<string, SurgicalSession>): string[] {
  return [...sessions.values()]
    .sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((s) => s.id);
}

function loadData(state: DashboardState, data: LoadedData): DashboardState {
  // Simulated data is never mixed with real data: loading the demo replaces
  // everything, and loading real data replaces a loaded demo.
  const replace = data.source.kind === 'demo' || state.simulated;
  const sessions = new Map(replace ? [] : state.sessions);
  const summaries = new Map(replace ? [] : state.summaries);
  const summaryErrors = new Map(replace ? [] : state.summaryErrors);

  for (const s of data.sessions) {
    if (sessions.get(s.id) !== s) {
      summaries.delete(s.id);
      summaryErrors.delete(s.id);
    }
    sessions.set(s.id, s);
  }

  const baseParticipants = replace ? [] : [...state.participants.values()];
  const merged = mergeParticipants(baseParticipants, data.participants);
  // Make sure every session code has at least a minimal profile.
  const known = new Set(merged.map((p) => p.code));
  for (const s of sessions.values()) {
    if (!known.has(s.participantCode)) {
      known.add(s.participantCode);
      merged.push({ code: s.participantCode });
    }
  }

  const codes = new Set(data.sessions.map((s) => s.participantCode));
  const source: SourceInfo = {
    ...data.source,
    id: state.nextSourceId,
    sessionCount: data.sessions.length,
    participantCount: codes.size,
  };

  return {
    ...state,
    sessions,
    order: chronologicalOrder(sessions),
    participants: new Map(merged.map((p) => [p.code, p])),
    summaries,
    summaryErrors,
    filters: replace ? { ...EMPTY_FILTERS } : state.filters,
    sources: replace ? [source] : [...state.sources, source],
    simulated: data.source.kind === 'demo',
    busy: null,
    error: null,
    revision: state.revision + 1,
    nextSourceId: state.nextSourceId + 1,
  };
}

function applySummaries(state: DashboardState, results: readonly SummaryResult[]): DashboardState {
  let summaries: Map<string, SessionSummary> | null = null;
  let errors: Map<string, string> | null = null;
  for (const r of results) {
    if (state.sessions.get(r.id) !== r.session) continue; // stale: session replaced or cleared
    if (r.summary !== undefined) {
      summaries ??= new Map(state.summaries);
      summaries.set(r.id, r.summary);
    } else {
      errors ??= new Map(state.summaryErrors);
      errors.set(r.id, r.error ?? 'Summary could not be computed.');
    }
  }
  if (summaries === null && errors === null) return state;
  return {
    ...state,
    summaries: summaries ?? state.summaries,
    summaryErrors: errors ?? state.summaryErrors,
  };
}

export function dashboardReducer(state: DashboardState, action: DashboardAction): DashboardState {
  switch (action.type) {
    case 'load/started':
      return { ...state, busy: action.busy, error: null };
    case 'load/failed':
      return { ...state, busy: null, error: action.error };
    case 'data/loaded':
      return loadData(state, action.data);
    case 'data/cleared':
      return {
        ...initialState,
        filters: { ...EMPTY_FILTERS },
        revision: state.revision + 1,
        nextSourceId: state.nextSourceId,
      };
    case 'summaries/computed':
      return applySummaries(state, action.results);
    case 'filters/changed':
      return { ...state, filters: { ...state.filters, ...action.patch } };
    case 'filters/reset':
      return { ...state, filters: { ...EMPTY_FILTERS } };
    case 'error/dismissed':
      return { ...state, error: null };
    default:
      return state;
  }
}

/** Ids of sessions that still need a summary, in chronological order. */
export function pendingSummaryIds(state: DashboardState): string[] {
  return state.order.filter((id) => !state.summaries.has(id) && !state.summaryErrors.has(id));
}

/** Progress of summary computation. */
export function summaryProgress(state: DashboardState): { done: number; total: number } {
  return { done: state.summaries.size + state.summaryErrors.size, total: state.order.length };
}
