/// <reference types="jest" />
/**
 * Debrief: SURG-TLX sliders (core wording), live score via core
 * scoreWorkload, optional pairwise weighting, and submission of a PostOpReport.
 */
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Alert, type AlertButton } from 'react-native';
import { router } from 'expo-router';

import { SURG_TLX_DIMENSIONS, tlxPairs } from '@surgeonpulse/core';
import type { PostOpReport } from '@surgeonpulse/core';

import DebriefScreen from '@/app/record/debrief';
import { EMPTY_RATINGS, buildPostOpReport, completeRatings, missingRatings, weightsFromChoices } from '@/components/debriefReport';
import { makeLiveSession } from '@/components/__testutils__/mockStores';
import { useRecording } from '@/state/recording';
import { useSessions } from '@/state/sessions';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('expo-router', () => require('@/components/__testutils__/expoRouterMock').expoRouterMock());
jest.mock('@/state/recording', () => ({ useRecording: require('@/components/__testutils__/mockStores').makeRecordingStore() }));
jest.mock('@/state/settings', () => ({ useSettings: require('@/components/__testutils__/mockStores').makeSettingsStore() }));
jest.mock('@/state/sessions', () => ({ useSessions: require('@/components/__testutils__/mockStores').makeSessionsStore() }));
jest.mock('@/services/health', () => ({
  healthStore: { source: null, label: 'Health', isAvailable: async () => false, requestAccess: async () => false, importRange: jest.fn() },
}));

const NOW = Date.UTC(2026, 2, 2, 10, 0);
const increment = { nativeEvent: { actionName: 'increment' } };
const decrement = { nativeEvent: { actionName: 'decrement' } };

/** Answers every SURG-TLX item: the first step answers at the midpoint (50), then `steps` more steps of 5. */
async function rateAll(steps: Partial<Record<string, number>> = {}) {
  for (const dim of SURG_TLX_DIMENSIONS) {
    const n = steps[dim.id] ?? 0;
    await fireEvent(screen.getByRole('adjustable', { name: dim.label }), 'accessibilityAction', increment);
    for (let i = 0; i < Math.abs(n); i++) {
      await fireEvent(screen.getByRole('adjustable', { name: dim.label }), 'accessibilityAction', n > 0 ? increment : decrement);
    }
  }
}

/** Answers the next native Alert with the button labelled `label`. */
function answerAlertWith(label: string) {
  return jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons?: AlertButton[]) => {
    buttons?.find((b) => b.text === label)?.onPress?.();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  const session = { ...makeLiveSession(NOW, 45), endedAt: NOW };
  useRecording.setState({ stage: 'debrief', session, timedOnly: false });
});

function submittedReport(): PostOpReport {
  const submit = useRecording.getState().submitDebrief as jest.Mock;
  expect(submit).toHaveBeenCalledTimes(1);
  return submit.mock.calls[0]?.[0] as PostOpReport;
}

