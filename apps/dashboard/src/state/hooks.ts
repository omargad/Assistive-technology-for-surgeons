/**
 * Hooks for reading dashboard state and running data-loading actions.
 */
import { useCallback, useContext, useMemo } from 'react';
import type { Dispatch } from 'react';
import { simulateCohort } from '@surgeonpulse/core';
import { importFiles } from '../lib/files';
import type { ReadableFile } from '../lib/files';
import { fetchExportBundle, normaliseServerUrl, ServerError } from '../lib/serverClient';
import type { ServerConnection } from '../lib/serverClient';
import { DerivedContext, DispatchContext, StateContext } from './context';
import type { DerivedData } from './context';
import type { SessionFilters } from './filters';
import type { DashboardAction, DashboardState } from './reducer';

/** The raw dashboard state. */
export function useDashboardState(): DashboardState {
  const ctx = useContext(StateContext);
  if (ctx === null) throw new Error('useDashboardState must be used inside <DashboardProvider>');
  return ctx;
}

/** The reducer's dispatch. */
export function useDashboardDispatch(): Dispatch<DashboardAction> {
  const ctx = useContext(DispatchContext);
  if (ctx === null) throw new Error('useDashboardDispatch must be used inside <DashboardProvider>');
  return ctx;
}

/** Derived, memoised data (facets, filtered summaries, progress). */
export function useDerived(): DerivedData {
  const ctx = useContext(DerivedContext);
  if (ctx === null) throw new Error('useDerived must be used inside <DashboardProvider>');
  return ctx;
}

/** Global filters and setters. */
export function useFilters(): {
  filters: SessionFilters;
  setFilters: (patch: Partial<SessionFilters>) => void;
  resetFilters: () => void;
} {
  const { filters } = useDashboardState();
  const dispatch = useDashboardDispatch();
  const setFilters = useCallback((patch: Partial<SessionFilters>) => dispatch({ type: 'filters/changed', patch }), [dispatch]);
  const resetFilters = useCallback(() => dispatch({ type: 'filters/reset' }), [dispatch]);
  return { filters, setFilters, resetFilters };
}

/** Let the browser paint (e.g. a "Generating…" state) before blocking work. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

/** Data-loading actions used by the Data page and empty states. */
export interface DataActions {
  loadDemo: (seed: number) => Promise<boolean>;
  loadFiles: (files: readonly ReadableFile[]) => Promise<boolean>;
  loadServer: (conn: ServerConnection) => Promise<boolean>;
  clearAll: () => void;
  dismissError: () => void;
}

export function useDataActions(): DataActions {
  const dispatch = useDashboardDispatch();

  const loadDemo = useCallback(
    async (seed: number) => {
      const safeSeed = Number.isFinite(seed) ? Math.trunc(seed) : 1;
      dispatch({ type: 'load/started', busy: { kind: 'demo', message: 'Generating simulated cohort…' } });
      await nextFrame();
      try {
        const cohort = simulateCohort({ seed: safeSeed });
        dispatch({
          type: 'data/loaded',
          data: {
            sessions: cohort.sessions,
            participants: cohort.participants,
            source: {
              kind: 'demo',
              label: `Simulated cohort (seed ${safeSeed})`,
              warnings: [],
              loadedAt: Date.now(),
              deidentified: false,
              seed: safeSeed,
            },
          },
        });
        return true;
      } catch (err) {
        dispatch({ type: 'load/failed', error: `The demo cohort could not be generated: ${errorText(err)}` });
        return false;
      }
    },
    [dispatch],
  );

  const loadFiles = useCallback(
    async (files: readonly ReadableFile[]) => {
      if (files.length === 0) return false;
      dispatch({
        type: 'load/started',
        busy: { kind: 'file', message: `Reading ${files.length === 1 ? files[0]!.name : `${files.length} files`}…` },
      });
      await nextFrame();
      try {
        const result = await importFiles(files);
        if (result.sessions.length === 0) {
          const reasons = result.warnings.slice(0, 3).join(' ');
          dispatch({ type: 'load/failed', error: `No sessions could be imported. ${reasons}`.trim() });
          return false;
        }
        dispatch({
          type: 'data/loaded',
          data: {
            sessions: result.sessions,
            participants: result.participants,
            source: {
              kind: 'file',
              label: result.loadedFiles.join(', '),
              warnings: result.warnings,
              loadedAt: Date.now(),
              deidentified: result.deidentified,
            },
          },
        });
        return true;
      } catch (err) {
        dispatch({ type: 'load/failed', error: `The files could not be read: ${errorText(err)}` });
        return false;
      }
    },
    [dispatch],
  );

  const loadServer = useCallback(
    async (conn: ServerConnection) => {
      let host = conn.url;
      try {
        host = new URL(normaliseServerUrl(conn.url)).host;
      } catch {
        // reported by fetchExportBundle below
      }
      dispatch({ type: 'load/started', busy: { kind: 'server', message: `Downloading from ${host}…` } });
      try {
        const { bundle, warnings } = await fetchExportBundle(conn);
        if (bundle.sessions.length === 0) {
          dispatch({ type: 'load/failed', error: 'Connected, but the server has no sessions yet.' });
          return false;
        }
        dispatch({
          type: 'data/loaded',
          data: {
            sessions: bundle.sessions,
            participants: bundle.participants,
            source: {
              kind: 'server',
              label: `Research server ${host}`,
              warnings,
              loadedAt: Date.now(),
              deidentified: bundle.deidentified,
            },
          },
        });
        return true;
      } catch (err) {
        dispatch({
          type: 'load/failed',
          error: err instanceof ServerError ? err.message : `Unexpected error: ${errorText(err)}`,
        });
        return false;
      }
    },
    [dispatch],
  );

  const clearAll = useCallback(() => dispatch({ type: 'data/cleared' }), [dispatch]);
  const dismissError = useCallback(() => dispatch({ type: 'error/dismissed' }), [dispatch]);

  return useMemo(
    () => ({ loadDemo, loadFiles, loadServer, clearAll, dismissError }),
    [loadDemo, loadFiles, loadServer, clearAll, dismissError],
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
