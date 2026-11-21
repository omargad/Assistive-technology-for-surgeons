/// <reference types="jest" />
/**
 * Settings: consent status is never shown as "given" when none is recorded
 * (UX-16), and the live heart-rate visibility switch is offered (UX-9).
 */
import { fireEvent, render, screen } from '@testing-library/react-native';

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

beforeEach(() => jest.clearAllMocks());

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
});
