/**
 * The app's recording store, wired to the real services. The state machine
 * itself lives in `recordingStore.ts` (dependency-injected and unit-tested).
 */
import { AppState } from 'react-native';
import { createKeepAwake, haptic } from '../services/feedback';
import { healthStore } from '../services/health';
import { appInfo, tzOffsetMin } from '../services/platform';
import { getSource } from '../services/sensors/registry';
import { repository } from '../services/storage';
import { uploadSessions } from '../services/upload/research';
import { setActiveSessionSource } from './activeSession';
import { activeSessionOf, createRecordingStore } from './recordingStore';
import { useSessions } from './sessions';
import { useSettings } from './settings';

export const useRecording = createRecordingStore({
  repository,
  getSource,
  healthStore,
  getSettings: () => useSettings.getState().settings,
  updateSettings: (patch) => useSettings.getState().update(patch),
  getProfile: async () => useSessions.getState().profile ?? (await repository.getProfile()),
  appInfo,
  tzOffsetMin,
  now: Date.now,
  haptic,
  keepAwake: createKeepAwake(),
  uploadSession: (session, profile) => {
    const { researchServerUrl, researchToken } = useSettings.getState().settings;
    return uploadSessions([session], { url: researchServerUrl, token: researchToken, profile });
  },
  onSessionsChanged: () => {
    void useSessions.getState().refresh();
  },
  subscribeAppState: (listener) => {
    const subscription = AppState.addEventListener('change', listener);
    return () => subscription.remove();
  },
  // Web: write the in-memory repository to localStorage now (no-op for SQLite, which is already durable).
  persistNow: () => (repository as { flushPersistence?: () => void }).flushPersistence?.(),
});

setActiveSessionSource(() => activeSessionOf(useRecording.getState()));
