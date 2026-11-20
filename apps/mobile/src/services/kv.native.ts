/**
 * Small async key-value store for app settings — native entry point, backed
 * by `expo-sqlite/kv-store` (a SQLite-backed AsyncStorage replacement).
 * Failures are swallowed on write and reported as "missing" on read so a
 * storage problem never blocks the UI.
 */
import Storage from 'expo-sqlite/kv-store';
import type { KeyValueStore } from './kv';

export type { KeyValueStore } from './kv';

export const kvStore: KeyValueStore = {
  async getItem(key) {
    try {
      return await Storage.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async setItem(key, value) {
    try {
      await Storage.setItemAsync(key, value);
    } catch {
      // Keep going: settings stay in memory for this run.
    }
  },
  async removeItem(key) {
    try {
      await Storage.removeItemAsync(key);
    } catch {
      // ignore
    }
  },
};
