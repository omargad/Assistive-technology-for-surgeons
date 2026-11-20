/**
 * Confirmation and notification dialogs — web implementation using the
 * browser's native `window.confirm` / `window.alert` (accessible, keyboard
 * operable, and blocking just like the native Alert).
 */
export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

function text(title: string, message?: string): string {
  return message ? `${title}\n\n${message}` : title;
}

export function confirmAsync({ title, message }: ConfirmOptions): Promise<boolean> {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return Promise.resolve(false);
  return Promise.resolve(window.confirm(text(title, message)));
}

export function notify(title: string, message?: string): void {
  if (typeof window !== 'undefined' && typeof window.alert === 'function') window.alert(text(title, message));
}

export const ConfirmDialog = { confirm: confirmAsync, notify } as const;
