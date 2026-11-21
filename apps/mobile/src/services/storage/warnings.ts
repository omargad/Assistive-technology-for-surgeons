/**
 * Storage problems the user must know about. Only the web repository reports
 * any (browser storage is small: see `memory.ts`); on iOS/Android the warning
 * stays empty. The UI reads it with `useStorageWarning` (hooks).
 */

export interface StorageWarning {
  /**
   * Sessions whose heart-rate signals no longer fit in browser storage. They are still in memory,
   * so exporting them before the page is closed keeps them.
   */
  unsavedSignalSessionIds: readonly string[];
  /** The last change could not be written to browser storage at all. */
  writeFailed: boolean;
}

const NO_WARNING: StorageWarning = { unsavedSignalSessionIds: [], writeFailed: false };

let current: StorageWarning = NO_WARNING;
const listeners = new Set<() => void>();

/** The current warning (a stable object until it changes). */
export function getStorageWarning(): StorageWarning {
  return current;
}

/** Subscribe to changes; returns the unsubscribe function. */
export function subscribeStorageWarning(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Replace the warning (called by the storage implementation). */
export function reportStorageWarning(next: StorageWarning): void {
  const same =
    next.writeFailed === current.writeFailed &&
    next.unsavedSignalSessionIds.length === current.unsavedSignalSessionIds.length &&
    next.unsavedSignalSessionIds.every((id, i) => id === current.unsavedSignalSessionIds[i]);
  if (same) return;
  current = next.writeFailed || next.unsavedSignalSessionIds.length > 0 ? { ...next } : NO_WARNING;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // ignore
    }
  }
}

/** True when there is something to tell the user. */
export function hasStorageWarning(w: StorageWarning): boolean {
  return w.writeFailed || w.unsavedSignalSessionIds.length > 0;
}
