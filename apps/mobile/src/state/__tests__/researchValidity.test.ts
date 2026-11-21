/// <reference types="jest" />
/**
 * Research-validity rules in the recording store (RV review):
 * - RV-3: a watch (health-store) session auto-uploaded at the debrief, before its heart rate had synced,
 *   must be uploaded again once the HR is imported; the local "uploaded" marker is dropped.
 * - RV-6: a baseline cut short to a few seconds is not stored as a measured resting baseline.
 * - RV-16: summaries use the session's own participant snapshot, not the current profile.
 */
import type { HeartRateSample, ParticipantProfile, PostOpReport, RRInterval, SurgicalSession } from '@surgeonpulse/core';
import type { HealthImportResult, HealthStore } from '../../services/health/types';
import { createTimedSource } from '../../services/sensors/timed';
import type { HeartRateSource, SensorListener } from '../../services/sensors/types';
import { createMemoryRepository } from '../../services/storage/memory';
import { createRecordingStore, MIN_MEASURED_BASELINE_SEC, shouldAutoUpload, summaryOptionsFor } from '../recordingStore';
import type { RecordingDeps } from '../recordingStore';
import { DEFAULT_SETTINGS } from '../settings';
import type { Settings } from '../types';

jest.mock('../../services/platform', () => ({ defaultResearchServerUrl: () => '' }));
jest.mock('../../services/kv', () => ({
  kvStore: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

const START = new Date('2026-03-02T08:00:00.000Z');
const PROCEDURE = { name: 'Total knee replacement', approach: 'open' as const };
const REPORT: PostOpReport = { performance: 7 };
const UPLOAD_ON: Partial<Settings> = { autoUpload: true, researchServerUrl: 'https://study.example.edu', researchToken: 'spk_test' };

function fakeStrap() {
  let listener: SensorListener | null = null;
  const source: HeartRateSource = {
    kind: 'ble',
    label: 'Fake strap',
    canScan: true,
    isSupported: jest.fn(async () => true),
    requestPermissions: jest.fn(async () => true),
    scan: jest.fn(() => jest.fn()),
    connect: jest.fn(async () => ({ source: 'ble' as const, name: 'Strap' })),
    start: jest.fn(async (l: SensorListener) => {
      listener = l;
      l.onStatus({ state: 'streaming', deviceName: 'Strap' });
    }),
    stop: jest.fn(async () => undefined),
    disconnect: jest.fn(async () => {
      listener = null;
    }),
    onPhase: jest.fn(),
    onMarker: jest.fn(),
  };
  return { source, emit: (s: HeartRateSample[], rr: RRInterval[]) => listener?.onData(s, rr) };
}

function watchStore(result: (start: number, end: number) => HealthImportResult): HealthStore {
  return {
    source: 'healthkit',
    label: 'Apple Health',
    isAvailable: jest.fn(async () => true),
    requestAccess: jest.fn(async () => true),
    importRange: jest.fn(async (start: number, end: number) => result(start, end)),
  };
}

function setup(overrides: Partial<RecordingDeps> & { settings?: Partial<Settings>; profile?: ParticipantProfile } = {}) {
  const repo = createMemoryRepository();
  const settings: Settings = { ...DEFAULT_SETTINGS, ...overrides.settings };
  let profile: ParticipantProfile = overrides.profile ?? { code: 'SP-014', maxHr: 180 };
  const strap = fakeStrap();
  const deps: RecordingDeps = {
    repository: repo,
    getSource: () => strap.source,
    healthStore: watchStore(() => ({ source: 'healthkit', samples: [], rr: [], externalHrv: [] })),
    getSettings: () => settings,
    updateSettings: jest.fn(),
    getProfile: async () => profile,
    appInfo: () => ({ version: '0.1.0', platform: 'ios' }),
    tzOffsetMin: () => 660,
    now: () => Date.now(),
    haptic: jest.fn(),
    keepAwake: { activate: jest.fn(), deactivate: jest.fn() },
    onSessionsChanged: jest.fn(),
    ...overrides,
  };
  return {
    store: createRecordingStore(deps),
    repo,
    strap,
    setProfile: (p: ParticipantProfile) => {
      profile = p;
    },
  };
}

beforeEach(() => jest.useFakeTimers({ now: START }));
afterEach(() => jest.useRealTimers());

describe('RV-3: an upload is invalidated by a later health import', () => {
  it('re-uploads a watch session once its heart rate has been imported, and drops the uploaded marker', async () => {
    let synced = false;
    const healthStore = watchStore((start, end) => ({
      source: 'healthkit',
      // The watch has not synced at the debrief; later the whole case is there (one sample a minute).
      samples: synced ? Array.from({ length: Math.floor((end - start) / 60_000) }, (_, i) => ({ t: start + i * 60_000 + 500, bpm: 80 + (i % 5) })) : [],
      rr: [],
      externalHrv: [],
    }));
    const timed = createTimedSource('healthkit', healthStore);
    const uploaded: SurgicalSession[] = [];
    const h = setup({
      healthStore,
      getSource: () => timed,
      settings: UPLOAD_ON,
      uploadSession: jest.fn(async (s: SurgicalSession) => {
        uploaded.push(s);
        // what research.ts does after a successful upload
        await h.repo.updateMeta(s.id, { tags: [...(s.tags ?? []), 'uploaded:2026-03-02T09:00:00.000Z'] });
      }),
    });
    h.store.getState().beginSetup();
    h.store.getState().setProcedure(PROCEDURE);
    await h.store.getState().chooseSource('healthkit');
    await h.store.getState().connect();
    h.store.getState().skipBaseline();
    await h.store.getState().startRecording();
    await jest.advanceTimersByTimeAsync(60 * 60_000);
    await h.store.getState().endRecording();
    const id = await h.store.getState().submitDebrief(REPORT);
    await jest.advanceTimersByTimeAsync(0);
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]!.samples).toHaveLength(0); // the bug's starting point: auto-upload before the watch synced
    expect((await h.repo.getSession(id))!.tags).toEqual(['uploaded:2026-03-02T09:00:00.000Z']);

    synced = true;
    const added = await h.store.getState().importFromHealth(id);
    await jest.advanceTimersByTimeAsync(0);
    expect(added).toBe(60);
    expect(uploaded).toHaveLength(2);
    expect(uploaded[1]!.samples).toHaveLength(60);
    expect(uploaded[1]!.tags ?? []).not.toContainEqual(expect.stringMatching(/^uploaded:/));
    // Re-uploaded, so the marker is back, now for the version with heart rate.
    expect((await h.repo.getSession(id))!.samples).toHaveLength(60);
  });

  it('without automatic upload the imported session counts as not uploaded again', async () => {
    const h = setup({
      healthStore: watchStore((start) => ({ source: 'healthkit', samples: [{ t: start + 1000, bpm: 75 }], rr: [], externalHrv: [] })),
    });
    h.store.getState().beginSetup();
    h.store.getState().setProcedure(PROCEDURE);
    await h.store.getState().chooseSource('ble');
    await h.store.getState().connect();
    h.store.getState().skipBaseline();
    await h.store.getState().startRecording();
    await h.store.getState().endRecording();
    const id = await h.store.getState().submitDebrief(REPORT);
    h.store.getState().reset();
    await h.repo.updateMeta(id, { tags: ['uploaded:2026-03-02T09:00:00.000Z', 'other'] });
    expect(await h.store.getState().importFromHealth(id)).toBe(1);
    expect((await h.repo.getSession(id))!.tags).toEqual(['other']);
  });

  it('shouldAutoUpload needs the setting, a server, a token and consent', () => {
    const on = { ...DEFAULT_SETTINGS, ...UPLOAD_ON };
    expect(shouldAutoUpload(on, { code: 'SP-1' })).toBe(true);
    expect(shouldAutoUpload({ ...on, autoUpload: false }, { code: 'SP-1' })).toBe(false);
    expect(shouldAutoUpload({ ...on, researchToken: '' }, { code: 'SP-1' })).toBe(false);
    expect(shouldAutoUpload(on, { code: 'SP-1', consent: { version: 'v1', givenAt: 1, withdrawnAt: 2 } })).toBe(false);
  });
});

describe('RV-6: minimum baseline length', () => {
  async function baselineFor(seconds: number) {
    const h = setup();
    h.store.getState().beginSetup();
    h.store.getState().setProcedure(PROCEDURE);
    await h.store.getState().chooseSource('ble');
    await h.store.getState().connect();
    await h.store.getState().startBaseline(180);
    for (let i = 0; i < seconds; i++) {
      h.strap.emit([{ t: Date.now(), bpm: 90 - Math.min(i, 30) }], []);
      await jest.advanceTimersByTimeAsync(1000);
    }
    h.store.getState().finishBaseline();
    return h.store.getState();
  }

  it('does not store a "Finish early" baseline of a few seconds as measured', async () => {
    const s = await baselineFor(3);
    expect(s.stage).toBe('ready');
    expect(s.baseline).toBeNull();
    expect(s.error).toMatch(new RegExp(`shorter than ${MIN_MEASURED_BASELINE_SEC} seconds`));
  });

  it('stores a baseline of at least a minute', async () => {
    const s = await baselineFor(MIN_MEASURED_BASELINE_SEC);
    expect(s.baseline?.source).toBe('measured');
  });
});

describe('RV-16: max HR comes from the session snapshot', () => {
  it('ignores later profile changes when (re)summarising', async () => {
    expect(summaryOptionsFor({ code: 'SP-1', maxHr: 195 })).toEqual({});
    const h = setup({
      profile: { code: 'SP-014', maxHr: 180 },
      healthStore: watchStore((start) => ({ source: 'healthkit', samples: [{ t: start + 1000, bpm: 75 }], rr: [], externalHrv: [] })),
    });
    h.store.getState().beginSetup();
    h.store.getState().setProcedure(PROCEDURE);
    await h.store.getState().chooseSource('ble');
    await h.store.getState().connect();
    h.store.getState().skipBaseline();
    await h.store.getState().startRecording();
    await h.store.getState().endRecording();
    const id = await h.store.getState().submitDebrief(REPORT);
    h.store.getState().reset();
    h.setProfile({ code: 'SP-014', maxHr: 195 });
    await h.store.getState().importFromHealth(id); // re-summarises the stored session
    const [item] = await h.repo.listSessions();
    expect(item!.summary!.maxHr).toBe(180);
  });
});
