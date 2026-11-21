/// <reference types="jest" />
/**
 * Insights: demo/simulator sessions are never presented as the participant's
 * own (UX-4), and core `generateInsights` gets the sessions' events so the
 * "rises after complications/interruptions" observation can appear (UX-11).
 */
import { fireEvent, render, screen } from '@testing-library/react-native';

import { simulateCohort, summarizeSession } from '@surgeonpulse/core';
import type { SessionEvent, SessionSummary, SurgicalSession } from '@surgeonpulse/core';

import InsightsScreen from '@/app/(tabs)/insights';
import { isPracticeSession, splitInsightSources } from '@/hooks/useSummaries';
import type { SessionListItem } from '@/services/storage/types';
import { useSessions } from '@/state/sessions';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('expo-router', () => require('@/components/__testutils__/expoRouterMock').expoRouterMock());
jest.mock('@/state/sessions', () => ({ useSessions: require('@/components/__testutils__/mockStores').makeSessionsStore() }));

const START = Date.UTC(2026, 0, 5, 8, 0);

function item(session: SurgicalSession, summary: SessionSummary = summarizeSession(session)): SessionListItem {
  const { samples, rr, ...meta } = session;
  return { meta, summary, sampleCount: samples.length + rr.length * 0 };
}

/** `n` completed sessions recorded with a chest strap (the participant's own) or as demo data. */
function sessions(n: number, kind: 'own' | 'demo', seed = 7): SurgicalSession[] {
  const cohort = simulateCohort({ seed, participants: 1, sessionsPerParticipant: n, start: START, spacingDays: 3 });
  return cohort.sessions.map((s, i) => ({
    ...s,
    id: `${kind}-${i}`,
    participantCode: 'SP-014',
    status: 'completed' as const,
    sensor: kind === 'own' ? { source: 'ble' as const, name: 'Polar H10' } : s.sensor,
    tags: kind === 'demo' ? ['demo'] : [],
  }));
}

/**
 * Marks a complication at the start of every heart-rate episode (and links it in the summary), so that the
 * core "episodes after markers" rule has evidence in the sessions' events.
 */
function withComplicationsAtEpisodes(list: SurgicalSession[]): SessionListItem[] {
  return list.map((s) => {
    const summary = summarizeSession(s);
    const events: SessionEvent[] = [...s.events];
    const episodes = summary.episodes.map((ep, k) => {
      const id = `${s.id}-cx-${k}`;
      events.push({ id, type: 'marker', marker: 'complication', t: ep.start, loggedBy: 'team' });
      return { ...ep, relatedEventIds: [...ep.relatedEventIds, id] };
    });
    return item({ ...s, events }, { ...summary, episodes });
  });
}

beforeEach(() => {
  useSessions.setState({ items: [], loading: false });
});

describe('Insights screen', () => {
  it('demo-only data is labelled as demo, never as "your" sessions', async () => {
    useSessions.setState({ items: sessions(6, 'demo').map((s) => item(s)) });
    await render(<InsightsScreen />);
    expect(screen.getByTestId('insights-intro')).toHaveTextContent(/^Patterns across 6 simulated sessions \(demo data and simulator recordings\)\./);
    expect(screen.getByTestId('insights-intro')).not.toHaveTextContent(/your 6/);
    expect(screen.getByText('Simulated data — not your cases')).toBeOnTheScreen();
    // Points at the action that deletes only the demo sessions (not "Delete all data").
    expect(screen.getByTestId('insights-demo-banner')).toHaveTextContent(/To delete the demo sessions, use Settings › Remove demo data\./);
  });

  it('simulator recordings alone are not pointed at "Remove demo data" (it only removes demo sessions)', async () => {
    const simulator = sessions(4, 'own', 5).map((s) => item({ ...s, sensor: { source: 'simulated' as const, name: 'Simulator' } }));
    useSessions.setState({ items: simulator });
    await render(<InsightsScreen />);
    expect(screen.getByText('Simulated data — not your cases')).toBeOnTheScreen();
    expect(screen.getByTestId('insights-demo-banner')).not.toHaveTextContent(/Remove demo data/);
  });

  it('own cases exclude demo and simulator sessions; demo is a separate view', async () => {
    const simulatorCase = { ...sessions(1, 'own', 11)[0]!, id: 'sim-1', sensor: { source: 'simulated' as const, name: 'Simulator' } };
    useSessions.setState({
      items: [...sessions(2, 'own').map((s) => item(s)), item(simulatorCase), ...sessions(5, 'demo').map((s) => item(s))],
    });
    await render(<InsightsScreen />);
    expect(screen.getByTestId('insights-intro')).toHaveTextContent(/^Patterns across your 2 completed sessions\./);
    expect(screen.queryByText('Simulated data — not your cases')).toBeNull();

    await fireEvent.press(screen.getByRole('radio', { name: 'Demo and simulator sessions, 6' }));
    expect(screen.getByTestId('insights-intro')).toHaveTextContent(/^Patterns across 6 simulated sessions \(demo data and simulator recordings\)\./);
    expect(screen.getByText('Simulated data — not your cases')).toBeOnTheScreen();
  });

  it('shows the "rises after unexpected events" observation using the sessions\' events', async () => {
    useSessions.setState({ items: withComplicationsAtEpisodes(sessions(8, 'own', 3)) });
    await render(<InsightsScreen />);
    expect(screen.getByTestId('insight-episodes-after-markers')).toBeOnTheScreen();
  });
});

describe('insight sources', () => {
  it('isPracticeSession: demo tag, simulated tag or simulator source', () => {
    expect(isPracticeSession({ tags: ['demo'], sensor: { source: 'ble' } })).toBe(true);
    expect(isPracticeSession({ tags: ['simulated'], sensor: { source: 'ble' } })).toBe(true);
    expect(isPracticeSession({ tags: [], sensor: { source: 'simulated' } })).toBe(true);
    expect(isPracticeSession({ tags: ['uploaded:2026-01-01'], sensor: { source: 'healthkit' } })).toBe(false);
  });

  it('splitInsightSources keeps completed sessions with summaries, oldest first, with their events', () => {
    const own = sessions(3, 'own');
    const recording = { ...own[2]!, id: 'rec', status: 'recording' as const };
    const items = [item(own[1]!), item(own[0]!), { ...item(recording), summary: null }];
    const { own: mine, practice } = splitInsightSources(items);
    expect(mine.summaries.map((s) => s.sessionId)).toEqual(['own-0', 'own-1']);
    expect(mine.sessions.map((s) => s.id)).toEqual(['own-0', 'own-1']);
    expect(mine.sessions[0]?.events).toEqual(own[0]?.events);
    expect(practice.summaries).toEqual([]);
  });
});
