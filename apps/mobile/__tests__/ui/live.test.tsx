/// <reference types="jest" />
/**
 * Live screen: phase and marker buttons call the recording store, the undo
 * snackbar undoes, and "End case" only fires on a long press.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { Alert, AppState, Platform, type AlertButton } from 'react-native';
import { router } from 'expo-router';

import LiveScreen from '@/app/record/live';
import { makeLiveSession } from '@/components/__testutils__/mockStores';
import { useRecording } from '@/state/recording';
import { useSettings } from '@/state/settings';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('expo-router', () => require('@/components/__testutils__/expoRouterMock').expoRouterMock());
jest.mock('@/state/recording', () => ({ useRecording: require('@/components/__testutils__/mockStores').makeRecordingStore() }));
jest.mock('@/state/settings', () => ({ useSettings: require('@/components/__testutils__/mockStores').makeSettingsStore() }));
jest.mock('@/state/sessions', () => ({ useSessions: require('@/components/__testutils__/mockStores').makeSessionsStore() }));

const NOW = Date.UTC(2026, 2, 2, 9, 0);

beforeEach(() => {
  jest.clearAllMocks();
  const session = makeLiveSession(NOW);
  useRecording.setState({
    stage: 'recording',
    session,
    currentBpm: 84,
    currentPhase: 'incision',
    sensorStatus: { state: 'streaming', deviceName: 'Simulator' },
    baseline: { startedAt: NOW - 20 * 60_000, endedAt: NOW - 17 * 60_000, restingHr: 66, source: 'measured' },
    lastEvent: null,
    signalLost: false,
    timedOnly: false,
  });
});

describe('Live screen', () => {
  it('shows the big heart rate, current phase and next phase', async () => {
    await render(<LiveScreen />);
    expect(screen.getByTestId('live-hr').props.accessibilityLabel).toMatch(/^Heart rate 84 beats per minute/);
    expect(screen.getByRole('button', { name: /^Incision \/ access, Current/ })).toBeSelected();
    expect(screen.getByRole('button', { name: /^Dissection, Next/ })).toBeOnTheScreen();
  });

  it('phase buttons call markPhase', async () => {
    await render(<LiveScreen />);
    await fireEvent.press(screen.getByTestId('phase-dissection'));
    expect(useRecording.getState().markPhase).toHaveBeenCalledWith('dissection');
    await fireEvent.press(screen.getByTestId('phase-critical'));
    expect(useRecording.getState().markPhase).toHaveBeenLastCalledWith('critical');
  });

  it('marker buttons call addMarker; holding opens a quick note', async () => {
    await render(<LiveScreen />);
    await fireEvent.press(screen.getByTestId('marker-complication'));
    expect(useRecording.getState().addMarker).toHaveBeenCalledWith('complication');

    await fireEvent(screen.getByTestId('marker-interruption'), 'longPress');
    await fireEvent.changeText(screen.getByTestId('note-input'), 'Phone call');
    await fireEvent.press(screen.getByTestId('note-add'));
    expect(useRecording.getState().addMarker).toHaveBeenLastCalledWith('interruption', 'Phone call');
  });

  it('the logger toggle switches between self and team', async () => {
    await render(<LiveScreen />);
    await fireEvent.press(screen.getByRole('radio', { name: 'Logged by a team member' }));
    expect(useRecording.getState().setLogger).toHaveBeenCalledWith('team');
  });

  it('offers undo for the last event', async () => {
    useRecording.setState({ lastEvent: { id: 'e1', type: 'phase', phase: 'dissection', t: Date.now(), loggedBy: 'team' } });
    await render(<LiveScreen />);
    expect(screen.getByText('Phase: Dissection (team)')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Undo' }));
    expect(useRecording.getState().undoLastEvent).toHaveBeenCalledTimes(1);
  });

  // SP-MOB-10: reopening the live screen after "Minimise" must not offer undo for an old event again.
  it('does not show undo again for an event older than the undo window', async () => {
    useRecording.setState({
      lastEvent: { id: 'e1', type: 'marker', marker: 'complication', t: Date.now() - 20 * 60_000, loggedBy: 'team' },
    });
    await render(<LiveScreen />);
    expect(screen.queryByText(/Marked: Complication/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(useRecording.getState().lastEvent).toBeNull();
  });

  it('End case requires a long press', async () => {
    await render(<LiveScreen />);
    const end = screen.getByTestId('live-end');

    await fireEvent.press(end);
    expect(useRecording.getState().endRecording).not.toHaveBeenCalled();
    expect(screen.getByText(/Press and hold “End case”/)).toBeOnTheScreen();

    await fireEvent(end, 'longPress');
    expect(useRecording.getState().endRecording).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith('/record/debrief');
  });

  it('shows the signal-lost banner', async () => {
    useRecording.setState({ signalLost: true });
    await render(<LiveScreen />);
    expect(screen.getByText('Signal lost')).toBeOnTheScreen();
  });

  // UX-1: the undo bar lives in a reserved area of the HR panel, never over the phase/event buttons.
  it('shows the undo bar inside the HR panel (not over the buttons) and confirms an undo', async () => {
    const session = useRecording.getState().session!;
    const event = { id: 'e1', type: 'phase' as const, phase: 'dissection' as const, t: Date.now(), loggedBy: 'team' as const };
    useRecording.setState({ session: { ...session, events: [...session.events, event] }, lastEvent: event });
    (useRecording.getState().undoLastEvent as jest.Mock).mockImplementation(() => {
      const s = useRecording.getState().session!;
      useRecording.setState({ session: { ...s, events: s.events.filter((e) => e.id !== 'e1') }, lastEvent: null });
    });
    await render(<LiveScreen />);
    const overlay = screen.getByTestId('live-hr-overlay');
    expect(within(overlay).getByTestId('live-undo')).toBeOnTheScreen();
    await fireEvent.press(within(overlay).getByRole('button', { name: 'Undo' }));
    expect(useRecording.getState().undoLastEvent).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Undone: Phase: Dissection (team)')).toBeOnTheScreen();
  });

  // UX-7: a stale value is not shown as the current heart rate, and the sensor pill does not say "Live".
  it('signal lost: HR shows "--" with the last reading, the pill warns, and the notice replaces the sparkline', async () => {
    useRecording.setState({ signalLost: true, currentBpm: 84 });
    await render(<LiveScreen />);
    const hr = screen.getByTestId('live-hr');
    expect(hr.props.accessibilityLabel).toBe('Heart-rate signal lost. Last reading 84 beats per minute');
    expect(within(hr).getByText('--')).toBeOnTheScreen();
    expect(screen.getByTestId('live-hr-status', { includeHiddenElements: true })).toHaveTextContent('No signal · last 84 bpm');
    expect(screen.getByTestId('live-sensor').props.accessibilityLabel).toMatch(/^Sensor No data/);
    expect(within(screen.getByTestId('live-hr-overlay')).getByTestId('live-signal-lost')).toBeOnTheScreen();
  });

  // UX-13: live-screen secondary controls meet the 44-pt minimum target.
  it('secondary controls are at least 44 pt', async () => {
    useRecording.setState({ lastEvent: { id: 'e1', type: 'phase', phase: 'dissection', t: Date.now(), loggedBy: 'team' } });
    await render(<LiveScreen />);
    expect(screen.getByRole('radio', { name: 'Logged by a team member' })).toHaveStyle({ minHeight: 44 });
    expect(screen.getByTestId('live-minimise')).toHaveStyle({ minHeight: 48 });
    expect(screen.getByTestId('live-sensor')).toHaveStyle({ minHeight: 44 });
    expect(screen.getByTestId('live-undo-dismiss')).toHaveStyle({ minHeight: 44, minWidth: 44 });
  });

  // UX-5: on the web, keyboard and screen-reader users cannot long-press "End case".
  describe('web keyboard / assistive technology', () => {
    beforeEach(() => jest.replaceProperty(Platform, 'OS', 'web'));
    afterEach(() => jest.restoreAllMocks());

    it('a key press on End case asks for confirmation instead of only hinting', async () => {
      const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons?: AlertButton[]) => {
        buttons?.find((b) => b.text === 'End case')?.onPress?.();
      });
      await render(<LiveScreen />);
      await fireEvent.press(screen.getByTestId('live-end'), { nativeEvent: { key: 'Enter' } });
      expect(alert).toHaveBeenCalledWith('End the case now?', expect.any(String), expect.any(Array), expect.anything());
      await act(async () => undefined);
      expect(useRecording.getState().endRecording).toHaveBeenCalledTimes(1);
    });

    it('an assistive-technology click (detail 0) also asks; declining keeps recording', async () => {
      const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons?: AlertButton[]) => {
        buttons?.find((b) => b.text === 'Keep recording')?.onPress?.();
      });
      await render(<LiveScreen />);
      await fireEvent.press(screen.getByTestId('live-end'), { nativeEvent: { type: 'click', detail: 0 } });
      expect(alert).toHaveBeenCalledTimes(1);
      await act(async () => undefined);
      expect(useRecording.getState().endRecording).not.toHaveBeenCalled();
    });

    it('a mouse click still only shows the hold hint', async () => {
      const alert = jest.spyOn(Alert, 'alert');
      await render(<LiveScreen />);
      await fireEvent.press(screen.getByTestId('live-end'), { nativeEvent: { type: 'click', detail: 1 } });
      expect(alert).not.toHaveBeenCalled();
      expect(screen.getByText(/Press and hold “End case”/)).toBeOnTheScreen();
    });

    it('holding Space on End case completes when the ring fills', async () => {
      jest.useFakeTimers();
      try {
        await render(<LiveScreen />);
        await fireEvent(screen.getByTestId('live-end'), 'pressIn', { nativeEvent: { key: ' ' } });
        await act(async () => {
          jest.advanceTimersByTime(1700);
        });
        expect(useRecording.getState().endRecording).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('Shift+Enter on an event button opens the quick note', async () => {
      await render(<LiveScreen />);
      await fireEvent.press(screen.getByTestId('marker-complication'), { nativeEvent: { key: 'Enter', shiftKey: true } });
      expect(useRecording.getState().addMarker).not.toHaveBeenCalled();
      await fireEvent.changeText(screen.getByTestId('note-input'), 'Bleeding');
      await fireEvent.press(screen.getByTestId('note-add'));
      expect(useRecording.getState().addMarker).toHaveBeenCalledWith('complication', 'Bleeding');
    });
  });

  // UX-9: "Show heart rate on the live screen" off: HR is recorded but not displayed to the theatre team.
  it('hides the heart rate when the setting is off, keeping the clock and controls', async () => {
    useSettings.setState({ settings: { ...useSettings.getState().settings, showLiveHr: false } });
    try {
      await render(<LiveScreen />);
      expect(screen.queryByTestId('live-hr')).toBeNull();
      expect(screen.queryByText('84')).toBeNull();
      expect(screen.getByTestId('live-hr-hidden')).toBeOnTheScreen();
      expect(screen.getByText('Heart rate is recorded but not shown')).toBeOnTheScreen();
      await fireEvent.press(screen.getByTestId('phase-closure'));
      expect(useRecording.getState().markPhase).toHaveBeenCalledWith('closure');
    } finally {
      await act(async () => {
        useSettings.setState({ settings: { ...useSettings.getState().settings, showLiveHr: true } });
      });
    }
  });

  it('timed (health-store) sessions show elapsed time and the import note', async () => {
    useRecording.setState({ timedOnly: true, currentBpm: null });
    await render(<LiveScreen />);
    expect(screen.getByText('HR will be imported after the case')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('phase-closure'));
    expect(useRecording.getState().markPhase).toHaveBeenCalledWith('closure');
  });

  // DOC-N3 / SP-MOB-2: Android pauses JS timers in the background; the team is told afterwards.
  it('on Android, tells the team when the app was in the background during the case', async () => {
    const os = jest.replaceProperty(Platform, 'OS', 'android');
    const listeners: ((state: string) => void)[] = [];
    // react-native's jest setup already mocks AppState.addEventListener with jest.fn(); spyOn then returns that
    // same mock, and mockRestore() would wipe its implementation (later renders would get `undefined` back, which
    // breaks the effect cleanup under the jest-expo/android preset). Keep the previous implementation to put back.
    const wasMock = jest.isMockFunction(AppState.addEventListener);
    const previous = wasMock ? (AppState.addEventListener as unknown as jest.Mock).getMockImplementation() : undefined;
    const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      listeners.push(listener as (state: string) => void);
      return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
    });
    try {
      await render(<LiveScreen />);
      expect(screen.queryByTestId('live-backgrounded')).toBeNull();
      await act(async () => {
        for (const l of listeners) l('background');
        for (const l of listeners) l('active');
      });
      expect(screen.getByText('SurgeonPulse was in the background')).toBeOnTheScreen();
      await fireEvent.press(screen.getByRole('button', { name: 'OK' }));
      expect(screen.queryByTestId('live-backgrounded')).toBeNull();
    } finally {
      if (wasMock && previous) spy.mockImplementation(previous);
      else spy.mockRestore();
      os.restore();
    }
  });

  it('explains when no case is recording', async () => {
    useRecording.setState({ stage: 'idle', session: null });
    await render(<LiveScreen />);
    expect(screen.getByText('No case is being recorded')).toBeOnTheScreen();
  });
});
