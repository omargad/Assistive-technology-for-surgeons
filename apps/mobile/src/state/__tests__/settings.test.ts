/// <reference types="jest" />
import type { KeyValueStore } from '../../services/kv';
import { DEFAULT_SETTINGS, SETTINGS_KEY, createSettingsStore, sanitizeSettings } from '../settings';

jest.mock('../../services/platform', () => ({ defaultResearchServerUrl: () => '' }));
jest.mock('../../services/kv', () => ({ kvStore: {} }));

function memoryKv(initial: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => {
      data.set(k, v);
    },
    removeItem: async (k) => {
      data.delete(k);
    },
  };
}

describe('settings', () => {
  it('has the documented defaults', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      baselineDurationSec: 180,
      keepAwake: true,
      haptics: true,
      orModeDark: true,
      autoUpload: false,
      onboardingComplete: false,
      preferredSource: null,
      researchToken: '',
    });
  });

  it('sanitises stored values field by field', () => {
    expect(
      sanitizeSettings({
        baselineDurationSec: 9999,
        keepAwake: 'yes',
        preferredSource: 'carrier-pigeon',
        researchServerUrl: ' https://r.example.edu ',
        onboardingComplete: true,
      }),
    ).toEqual({
      ...DEFAULT_SETTINGS,
      baselineDurationSec: 300,
      researchServerUrl: 'https://r.example.edu',
      onboardingComplete: true,
    });
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('loads, updates and persists', async () => {
    const kv = memoryKv({ [SETTINGS_KEY]: JSON.stringify({ haptics: false, preferredSource: 'simulated' }) });
    const store = createSettingsStore(kv);
    expect(store.getState().loaded).toBe(false);
    await store.getState().load();
    expect(store.getState().loaded).toBe(true);
    expect(store.getState().settings.haptics).toBe(false);
    expect(store.getState().settings.preferredSource).toBe('simulated');

    await store.getState().update({ autoUpload: true, researchToken: 'spk_abc' });
    expect(JSON.parse(kv.data.get(SETTINGS_KEY)!)).toMatchObject({ autoUpload: true, haptics: false, researchToken: 'spk_abc' });
  });

  it('keeps an update made before loading finished', async () => {
    const kv = memoryKv({ [SETTINGS_KEY]: JSON.stringify({ haptics: false }) });
    const store = createSettingsStore(kv);
    await store.getState().update({ onboardingComplete: true });
    expect(store.getState().loaded).toBe(true);
    expect(store.getState().settings).toMatchObject({ haptics: false, onboardingComplete: true });
    expect(JSON.parse(kv.data.get(SETTINGS_KEY)!)).toMatchObject({ haptics: false, onboardingComplete: true });
  });

  it('falls back to defaults for a corrupt document', async () => {
    const store = createSettingsStore(memoryKv({ [SETTINGS_KEY]: '{oops' }));
    await store.getState().load();
    expect(store.getState().settings).toEqual(DEFAULT_SETTINGS);
  });
});
