/**
 * Defensive `localStorage` access.
 *
 * Storage can be unavailable or throw (Safari private browsing, blocked
 * site data, embedded webviews, quota errors), so every call is wrapped and
 * the dashboard keeps working without persistence. Only small preferences are
 * stored here — never health data. The research-server token is stored only
 * when the user explicitly ticks "remember on this device".
 */

/** Keys used by the dashboard (namespaced to avoid clashes on shared hosts). */
export const STORAGE_KEYS = {
  theme: 'surgeonpulse.dashboard.theme',
  serverUrl: 'surgeonpulse.dashboard.serverUrl',
  serverToken: 'surgeonpulse.dashboard.serverToken',
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

function getStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Read a string, or `null` when absent or storage is unavailable. */
export function readPref(key: StorageKey): string | null {
  try {
    return getStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Write a string (or remove it when `value` is `null`). Returns whether it was persisted. */
export function writePref(key: StorageKey, value: string | null): boolean {
  const storage = getStorage();
  if (storage === null) return false;
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
