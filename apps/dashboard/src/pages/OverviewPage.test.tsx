import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { SurgicalSession } from '@surgeonpulse/core';
import { makeSession, withId } from '../test/fixtures';
import type { Scheduler } from '../lib/chunked';
import { dashboardReducer, initialState } from '../state/reducer';
import { DashboardProvider } from '../state/store';
import { OverviewPage } from './OverviewPage';

const syncScheduler: Scheduler = (cb) => {
  cb();
  return () => {};
};

afterEach(cleanup);

describe('Overview page', () => {
  it('bins and describes workload as the raw (unweighted) TLX score', () => {
    const base = withId(makeSession({ seed: 1 }), 's-1');
    // raw = 100 / 6 ≈ 16.7 (bin 10–19); weighted = 100 × 5 / 15 ≈ 33.3 (bin 30–39)
    const session: SurgicalSession = {
      ...base,
      postOp: {
        workload: {
          instrument: 'surg-tlx',
          ratings: { mental: 100, physical: 0, temporal: 0, complexity: 0, stress: 0, distraction: 0 },
          weights: { mental: 5, physical: 4, temporal: 3, complexity: 2, stress: 1, distraction: 0 },
          completedAt: base.startedAt,
        },
      },
    };
    const state = dashboardReducer(initialState, {
      type: 'data/loaded',
      data: { sessions: [session], participants: [], source: { kind: 'file', label: 'test', warnings: [], loadedAt: 0, deidentified: false } },
    });
    render(
      <DashboardProvider initial={state} scheduler={syncScheduler}>
        <OverviewPage />
      </DashboardProvider>,
    );
    const chart = screen.getByTestId('workload-chart');
    expect(within(chart).getByText('Raw (unweighted) SURG-TLX / NASA-TLX scores, 1 session.')).toBeTruthy();
    expect(chart.textContent).not.toMatch(/weighted where available/);
    const summary = within(chart).getByRole('img').getAttribute('aria-label') ?? '';
    expect(summary).toContain('10–19: 1');
    expect(summary).not.toContain('30–39');
  });
});
