/// <reference types="jest" />
import type { KeyValueStore } from '../../services/kv';
import type { SecretStore } from '../../services/secrets';
import { DEFAULT_SETTINGS, RESEARCH_TOKEN_KEY, SETTINGS_KEY, createSettingsStore, sanitizeSettings } from '../settings';

jest.mock('../../services/platform', () => ({ defaultResearchServerUrl: () => '' }));
jest.mock('../../services/kv', () => ({ kvStore: {} }));
jest.mock('../../services/secrets', () => ({ secretStore: {} }));

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

function memorySecrets(initial: Record<string, string> = {}, opts: { failWrites?: boolean } = {}): SecretStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => {
      if (opts.failWrites) throw new Error('keychain unavailable');
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

  // UX-9: the live heart rate can be hidden from the theatre team; it is shown unless turned off.
  it('showLiveHr defaults to true and keeps a stored false', () => {
    expect(DEFAULT_SETTINGS.showLiveHr).toBe(true);
    expect(sanitizeSettings({ showLiveHr: false }).showLiveHr).toBe(false);
    expect(sanitizeSettings({ showLiveHr: 'no' }).showLiveHr).toBe(true);
  });

  it('loads, updates and persists', async () => {
    const kv = memoryKv({ [SETTINGS_KEY]: JSON.stringify({ haptics: false, preferredSource: 'simulated' }) });
    const secrets = memorySecrets();
    const store = createSettingsStore(kv, secrets);
    expect(store.getState().loaded).toBe(false);
    await store.getState().load();
    expect(store.getState().loaded).toBe(true);
    expect(store.getState().settings.haptics).toBe(false);
    expect(store.getState().settings.preferredSource).toBe('simulated');

    await store.getState().update({ autoUpload: true, researchToken: 'spk_abc' });
    expect(JSON.parse(kv.data.get(SETTINGS_KEY)!)).toMatchObject({ autoUpload: true, haptics: false });
    // SEC-2: the token goes to the secret store (Keychain/Keystore on native), never into the settings document.
    expect(kv.data.get(SETTINGS_KEY)).not.toContain('spk_abc');
    expect(JSON.parse(kv.data.get(SETTINGS_KEY)!)).not.toHaveProperty('researchToken');
    expect(secrets.data.get(RESEARCH_TOKEN_KEY)).toBe('spk_abc');

    const reopened = createSettingsStore(kv, secrets);
    await reopened.getState().load();
    expect(reopened.getState().settings).toMatchObject({ autoUpload: true, researchToken: 'spk_abc' });

    await reopened.getState().update({ researchToken: '' });
    expect(secrets.data.has(RESEARCH_TOKEN_KEY)).toBe(false);
  });

  it('moves a plain-text token from an older settings document into the secret store', async () => {
    const kv = memoryKv({ [SETTINGS_KEY]: JSON.stringify({ haptics: false, researchToken: 'spk_legacy' }) });
    const secrets = memorySecrets();
    const store = createSettingsStore(kv, secrets);
    await store.getState().load();
    expect(store.getState().settings.researchToken).toBe('spk_legacy');
    expect(secrets.data.get(RESEARCH_TOKEN_KEY)).toBe('spk_legacy');
    expect(kv.data.get(SETTINGS_KEY)).not.toContain('spk_legacy');
    expect(JSON.parse(kv.data.get(SETTINGS_KEY)!)).toMatchObject({ haptics: false });
  });

  it('never falls back to the plain settings document when the secret store fails', async () => {
    const kv = memoryKv();
    const store = createSettingsStore(kv, memorySecrets({}, { failWrites: true }));
    await store.getState().load();
    await store.getState().update({ researchToken: 'spk_mem', haptics: false });
    expect(store.getState().settings.researchToken).toBe('spk_mem'); // usable for this run
    expect(kv.data.get(SETTINGS_KEY)).not.toContain('spk_mem');
  });

  it('keeps an update made before loading finished', async () => {
    const kv = memoryKv({ [SETTINGS_KEY]: JSON.stringify({ haptics: false }) });
    const store = createSettingsStore(kv, memorySecrets());
    await store.getState().update({ onboardingComplete: true });
    expect(store.getState().loaded).toBe(true);
    expect(store.getState().settings).toMatchObject({ haptics: false, onboardingComplete: true });
    expect(JSON.parse(kv.data.get(SETTINGS_KEY)!)).toMatchObject({ haptics: false, onboardingComplete: true });
  });

  it('falls back to defaults for a corrupt document', async () => {
    const store = createSettingsStore(memoryKv({ [SETTINGS_KEY]: '{oops' }), memorySecrets());
    await store.getState().load();
    expect(store.getState().settings).toEqual(DEFAULT_SETTINGS);
  });
});
