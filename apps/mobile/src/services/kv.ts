/**
 * Small async key-value store for app settings — web / fallback entry point.
 *
 * Backed by `localStorage` when available (wrapped in try/catch because it
 * can throw in private browsing or with blocked storage), otherwise by an
 * in-memory map so the app still works for the current session.
 * The native build resolves `kv.native.ts` (expo-sqlite/kv-store) instead.
 */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const fallback = new Map<string, string>();

function local(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

export const kvStore: KeyValueStore = {
  async getItem(key) {
    try {
      const ls = local();
      if (ls) return ls.getItem(key);
    } catch {
      // fall through to the in-memory copy
    }
    return fallback.get(key) ?? null;
  },
  async setItem(key, value) {
    fallback.set(key, value);
    try {
      local()?.setItem(key, value);
    } catch {
      // Quota exceeded or storage blocked: keep the in-memory copy only.
    }
  },
  async removeItem(key) {
    fallback.delete(key);
    try {
      local()?.removeItem(key);
    } catch {
      // ignore
    }
  },
};
