/**
 * Storage for secrets (the research enrolment token) — native entry point,
 * backed by expo-secure-store (iOS Keychain, Android Keystore-encrypted
 * preferences). Items are `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`: readable once
 * the device has been unlocked after boot (so a background relaunch can still
 * read them) but never migrated to another device or restored from a backup.
 */
import * as SecureStore from 'expo-secure-store';
import type { SecretStore } from './secrets';

export type { SecretStore } from './secrets';

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export const secretStore: SecretStore = {
  async getItem(key) {
    try {
      return (await SecureStore.getItemAsync(key, OPTIONS)) ?? null;
    } catch {
      return null;
    }
  },
  async setItem(key, value) {
    // Let failures propagate: the caller keeps the token in memory and never falls back to plain storage.
    await SecureStore.setItemAsync(key, value, OPTIONS);
  },
  async removeItem(key) {
    try {
      await SecureStore.deleteItemAsync(key, OPTIONS);
    } catch {
      // nothing stored
    }
  },
};
