/**
 * React contexts for the dashboard state. The provider lives in `store.tsx`
 * and the hooks that read these contexts in `hooks.ts`.
 */
import { createContext } from 'react';
import type { Dispatch } from 'react';
import type { SessionSummary } from '@surgeonpulse/core';
import type { FilterOptions, SessionFacets } from './filters';
import type { DashboardAction, DashboardState } from './reducer';

/** Data derived from the state, computed once per change in the provider. */
export interface DerivedData {
  /** All sessions' facets, chronological. */
  facets: SessionFacets[];
  facetById: ReadonlyMap<string, SessionFacets>;
  /** Facets passing the global filters. */
  filteredFacets: SessionFacets[];
  /** Computed summaries for all sessions, chronological. */
  summaries: SessionSummary[];
  /** Computed summaries for the filtered sessions, chronological. */
  filteredSummaries: SessionSummary[];
  options: FilterOptions;
  progress: { done: number; total: number };
  /** True while summaries are still being computed. */
  summarizing: boolean;
}

export const StateContext = createContext<DashboardState | null>(null);
export const DispatchContext = createContext<Dispatch<DashboardAction> | null>(null);
export const DerivedContext = createContext<DerivedData | null>(null);
