/// <reference types="jest" />
/**
 * Event editor (UX-15): unsaved edits are protected on every way of leaving
 * (iOS swipe-back, Android back, header/browser back), not only the footer button.
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Alert, type AlertButton } from 'react-native';
import { router, useLocalSearchParams, usePreventRemove } from 'expo-router';

import EventEditorScreen from '@/app/session/events/[id]';
import { makeLiveSession } from '@/components/__testutils__/mockStores';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('expo-router', () => require('@/components/__testutils__/expoRouterMock').expoRouterMock());
jest.mock('@/state/recording', () => ({ useRecording: require('@/components/__testutils__/mockStores').makeRecordingStore() }));
jest.mock('@/state/sessions', () => ({ useSessions: require('@/components/__testutils__/mockStores').makeSessionsStore() }));
jest.mock('@/services/storage', () => ({ repository: { updateMeta: jest.fn(async () => undefined), saveSummary: jest.fn(async () => undefined) } }));

const NOW = Date.UTC(2026, 2, 2, 10, 0);
const mockSession = {
  ...makeLiveSession(NOW, 30),
  status: 'completed' as const,
  endedAt: NOW,
  events: [{ id: 'e1', type: 'phase' as const, phase: 'incision' as const, t: NOW - 25 * 60_000, loggedBy: 'team' as const }],
};
jest.mock('@/hooks/useSessionDetail', () => ({
  useSessionDetail: () => ({ session: mockSession, summary: null, loading: false, error: null, reload: jest.fn() }),
  summaryOptions: () => ({}),
}));

const preventRemove = usePreventRemove as jest.Mock;
const lastPrevent = () => preventRemove.mock.calls[preventRemove.mock.calls.length - 1] as [boolean, (o: { repeat: () => void }) => void];

beforeEach(() => {
  jest.clearAllMocks();
  (useLocalSearchParams as jest.Mock).mockReturnValue({ id: mockSession.id });
});

describe('Event editor', () => {
  it('blocks leaving with unsaved edits and asks before discarding', async () => {
    const disable = jest.fn();
    preventRemove.mockReturnValue(disable);
    await render(<EventEditorScreen />);
    expect(lastPrevent()[0]).toBe(false);

    await fireEvent.press(screen.getByLabelText('Add phase Closure'));
    expect(lastPrevent()[0]).toBe(true);

    // A swipe-back / hardware back is blocked: the callback asks, and only "Discard" lets it continue.
    const alert = jest.spyOn(Alert, 'alert').mockImplementationOnce((_t, _m, buttons?: AlertButton[]) => {
      buttons?.find((b) => b.text === 'Cancel')?.onPress?.();
    });
    const repeat = jest.fn();
    await act(async () => lastPrevent()[1]({ repeat }));
    expect(alert).toHaveBeenCalledWith('Discard changes?', expect.any(String), expect.any(Array), expect.anything());
    expect(repeat).not.toHaveBeenCalled();

    alert.mockImplementationOnce((_t, _m, buttons?: AlertButton[]) => {
      buttons?.find((b) => b.text === 'Discard')?.onPress?.();
    });
    await act(async () => lastPrevent()[1]({ repeat }));
    expect(disable).toHaveBeenCalled();
    expect(repeat).toHaveBeenCalledTimes(1);
  });

  it('saving lifts the guard before navigating back', async () => {
    const disable = jest.fn();
    preventRemove.mockReturnValue(disable);
    await render(<EventEditorScreen />);
    await fireEvent.press(screen.getByLabelText('Add phase Dissection'));
    await fireEvent.press(screen.getByTestId('events-save'));
    await act(async () => undefined);
    expect(disable).toHaveBeenCalled();
    expect(router.back).toHaveBeenCalled();
    expect(disable.mock.invocationCallOrder[0]).toBeLessThan((router.back as jest.Mock).mock.invocationCallOrder[0] ?? 0);
  });
});
