import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { makeSession, withId } from '../test/fixtures';
import { ParticipantDetailPage } from '../pages/ParticipantDetailPage';
import { SessionsPage } from '../pages/SessionsPage';
import type { Scheduler } from '../lib/chunked';
import { dashboardReducer, initialState } from './reducer';
import type { DashboardState } from './reducer';
import { useDerived } from './hooks';
import { DashboardProvider } from './store';

/** Runs scheduled work immediately so summaries are computed synchronously in tests. */
const syncScheduler: Scheduler = (cb) => {
  cb();
  return () => {};
};

/** Collects scheduled slices so a test can step through them. */
function steppedScheduler() {
  const queue: (() => void)[] = [];
  const schedule: Scheduler = (cb) => {
    queue.push(cb);
    return () => {
      const i = queue.indexOf(cb);
      if (i >= 0) queue.splice(i, 1);
    };
  };
  return { schedule, step: () => queue.shift()?.(), get size() { return queue.length; } };
}

function stateWith(sessions: ReturnType<typeof makeSession>[]): DashboardState {
  return dashboardReducer(initialState, {
    type: 'data/loaded',
    data: {
      sessions,
      participants: [],
      source: { kind: 'file', label: 'test', warnings: [], loadedAt: 0, deidentified: false },
    },
  });
}

const own = [1, 2, 3, 4, 5, 6].map((i) =>
  withId(makeSession({ seed: i, participantCode: 'SP-001', dayOffset: i * 7 }), `own-${i}`),
);
const others = [7, 8, 9].map((i) =>
  withId(makeSession({ seed: i, participantCode: `SP-00${i}`, dayOffset: i }), `other-${i}`),
);

function Progress() {
  const { progress, summarizing } = useDerived();
  return (
    <p data-testid="progress">
      {progress.done}/{progress.total} {summarizing ? 'busy' : 'done'}
    </p>
  );
}

describe('DashboardProvider', () => {
  it('computes summaries progressively, one time-boxed slice at a time', () => {
    const sched = steppedScheduler();
    render(
      <DashboardProvider initial={stateWith([...own, ...others])} scheduler={sched.schedule}>
        <Progress />
      </DashboardProvider>,
    );
    expect(screen.getByTestId('progress').textContent).toBe('0/9 busy');
    let guard = 0;
    while (sched.size > 0 && guard++ < 100) act(() => sched.step());
    expect(screen.getByTestId('progress').textContent).toBe('9/9 done');
  });

  it('lists sessions in the sessions table once summarised', () => {
    window.location.hash = '#/sessions';
    render(
      <DashboardProvider initial={stateWith([...own.slice(0, 2), ...others.slice(0, 1)])} scheduler={syncScheduler}>
        <SessionsPage />
      </DashboardProvider>,
    );
    const table = screen.getByTestId('sessions-table');
    expect(table.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(table.textContent).toContain('SP-007');
    expect(table.textContent).not.toContain('…');
  });
});

describe('participant feedback view', () => {
  it('never shows other participants’ codes', () => {
    render(
      <DashboardProvider initial={stateWith([...own, ...others])} scheduler={syncScheduler}>
        <ParticipantDetailPage code="SP-001" />
      </DashboardProvider>,
    );
    const text = document.body.textContent ?? '';
    expect(text).toContain('SP-001');
    expect(text).toContain('Cohort median');
    for (const s of others) expect(text).not.toContain(s.participantCode);
    // Links only point at the participant's own sessions.
    const hrefs = [...document.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    for (const s of others) expect(hrefs.some((h) => h.includes(s.id))).toBe(false);
  });

  it('hides the cohort comparison when too few other participants are loaded (PRIV-6)', () => {
    render(
      <DashboardProvider initial={stateWith([...own, others[0]!])} scheduler={syncScheduler}>
        <ParticipantDetailPage code="SP-001" />
      </DashboardProvider>,
    );
    const text = document.body.textContent ?? '';
    expect(text).toContain('Too few other participants');
    // The accessible summary lists every phase as "yours vs —": no cohort number to invert.
    const label = document.querySelector('[data-testid="phase-profile"] [role="img"]')?.getAttribute('aria-label') ?? '';
    const pairs = [...label.matchAll(/ vs (\S+) bpm/g)].map((m) => m[1]);
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.every((v) => v === '—')).toBe(true);
  });

  it('shows an empty state for unknown participants', () => {
    render(
      <DashboardProvider initial={stateWith(own.slice(0, 1))} scheduler={syncScheduler}>
        <ParticipantDetailPage code="SP-404" />
      </DashboardProvider>,
    );
    expect(screen.getByText('No sessions for this participant')).toBeTruthy();
  });
});
