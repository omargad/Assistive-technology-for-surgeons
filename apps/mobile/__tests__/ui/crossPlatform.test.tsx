/// <reference types="jest" />
/**
 * Platform-split UI behaviour. The suite passes under every jest-expo
 * platform preset, and asserts the behaviour of the platform it runs as:
 *   npx jest __tests__/ui                               (iOS, default)
 *   npx jest --preset jest-expo/android __tests__/ui    (Android)
 */
import { act, render, screen } from '@testing-library/react-native';
import { Alert, BackHandler, Platform } from 'react-native';

import LiveScreen from '@/app/record/live';
import * as nativeDialog from '@/components/ConfirmDialog';
import * as webDialog from '@/components/ConfirmDialog.web';
import { makeLiveSession } from '@/components/__testutils__/mockStores';
import { useRecording } from '@/state/recording';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('expo-router', () => require('@/components/__testutils__/expoRouterMock').expoRouterMock());
jest.mock('@/state/recording', () => ({ useRecording: require('@/components/__testutils__/mockStores').makeRecordingStore() }));
jest.mock('@/state/settings', () => ({ useSettings: require('@/components/__testutils__/mockStores').makeSettingsStore() }));
jest.mock('@/state/sessions', () => ({ useSessions: require('@/components/__testutils__/mockStores').makeSessionsStore() }));

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ConfirmDialog (native: Alert)', () => {
  it('resolves true when the destructive confirm button is pressed', async () => {
    const spy = jest.spyOn(Alert, 'alert').mockImplementation((_title, _msg, buttons) => {
      const confirm = buttons?.find((b) => b.style === 'destructive');
      confirm?.onPress?.();
    });
    await expect(nativeDialog.confirmAsync({ title: 'Delete?', confirmLabel: 'Delete', destructive: true })).resolves.toBe(true);
    expect(spy).toHaveBeenCalledWith('Delete?', undefined, expect.any(Array), expect.objectContaining({ cancelable: true }));
  });

  it('resolves false on cancel', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      buttons?.find((b) => b.style === 'cancel')?.onPress?.();
    });
    await expect(nativeDialog.confirmAsync({ title: 'Leave?' })).resolves.toBe(false);
  });
});

describe('ConfirmDialog (web: window.confirm)', () => {
  const g = globalThis as unknown as { window?: { confirm?: (m: string) => boolean; alert?: (m: string) => void } };
  const original = g.window;

  afterEach(() => {
    g.window = original;
  });

  it('uses the browser dialog and joins title and message', async () => {
    const confirm = jest.fn(() => true);
    const alert = jest.fn();
    g.window = { ...original, confirm, alert };
    await expect(webDialog.confirmAsync({ title: 'Delete all data?', message: 'This cannot be undone.' })).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith('Delete all data?\n\nThis cannot be undone.');
    webDialog.notify('Saved');
    expect(alert).toHaveBeenCalledWith('Saved');
  });

  it('declines safely where no browser dialog exists', async () => {
    g.window = undefined;
    await expect(webDialog.confirmAsync({ title: 'x' })).resolves.toBe(false);
    expect(() => webDialog.notify('x')).not.toThrow();
  });
});

describe('Live screen hardware back', () => {
  beforeEach(() => {
    useRecording.setState({ stage: 'recording', session: makeLiveSession(Date.UTC(2026, 2, 2, 9, 0)), currentBpm: 80 });
  });

  it('keeps the live screen on Android back presses (and registers nothing elsewhere)', async () => {
    const add = jest.spyOn(BackHandler, 'addEventListener');
    await render(<LiveScreen />);
    if (Platform.OS !== 'android') {
      expect(add).not.toHaveBeenCalled();
      return;
    }
    expect(add).toHaveBeenCalledWith('hardwareBackPress', expect.any(Function));
    const handler = add.mock.calls[0]?.[1] as () => boolean;
    let consumed = false;
    await act(async () => {
      consumed = handler();
    });
    expect(consumed).toBe(true);
    expect(screen.getByText(/Recording continues\. Use “Minimise”/)).toBeOnTheScreen();
  });
});
