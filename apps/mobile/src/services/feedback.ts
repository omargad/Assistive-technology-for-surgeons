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

/** Idempotent keep-awake controller (activating twice holds one lock). */
export function createKeepAwake(tag: string = KEEP_AWAKE_TAG): KeepAwakeController {
  let active = false;
  return {
    activate() {
      if (active) return;
      active = true;
      try {
        ignore(activateKeepAwakeAsync(tag));
      } catch {
        // Wake lock not available (e.g. browser without the Screen Wake Lock API).
      }
    },
    deactivate() {
      if (!active) return;
      active = false;
      try {
        ignore(deactivateKeepAwake(tag));
      } catch {
        // The web implementation throws if the lock was never granted.
      }
    },
  };
}
