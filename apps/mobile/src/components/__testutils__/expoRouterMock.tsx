/// <reference types="jest" />
/**
 * Minimal `expo-router` double for screen tests:
 *   jest.mock('expo-router', () => require('@/components/__testutils__/expoRouterMock').expoRouterMock());
 * then `import { router } from 'expo-router'` to assert navigation.
 */
import type { ReactNode } from 'react';

export function expoRouterMock() {
  const router = {
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: jest.fn(() => true),
    canDismiss: jest.fn(() => true),
    dismiss: jest.fn(),
    dismissTo: jest.fn(),
    dismissAll: jest.fn(),
  };
  const Screen = () => null;
  const Stack = Object.assign(() => null, {
    Screen,
    Protected: ({ children }: { children?: ReactNode }) => children ?? null,
  });
  return {
    __esModule: true,
    router,
    Stack,
    Redirect: () => null,
    Link: ({ children }: { children?: ReactNode }) => children ?? null,
    useLocalSearchParams: jest.fn(() => ({})),
    useRouter: () => router,
    /** Returns the "disable prevention" function; tests read the latest call's arguments. */
    usePreventRemove: jest.fn(() => jest.fn()),
  };
}
