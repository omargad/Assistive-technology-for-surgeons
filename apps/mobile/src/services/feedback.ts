/**
 * Haptic feedback and screen keep-awake, wrapped so they never throw.
 *
 * Both Expo modules work on iOS, Android and the web (where haptics map to
 * `navigator.vibrate` and keep-awake to the Screen Wake Lock API), but the web
 * APIs are optional and can reject (no user activation, page hidden, Safari
 * without vibration). Failures are ignored: feedback is a nicety, never a
 * reason to interrupt a recording.
 */
import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

export type HapticKind = 'light' | 'medium' | 'heavy' | 'success' | 'warning';

/** Tag used for the recording wake lock. */
export const KEEP_AWAKE_TAG = 'recording';

function ignore(promise: Promise<unknown> | undefined): void {
  promise?.catch(() => undefined);
}

export function haptic(kind: HapticKind): void {
  try {
    switch (kind) {
      case 'light':
        ignore(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
        break;
      case 'medium':
        ignore(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));
        break;
      case 'heavy':
        ignore(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy));
        break;
      case 'success':
        ignore(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
        break;
      case 'warning':
        ignore(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
        break;
    }
  } catch {
    // Haptics unavailable on this device/browser.
  }
}

export interface KeepAwakeController {
  activate(): void;
  deactivate(): void;
}

/** The part of `document` used to re-acquire the web wake lock. */
export interface VisibilityTarget {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

function browserDocument(): VisibilityTarget | null {
  // Only the web has a `document`; on iOS/Android the native keep-awake flag needs no re-acquiring.
  return typeof document !== 'undefined' && typeof document.addEventListener === 'function' ? document : null;
}

/**
 * Idempotent keep-awake controller (activating twice holds one lock).
 *
 * On the web the Screen Wake Lock is released by the browser whenever the page is hidden (tab switch,
 * screen off, app switch), and a request made while hidden is rejected. While active, the lock is
 * therefore requested again each time the page becomes visible.
 */
export function createKeepAwake(
  tag: string = KEEP_AWAKE_TAG,
  doc: VisibilityTarget | null = browserDocument(),
): KeepAwakeController {
  let active = false;

  function request(): void {
    try {
      ignore(activateKeepAwakeAsync(tag));
    } catch {
      // Wake lock not available (e.g. browser without the Screen Wake Lock API).
    }
  }

  function onVisibilityChange(): void {
    if (!active || doc?.visibilityState !== 'visible') return;
    // The browser released the previous lock when the page was hidden: drop it, then request a new one.
    try {
      ignore(deactivateKeepAwake(tag));
    } catch {
      // nothing held
    }
    request();
  }

  return {
    activate() {
      if (active) return;
      active = true;
      request();
      try {
        doc?.addEventListener('visibilitychange', onVisibilityChange);
      } catch {
        // ignore
      }
    },
    deactivate() {
      if (!active) return;
      active = false;
      try {
        doc?.removeEventListener('visibilitychange', onVisibilityChange);
      } catch {
        // ignore
      }
      try {
        ignore(deactivateKeepAwake(tag));
      } catch {
        // The web implementation throws if the lock was never granted.
      }
    },
  };
}
