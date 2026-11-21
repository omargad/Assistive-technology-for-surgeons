/**
 * Storage for secrets (the research enrolment token) — web / fallback entry
 * point. Native builds resolve `secrets.native.ts` (expo-secure-store: the iOS
 * Keychain / Android Keystore, never in OS backups).
 *
 * Browsers have no secure store, so on the web the secret is kept in
 * `localStorage` under its own key (separate from the settings document, so
 * "Delete all data" and "Forget server" remove it reliably), with an
 * in-memory fallback when storage is blocked.
 */
import { kvStore } from './kv';

export interface SecretStore {
  getItem(key: string): Promise<string | null>;
  /** May reject; callers keep the value in memory rather than storing it elsewhere. */
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const secretStore: SecretStore = kvStore;