describe('Debrief screen', () => {
  it('asks every SURG-TLX question using the core wording, starting unanswered', async () => {
    await render(<DebriefScreen />);
    for (const dim of SURG_TLX_DIMENSIONS) {
      expect(screen.getByText(dim.question)).toBeOnTheScreen();
      const slider = screen.getByRole('adjustable', { name: dim.label });
      // UX-2: no default rating (no aria-valuenow, no thumb) until the participant answers.
      expect(slider).toHaveAccessibilityValue({ min: 0, max: 100, text: 'Not rated' });
      expect(slider.props['aria-valuenow']).toBeUndefined();
      expect(screen.queryByTestId(`tlx-${dim.id}-thumb`)).toBeNull();
    }
    expect(screen.getByTestId('debrief-score')).toHaveTextContent('—');
    expect(screen.getByText('Rate all six demands to see the score (0 of 6 rated).')).toBeOnTheScreen();
  });

  it('computes the workload score and submits a PostOpReport with the ratings', async () => {
    await render(<DebriefScreen />);

    // Answer all six (first step = 50); Mental demands → 60, Situational stress → 55.
    await rateAll({ mental: 2, stress: 1 });
    expect(screen.getByTestId('debrief-score')).toHaveTextContent('52.5');

    // Answer two of the "about the case" items.
    await fireEvent(screen.getByRole('adjustable', { name: 'Self-rated performance' }), 'accessibilityAction', increment);
    await fireEvent(screen.getByRole('adjustable', { name: 'Self-rated performance' }), 'accessibilityAction', increment);
    await fireEvent.press(screen.getByRole('radio', { name: 'No' }));

    await fireEvent.press(screen.getByTestId('debrief-submit'));

    const report = submittedReport();
    expect(report.workload).toMatchObject({
      instrument: 'surg-tlx',
      ratings: { mental: 60, physical: 50, temporal: 50, complexity: 50, stress: 55, distraction: 50 },
    });
    expect(report.workload?.weights).toBeUndefined();
    expect(typeof report.workload?.completedAt).toBe('number');
    expect(report.performance).toBe(6);
    expect(report.caffeine).toBe(false);
    // Unanswered optional items are omitted rather than defaulted.
    expect(report).not.toHaveProperty('perceivedStress');
    expect(report).not.toHaveProperty('sleepHours');
    expect(report).not.toHaveProperty('notes');

    expect(useSessions.getState().refresh).toHaveBeenCalled();
    expect(useRecording.getState().reset).toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledWith('/session/session-1');
  });

  // UX-2: untouched sliders must never be stored as genuine ratings of 50.
  it('does not store unanswered SURG-TLX items: asks, then saves without the workload when confirmed', async () => {
    const alert = answerAlertWith('Save without workload');
    await render(<DebriefScreen />);
    await fireEvent(screen.getByRole('adjustable', { name: 'Mental Demands' }), 'accessibilityAction', increment);
    expect(screen.getByText('Rate all six demands to see the score (1 of 6 rated).')).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId('debrief-submit'));
    expect(alert).toHaveBeenCalledTimes(1);
    expect(String(alert.mock.calls[0]?.[1])).toMatch(/^Not rated yet: Physical Demands, Temporal Demands, Task Complexity, Situational Stress, Distractions\./);
    const report = submittedReport();
    expect(report).not.toHaveProperty('workload');
  });

  it('saving with unrated SURG-TLX items can be cancelled to finish rating', async () => {
    const alert = answerAlertWith('Rate the rest');
    await render(<DebriefScreen />);
    await fireEvent.press(screen.getByTestId('debrief-submit'));
    expect(alert).toHaveBeenCalledTimes(1);
    expect(useRecording.getState().submitDebrief).not.toHaveBeenCalled();
  });

  it('includes pairwise weights once all 15 comparisons are answered', async () => {
    await render(<DebriefScreen />);
    await rateAll();
    await fireEvent(screen.getByTestId('debrief-weighting'), 'valueChange', true);
    const pairs = tlxPairs('surg-tlx');
    expect(screen.getByText(`0 of ${pairs.length} answered`)).toBeOnTheScreen();

    // Always pick the first dimension of each pair.
    for (let i = 0; i < pairs.length; i++) {
      const [a] = pairs[i] as [string, string];
      const label = SURG_TLX_DIMENSIONS.find((d) => d.id === a)?.label ?? a;
      const option = screen.getByTestId(`pair-${i}-${a}`);
      expect(option).toHaveAccessibleName(label);
      await fireEvent.press(option);
    }
    expect(screen.getByText(`${pairs.length} of ${pairs.length} answered`)).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('debrief-submit'));

    const weights = submittedReport().workload?.weights;
    expect(weights).toBeDefined();
    const total = Object.values(weights ?? {}).reduce((a, b) => a + b, 0);
    expect(total).toBe(15);
    // Picking the first of each fixed-order pair: mental wins 5, physical 4, … distraction 0.
    expect(weights).toEqual({ mental: 5, physical: 4, temporal: 3, complexity: 2, stress: 1, distraction: 0 });
  });
});

describe('debrief helpers', () => {
  it('weightsFromChoices tallies only when complete', () => {
    const pairs = tlxPairs('surg-tlx');
    expect(weightsFromChoices(pairs, { 0: pairs[0]?.[0] ?? '' })).toBeNull();
    const all = Object.fromEntries(pairs.map((p, i) => [i, p[1]]));
    const w = weightsFromChoices(pairs, all);
    expect(Object.values(w ?? {}).reduce((a, b) => a + b, 0)).toBe(15);
  });

  it('missingRatings / completeRatings track unanswered SURG-TLX items', () => {
    expect(missingRatings(EMPTY_RATINGS)).toEqual(['mental', 'physical', 'temporal', 'complexity', 'stress', 'distraction']);
    expect(completeRatings(EMPTY_RATINGS)).toBeNull();
    const partial = { ...EMPTY_RATINGS, mental: 0, stress: 100 };
    expect(missingRatings(partial)).toEqual(['physical', 'temporal', 'complexity', 'distraction']);
    expect(buildPostOpReport({ ratings: partial, weights: null, performance: null, perceivedStress: null, sleepHours: null, caffeine: null, outcome: null, notes: '' }, 1)).toEqual({});
  });

  it('buildPostOpReport trims notes and omits empty answers', () => {
    const report = buildPostOpReport(
      {
        ratings: { mental: 10, physical: 20, temporal: 30, complexity: 40, stress: 50, distraction: 60 },
        weights: null,
        performance: null,
        perceivedStress: 3,
        sleepHours: 6.5,
        caffeine: true,
        outcome: 'as-planned',
        notes: '  smooth case  ',
      },
      123,
    );
    expect(report).toEqual({
      workload: {
        instrument: 'surg-tlx',
        ratings: { mental: 10, physical: 20, temporal: 30, complexity: 40, stress: 50, distraction: 60 },
        completedAt: 123,
      },
      perceivedStress: 3,
      sleepHours: 6.5,
      caffeine: true,
      outcome: 'as-planned',
      notes: 'smooth case',
    });
  });
});
