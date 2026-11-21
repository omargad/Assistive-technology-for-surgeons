/// <reference types="jest" />
/**
 * Settings: consent status is never shown as "given" when none is recorded
 * (UX-16), the live heart-rate visibility switch is offered (UX-9), the
 * baseline caption asks for a seated baseline (M1), and "Remove demo data"
 * deletes only demo sessions after a confirmation (M2).
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Alert, type AlertButton } from 'react-native';

import type { SessionListItem } from '@/services/storage/types';

import SettingsScreen from '@/app/(tabs)/settings';
import { useSessions } from '@/state/sessions';
import { useSettings } from '@/state/settings';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('expo-router', () => require('@/components/__testutils__/expoRouterMock').expoRouterMock());
jest.mock('@/state/recording', () => ({ useRecording: require('@/components/__testutils__/mockStores').makeRecordingStore() }));
jest.mock('@/state/settings', () => ({ useSettings: require('@/components/__testutils__/mockStores').makeSettingsStore() }));
jest.mock('@/state/sessions', () => ({
  ...jest.requireActual('@/state/sessions'),
  useSessions: require('@/components/__testutils__/mockStores').makeSessionsStore(),
}));
jest.mock('@/state/activeSession', () => ({ activeSessionId: () => null }));
jest.mock('@/services/storage', () => ({ repository: { getSession: jest.fn(), listSessions: jest.fn(async () => []) } }));
jest.mock('@/services/export/share', () => ({ pickImportFile: jest.fn(), shareBundle: jest.fn(), shareSummariesCsv: jest.fn() }));
jest.mock('@/services/upload/research', () => ({ checkEnrolment: jest.fn(), uploadSessions: jest.fn(), withdrawFromStudy: jest.fn() }));
jest.mock('@/services/platform', () => ({ consentVersion: 'PICF-1.0', defaultResearchServerUrl: () => '', appInfo: () => ({ version: '0.1.0', platform: 'ios' }) }));

beforeEach(() => {
  jest.clearAllMocks();
  useSessions.setState({ items: [] });
});
afterEach(() => jest.restoreAllMocks());

/** A list item for a completed session with `tags`. */
function item(id: string, tags: string[]): SessionListItem {
  return {
    meta: {
      schemaVersion: 1,
      id,
      participantCode: 'SP-014',
      procedure: { name: 'Laparoscopic cholecystectomy' },
      startedAt: Date.UTC(2026, 0, 5),
      endedAt: Date.UTC(2026, 0, 5, 1),
      status: 'completed',
      sensor: { source: 'simulated' },
      app: { version: '0.1.0', platform: 'ios' },
      events: [],
      tags,
    },
    summary: null,
    sampleCount: 0,
  };
}

/** Answer the next native confirmation dialog with the button labelled `answer`. */
function answerAlert(answer: string) {
  return jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons?: AlertButton[]) => {
    buttons?.find((b) => b.text === answer)?.onPress?.();
  });
}

describe('Settings screen', () => {
  it('says "No consent recorded" (not "Consent given") without a consent record, and offers to complete it', async () => {
    useSessions.setState({ profile: { code: 'SP-014' } });
    await render(<SettingsScreen />);
    expect(screen.getByText('No consent recorded')).toBeOnTheScreen();
    expect(screen.queryByText('Consent given')).toBeNull();
    await fireEvent.press(screen.getByTestId('settings-give-consent'));
    expect(useSettings.getState().update).toHaveBeenCalledWith({ onboardingComplete: false });
  });

  it('shows "Consent given" with the form version when consent is recorded', async () => {
    useSessions.setState({ profile: { code: 'SP-014', consent: { version: 'PICF-1.0', givenAt: Date.UTC(2026, 0, 5) } } });
    await render(<SettingsScreen />);
    expect(screen.getByText('Consent given')).toBeOnTheScreen();
    expect(screen.queryByTestId('settings-give-consent')).toBeNull();
  });

  it('offers to hide the live heart rate from the theatre team', async () => {
    useSessions.setState({ profile: { code: 'SP-014', consent: { version: 'PICF-1.0', givenAt: Date.UTC(2026, 0, 5) } } });
    await render(<SettingsScreen />);
    await fireEvent(screen.getByTestId('settings-show-live-hr'), 'valueChange', false);
    expect(useSettings.getState().update).toHaveBeenCalledWith({ showLiveHr: false });
  });

  it('asks for a seated resting baseline, like the baseline screen (M1)', async () => {
    await render(<SettingsScreen />);
    expect(screen.getByText(/^Sit quietly before scrubbing, seated every time: standing raises heart rate/)).toBeOnTheScreen();
    expect(screen.queryByText(/stand quietly/)).toBeNull();
  });

  it('offers "Remove demo data" only when demo sessions exist', async () => {
    useSessions.setState({ items: [item('own', [])] });
    await render(<SettingsScreen />);
    expect(screen.queryByTestId('settings-remove-demo')).toBeNull();

    await act(async () => useSessions.setState({ items: [item('own', []), item('d1', ['demo']), item('d2', ['demo'])] }));
    expect(screen.getByTestId('settings-remove-demo')).toHaveTextContent(/2 demo sessions; your own sessions are kept/);
  });

  it('"Remove demo data" confirms first, then removes only the demo sessions (M2)', async () => {
    useSessions.setState({ items: [item('own', []), item('d1', ['demo'])] });
    (useSessions.getState().removeDemoData as jest.Mock).mockResolvedValue(1);
    await render(<SettingsScreen />);

    let alert = answerAlert('Cancel');
    await fireEvent.press(screen.getByTestId('settings-remove-demo'));
    expect(alert).toHaveBeenCalledWith(
      'Remove demo data?',
      expect.stringMatching(/1 simulated demo session \(tagged “Demo”\).*Your own sessions, your profile and consent/s),
      expect.any(Array),
      expect.anything(),
    );
    expect(useSessions.getState().removeDemoData).not.toHaveBeenCalled();
    expect(useSessions.getState().deleteAll).not.toHaveBeenCalled();

    alert.mockRestore();
    alert = answerAlert('Remove');
    await fireEvent.press(screen.getByTestId('settings-remove-demo'));
    await act(async () => undefined);
    expect(useSessions.getState().removeDemoData).toHaveBeenCalledTimes(1);
    expect(useSessions.getState().deleteAll).not.toHaveBeenCalled();
    expect(screen.getByText('Removed 1 demo session')).toBeOnTheScreen();
  });
});
