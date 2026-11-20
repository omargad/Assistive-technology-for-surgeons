import { describe, expect, it } from 'vitest';
import { summarizeSession } from '@surgeonpulse/core';
import { makeSession, withId } from '../test/fixtures';
import { EMPTY_FILTERS } from './filters';
import { dashboardReducer, initialState, pendingSummaryIds, summaryProgress } from './reducer';
import type { DashboardState, LoadedData } from './reducer';

function loaded(kind: 'file' | 'demo' | 'server', sessions: LoadedData['sessions'], participants: LoadedData['participants'] = []): LoadedData {
  return {
    sessions,
    participants,
    source: { kind, label: kind, warnings: [], loadedAt: 0, deidentified: false },
  };
}

function load(state: DashboardState, data: LoadedData): DashboardState {
  return dashboardReducer(state, { type: 'data/loaded', data });
}

describe('dashboardReducer', () => {
  const a = withId(makeSession({ seed: 1, participantCode: 'SP-001', dayOffset: 2 }), 'a');
  const b = withId(makeSession({ seed: 2, participantCode: 'SP-002', dayOffset: 1 }), 'b');

  it('loads sessions in chronological order and synthesises missing participant profiles', () => {
    const s = load(initialState, loaded('file', [a, b]));
    expect(s.order).toEqual(['b', 'a']);
    expect([...s.participants.keys()].sort()).toEqual(['SP-001', 'SP-002']);
    expect(s.sources).toHaveLength(1);
    expect(s.sources[0]).toMatchObject({ kind: 'file', sessionCount: 2, participantCount: 2, id: 1 });
    expect(s.revision).toBe(1);
    expect(pendingSummaryIds(s)).toEqual(['b', 'a']);
    expect(summaryProgress(s)).toEqual({ done: 0, total: 2 });
  });

  it('merges file loads by session id, later wins, and invalidates the replaced summary only', () => {
    let s = load(initialState, loaded('file', [a, b]));
    s = dashboardReducer(s, {
      type: 'summaries/computed',
      results: [
        { id: 'a', session: a, summary: summarizeSession(a) },
        { id: 'b', session: b, summary: summarizeSession(b) },
      ],
    });
    expect(s.summaries.size).toBe(2);

    const a2 = { ...a, procedure: { ...a.procedure, name: 'Updated name' } };
    s = load(s, loaded('file', [a2]));
    expect(s.sessions.get('a')).toBe(a2);
    expect(s.summaries.has('a')).toBe(false);
    expect(s.summaries.has('b')).toBe(true);
    expect(s.sources).toHaveLength(2);
    expect(pendingSummaryIds(s)).toEqual(['a']);
  });

  it('keeps richer participant profiles when a later file only has the code', () => {
    let s = load(initialState, loaded('file', [a], [{ code: 'SP-001', trainingLevel: 'registrar', restingHr: 60 }]));
    s = load(s, loaded('file', [a], [{ code: 'SP-001' }]));
    expect(s.participants.get('SP-001')).toEqual({ code: 'SP-001', trainingLevel: 'registrar', restingHr: 60 });
  });

  it('never mixes simulated demo data with real data', () => {
    let s = load(initialState, loaded('file', [a]));
    s = load(s, loaded('demo', [b]));
    expect(s.simulated).toBe(true);
    expect(s.order).toEqual(['b']);
    expect(s.sources.map((x) => x.kind)).toEqual(['demo']);

    s = load(s, loaded('file', [a]));
    expect(s.simulated).toBe(false);
    expect(s.order).toEqual(['a']);
    expect(s.sources.map((x) => x.kind)).toEqual(['file']);
  });

  it('resets filters when data is replaced but keeps them on merge', () => {
    let s = load(initialState, loaded('file', [a]));
    s = dashboardReducer(s, { type: 'filters/changed', patch: { participant: 'SP-001' } });
    s = load(s, loaded('file', [b]));
    expect(s.filters.participant).toBe('SP-001');
    s = load(s, loaded('demo', [b]));
    expect(s.filters).toEqual(EMPTY_FILTERS);
  });

  it('discards stale summary results for sessions that were replaced or cleared', () => {
    let s = load(initialState, loaded('file', [a]));
    const stale = summarizeSession(a);
    const a2 = { ...a };
    s = load(s, loaded('file', [a2]));
    const after = dashboardReducer(s, { type: 'summaries/computed', results: [{ id: 'a', session: a, summary: stale }] });
    expect(after).toBe(s);
    expect(after.summaries.size).toBe(0);
  });

  it('records summary errors and counts them as done', () => {
    let s = load(initialState, loaded('file', [a, b]));
    s = dashboardReducer(s, { type: 'summaries/computed', results: [{ id: 'a', session: a, error: 'boom' }] });
    expect(s.summaryErrors.get('a')).toBe('boom');
    expect(summaryProgress(s)).toEqual({ done: 1, total: 2 });
    expect(pendingSummaryIds(s)).toEqual(['b']);
  });

  it('tracks busy and error state for loads', () => {
    let s = dashboardReducer(initialState, { type: 'load/started', busy: { kind: 'server', message: 'Downloading' } });
    expect(s.busy?.kind).toBe('server');
    s = dashboardReducer(s, { type: 'load/failed', error: 'Nope' });
    expect(s.busy).toBeNull();
    expect(s.error).toBe('Nope');
    s = dashboardReducer(s, { type: 'error/dismissed' });
    expect(s.error).toBeNull();
  });

  it('clears all data but keeps counters monotonic', () => {
    let s = load(initialState, loaded('file', [a, b]));
    s = dashboardReducer(s, { type: 'filters/changed', patch: { search: 'chole' } });
    const cleared = dashboardReducer(s, { type: 'data/cleared' });
    expect(cleared.sessions.size).toBe(0);
    expect(cleared.order).toEqual([]);
    expect(cleared.sources).toEqual([]);
    expect(cleared.filters).toEqual(EMPTY_FILTERS);
    expect(cleared.revision).toBe(s.revision + 1);
    expect(cleared.nextSourceId).toBe(s.nextSourceId);
  });

  it('applies and resets filter patches', () => {
    let s = dashboardReducer(initialState, { type: 'filters/changed', patch: { specialty: 'Urology', from: '2026-01-01' } });
    expect(s.filters).toMatchObject({ specialty: 'Urology', from: '2026-01-01', participant: '' });
    s = dashboardReducer(s, { type: 'filters/reset' });
    expect(s.filters).toEqual(EMPTY_FILTERS);
  });
});
