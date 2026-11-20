/**
 * App settings store (zustand).
 *
 * Persisted as one JSON document through `services/kv` — expo-sqlite's
 * kv-store on iOS/Android, `localStorage` on the web. Loaded values are
 * validated field by field so a corrupt or older document can never put the
 * app into an invalid state. The research token lives only here: it is never
 * logged and never included in exports.
 */
import { create } from 'zustand';
import { kvStore } from '../services/kv';
import type { KeyValueStore } from '../services/kv';
import { defaultResearchServerUrl } from '../services/platform';
import type { SourceChoice } from '../services/sensors/types';
import type { Settings, SettingsStore } from './types';

export const SETTINGS_KEY = 'surgeonpulse.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  baselineDurationSec: 180,
  keepAwake: true,
  haptics: true,
  preferredSource: null,
  preferredDeviceId: null,
  preferredDeviceName: null,
  orModeDark: true,
  researchServerUrl: defaultResearchServerUrl(),
  researchToken: '',
  autoUpload: false,
  onboardingComplete: false,
};

/** Baseline duration bounds (SPEC: adjustable 1–5 min). */
export const BASELINE_MIN_SEC = 60;
export const BASELINE_MAX_SEC = 300;

const SOURCE_CHOICES: readonly SourceChoice[] = ['ble', 'web-bluetooth', 'simulated', 'healthkit', 'health-connect'];

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function nullableStr(v: unknown, fallback: string | null): string | null {
  return typeof v === 'string' || v === null ? v : fallback;
}

/** Coerce any value into valid {@link Settings}, keeping valid fields and defaulting the rest. */
export function sanitizeSettings(raw: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const duration =
    typeof r.baselineDurationSec === 'number' && Number.isFinite(r.baselineDurationSec)
      ? Math.round(Math.min(BASELINE_MAX_SEC, Math.max(BASELINE_MIN_SEC, r.baselineDurationSec)))
      : base.baselineDurationSec;
  const preferredSource =
    r.preferredSource === null
      ? null
      : SOURCE_CHOICES.includes(r.preferredSource as SourceChoice)
        ? (r.preferredSource as SourceChoice)
        : base.preferredSource;
  return {
    baselineDurationSec: duration,
    keepAwake: bool(r.keepAwake, base.keepAwake),
    haptics: bool(r.haptics, base.haptics),
    preferredSource,
    preferredDeviceId: nullableStr(r.preferredDeviceId, base.preferredDeviceId),
    preferredDeviceName: nullableStr(r.preferredDeviceName, base.preferredDeviceName),
    orModeDark: bool(r.orModeDark, base.orModeDark),
    researchServerUrl: str(r.researchServerUrl, base.researchServerUrl).trim(),
    researchToken: str(r.researchToken, base.researchToken).trim(),
    autoUpload: bool(r.autoUpload, base.autoUpload),
    onboardingComplete: bool(r.onboardingComplete, base.onboardingComplete),
  };
}

/** Build a settings store over any key-value backend (tests inject an in-memory one). */
export function createSettingsStore(kv: KeyValueStore = kvStore) {
  return create<SettingsStore>()((set, get) => {
    let loading: Promise<void> | null = null;
    let writes: Promise<void> = Promise.resolve();
    /** Changes made through update() before load() finished; re-applied on top of stored values. */
    let earlyPatch: Partial<Settings> | null = null;

    function persist(settings: Settings): Promise<void> {
      // Serialise writes so an older snapshot can never overwrite a newer one.
      writes = writes.then(() => kv.setItem(SETTINGS_KEY, JSON.stringify(settings))).catch(() => undefined);
      return writes;
    }

    return {
      settings: DEFAULT_SETTINGS,
      loaded: false,

      load() {
        if (!loading) {
          loading = (async () => {
            let parsed: unknown = null;
            try {
              const text = await kv.getItem(SETTINGS_KEY);
              parsed = text ? (JSON.parse(text) as unknown) : null;
            } catch {
              parsed = null; // corrupt document → defaults
            }
            const stored = sanitizeSettings(parsed);
            // Keep any update() made while loading on top of the stored values.
            const patch = earlyPatch;
            earlyPatch = null;
            const settings = patch ? sanitizeSettings({ ...stored, ...patch }, stored) : stored;
            set({ settings, loaded: true });
            if (patch) await persist(settings);
          })();
        }
        return loading;
      },

      async update(patch) {
        const next = sanitizeSettings({ ...get().settings, ...patch }, get().settings);
        set({ settings: next });
        if (!get().loaded) {
          // Not loaded yet: remember the change; load() merges and persists it.
          earlyPatch = { ...earlyPatch, ...patch };
          await get().load();
          return;
        }
        await persist(next);
      },
    };
  });
}

export const useSettings = createSettingsStore();
