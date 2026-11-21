/// <reference types="jest" />
/**
 * Event editor research-validity rules:
 * - RV-12: an event whose time or kind is changed after the case is marked 'retrospective', so the
 *   research data no longer presents a reconstructed time as a live, team-logged one.
 * - RV-3: saving edited events drops the local "uploaded" marker (the server's copy is now out of date)
 *   and, with automatic upload on, sends the corrected session again.
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useLocalSearchParams } from 'expo-router';

import EventEditorScreen from '@/app/session/events/[id]';
import { makeLiveSession } from '@/components/__testutils__/mockStores';
import { repository } from '@/services/storage';
import { uploadSessions } from '@/services/upload/research';
import { useSettings } from '@/state/settings';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('expo-router', () => require('@/components/__testutils__/expoRouterMock').expoRouterMock());
jest.mock('@/state/recording', () => ({ useRecording: require('@/components/__testutils__/mockStores').makeRecordingStore() }));
jest.mock('@/state/sessions', () => ({ useSessions: require('@/components/__testutils__/mockStores').makeSessionsStore() }));
jest.mock('@/services/storage', () => ({ repository: { updateMeta: jest.fn(async () => undefined), saveSummary: jest.fn(async () => undefined) } }));
jest.mock('@/services/upload/research', () => ({
  ...jest.requireActual('@/services/upload/tags'),
  uploadSessions: jest.fn(async () => ({ accepted: [], rejected: [] })),
}));
jest.mock('@/state/settings', () => {
  const { create } = require('zustand');
  const { DEFAULT_SETTINGS } = jest.requireActual('@/state/settings');
  return { useSettings: create(() => ({ settings: { ...DEFAULT_SETTINGS } })) };
});

const NOW = Date.UTC(2026, 2, 2, 10, 0);
const mockSession = {
  ...makeLiveSession(NOW, 30),
  status: 'completed' as const,
  endedAt: NOW,
  tags: ['uploaded:2026-03-02T10:05:00.000Z', 'keep-me'],
  events: [
    { id: 'e1', type: 'phase' as const, phase: 'incision' as const, t: NOW - 25 * 60_000, loggedBy: 'team' as const },
    { id: 'e2', type: 'phase' as const, phase: 'closure' as const, t: NOW - 5 * 60_000, loggedBy: 'team' as const },
  ],
};
jest.mock('@/hooks/useSessionDetail', () => ({
  useSessionDetail: () => ({ session: mockSession, summary: null, loading: false, error: null, reload: jest.fn() }),
  summaryOptions: () => ({}),
}));

const updateMeta = repository.updateMeta as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  (useLocalSearchParams as jest.Mock).mockReturnValue({ id: mockSession.id });
});

async function nudgeIncisionAndSave() {
  await render(<EventEditorScreen />);
  await fireEvent.press(screen.getByLabelText(/^Incision \/ access at/));
  await fireEvent.press(screen.getByLabelText('Move Incision / access 1 minute earlier'));
  await fireEvent.press(screen.getByTestId('events-save'));
  await act(async () => undefined);
}

describe('Event editor audit trail and re-upload', () => {
  it('marks a moved event retrospective, keeps untouched ones, and drops the uploaded marker', async () => {
    await nudgeIncisionAndSave();
    expect(updateMeta).toHaveBeenCalledTimes(1);
    const [id, patch] = updateMeta.mock.calls[0] as [string, { events: typeof mockSession.events; tags: string[] }];
    expect(id).toBe(mockSession.id);
    const moved = patch.events.find((e) => e.id === 'e1')!;
    expect(moved.t).toBe(NOW - 26 * 60_000);
    expect(moved.loggedBy).toBe('retrospective');
    expect(patch.events.find((e) => e.id === 'e2')!.loggedBy).toBe('team');
    expect(patch.tags).toEqual(['keep-me']);
    expect(uploadSessions).not.toHaveBeenCalled(); // automatic upload is off by default
  });

  it('re-uploads the corrected session when automatic upload is on', async () => {
    useSettings.setState({
      settings: { ...useSettings.getState().settings, autoUpload: true, researchServerUrl: 'https://study.example.edu', researchToken: 'spk_x' },
    });
    await nudgeIncisionAndSave();
    expect(uploadSessions).toHaveBeenCalledTimes(1);
    const [sessions] = (uploadSessions as jest.Mock).mock.calls[0] as [{ events: { id: string; loggedBy?: string }[]; tags: string[] }[]];
    expect(sessions[0]!.events.find((e) => e.id === 'e1')!.loggedBy).toBe('retrospective');
    expect(sessions[0]!.tags).toEqual(['keep-me']);
  });
});
