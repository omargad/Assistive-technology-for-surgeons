/**
 * The app's session repository — web entry point.
 *
 * Sessions are kept in memory and persisted (debounced, size-aware) to
 * `localStorage`. Pending writes are flushed when the page is hidden or
 * unloaded so a closed tab loses at most the last debounce window. When
 * signals no longer fit (or storage fails) a warning is reported through
 * `warnings.ts` for the UI.
 */
import { createMemoryRepository } from './memory';
import type { StorageLike } from './memory';
import type { SessionRepository } from './types';
import { reportStorageWarning } from './warnings';

function browserStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    // Accessing localStorage can throw (e.g. blocked third-party storage, Safari private mode).
    const probe = '__surgeonpulse_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

const storage = browserStorage();

const memoryRepository = createMemoryRepository({
  persist: storage
    ? {
        storage,
        key: 'surgeonpulse.sessions.v1',
        // Tell the user (History tab) when signals no longer fit or nothing can be saved, so they can
        // export while the data is still in memory.
        onPersistStatus: ({ ok, droppedSignals }) =>
          reportStorageWarning({ writeFailed: !ok, unsavedSignalSessionIds: droppedSignals }),
      }
    : null,
});

if (storage && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  const flush = (): void => memoryRepository.flushPersistence();
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }
}

export const repository: SessionRepository = memoryRepository;
