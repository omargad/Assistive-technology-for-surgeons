import { useSyncExternalStore } from 'react';

import { getStorageWarning, subscribeStorageWarning, type StorageWarning } from '@/services/storage/warnings';

/** Browser-storage problems to show the user (always empty on iOS/Android). */
export function useStorageWarning(): StorageWarning {
  return useSyncExternalStore(subscribeStorageWarning, getStorageWarning, getStorageWarning);
}
