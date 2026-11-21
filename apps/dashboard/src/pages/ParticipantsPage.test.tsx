import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { makeSession, withId } from '../test/fixtures';
import type { Scheduler } from '../lib/chunked';
import { dashboardReducer, initialState } from '../state/reducer';
import { DashboardProvider } from '../state/store';
import { ParticipantsPage } from './ParticipantsPage';

const syncScheduler: Scheduler = (cb) => {
  cb();
  return () => {};
};

afterEach(cleanup);

// RV-23: a sortable "Median Δ HR" column let a supervisor rank surgeons by physiological response.
describe('Participants page', () => {
  it('does not offer ranking participants by heart-rate response and says why', () => {
    const sessions = [1, 2, 3].map((i) => withId(makeSession({ seed: i, participantCode: `SP-00${i}`, dayOffset: i }), `s-${i}`));
    const state = dashboardReducer(initialState, {
      type: 'data/loaded',
      data: { sessions, participants: [], source: { kind: 'file', label: 'test', warnings: [], loadedAt: 0, deidentified: false } },
    });
    render(
      <DashboardProvider initial={state} scheduler={syncScheduler}>
        <ParticipantsPage />
      </DashboardProvider>,
    );
    const table = screen.getByTestId('participants-table');
    const header = within(table).getByRole('columnheader', { name: /Median Δ HR/ });
    expect(header.getAttribute('aria-sort')).toBeNull();
    expect(within(header).queryByRole('button')).toBeNull();
    // other columns stay sortable
    expect(within(within(table).getByRole('columnheader', { name: /Sessions/ })).getByRole('button')).toBeTruthy();
    expect(screen.getByText(/not for comparing or ranking surgeons/)).toBeTruthy();
  });
});
