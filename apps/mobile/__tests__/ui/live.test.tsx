/// <reference types="jest" />
/**
 * Live screen: phase and marker buttons call the recording store, the undo
 * snackbar undoes, and "End case" only fires on a long press.
 */
import { fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';

import LiveScreen from '@/app/record/live';
import { makeLiveSession } from '@/components/__testutils__/mockStores';
import { useRecording } from '@/state/recording';

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
    useRecording.setState({ lastEvent: { id: 'e1', type: 'phase', phase: 'dissection', t: NOW, loggedBy: 'team' } });
    await render(<LiveScreen />);
    expect(screen.getByText('Phase: Dissection (team)')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Undo' }));
    expect(useRecording.getState().undoLastEvent).toHaveBeenCalledTimes(1);
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

  it('timed (health-store) sessions show elapsed time and the import note', async () => {
    useRecording.setState({ timedOnly: true, currentBpm: null });
    await render(<LiveScreen />);
    expect(screen.getByText('HR will be imported after the case')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('phase-closure'));
    expect(useRecording.getState().markPhase).toHaveBeenCalledWith('closure');
  });

  it('explains when no case is recording', async () => {
    useRecording.setState({ stage: 'idle', session: null });
    await render(<LiveScreen />);
    expect(screen.getByText('No case is being recorded')).toBeOnTheScreen();
  });
});
