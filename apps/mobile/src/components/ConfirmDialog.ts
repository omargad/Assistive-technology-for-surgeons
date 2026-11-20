/**
 * Confirmation and notification dialogs — native implementation (iOS/Android)
 * using the platform `Alert`. The web implementation (`ConfirmDialog.web.ts`)
 * uses `window.confirm` / `window.alert`, because `Alert` is a no-op on the web.
 */
import { Alert } from 'react-native';

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive (iOS). */
  destructive?: boolean;
}

/** Ask the user to confirm; resolves true when confirmed. */
export function confirmAsync({
  title,
  message,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  destructive,
}: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: cancelLabel, style: 'cancel', onPress: () => resolve(false) },
        { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

/** Show a simple message with an OK button. */
export function notify(title: string, message?: string): void {
  Alert.alert(title, message);
}

/** Namespaced API: `ConfirmDialog.confirm({...})`, `ConfirmDialog.notify(...)`. */
export const ConfirmDialog = { confirm: confirmAsync, notify } as const;
