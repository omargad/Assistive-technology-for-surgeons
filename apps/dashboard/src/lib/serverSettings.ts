/**
 * Research-server connection settings.
 *
 * - The URL is remembered in `localStorage` (it is not a secret).
 * - The token lives only in this module's memory (lost on reload) unless the
 *   user ticks "remember on this device", in which case it is also written to
 *   `localStorage`. Unticking removes the stored copy immediately.
 */
import { readPref, STORAGE_KEYS, writePref } from './storage';

export interface ServerSettings {
  url: string;
  token: string;
  remember: boolean;
}

let memoryToken = '';

/** Current settings (stored URL, remembered or in-memory token). */
export function loadServerSettings(): ServerSettings {
  const url = readPref(STORAGE_KEYS.serverUrl) ?? '';
  const stored = readPref(STORAGE_KEYS.serverToken);
  if (stored !== null && stored !== '') return { url, token: stored, remember: true };
  return { url, token: memoryToken, remember: false };
}

/** Persist the settings according to the "remember" choice. */
export function saveServerSettings(settings: ServerSettings): void {
  writePref(STORAGE_KEYS.serverUrl, settings.url.trim() === '' ? null : settings.url.trim());
  memoryToken = settings.token;
  writePref(STORAGE_KEYS.serverToken, settings.remember && settings.token !== '' ? settings.token : null);
}

/** Forget the token everywhere (memory and storage); keeps the URL. */
export function forgetServerToken(): void {
  memoryToken = '';
  writePref(STORAGE_KEYS.serverToken, null);
}
