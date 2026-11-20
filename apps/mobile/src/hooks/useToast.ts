import { useCallback, useState } from 'react';

export interface ToastState {
  message: string;
  key: number;
}

/** Local toast state: `show(message)` / `hide()`; render with `<Toast visible={!!toast} … />`. */
export function useToast(): { toast: ToastState | null; show: (message: string) => void; hide: () => void } {
  const [toast, setToast] = useState<ToastState | null>(null);
  const show = useCallback((message: string) => setToast({ message, key: Date.now() }), []);
  const hide = useCallback(() => setToast(null), []);
  return { toast, show, hide };
}
