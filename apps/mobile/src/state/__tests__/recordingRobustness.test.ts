/// <reference types="jest" />
/**
 * Recording-flow robustness (mobile native-API / durability review):
 * - SP-MOB-1: out-of-range sensor values are dropped at ingest, so the session stays valid.
 * - SP-MOB-2: leaving the foreground flushes at once; returning re-checks the signal at once.
 * - SP-MOB-3: a health-store import never mixes into a live sensor's data.
 * - SP-MOB-7: a debrief is not saved while the end of the recording is still only in memory.
 * - SP-MOB-10: "Undo" is refused once the undo window has passed.
 * - SP-MOB-6: `activeSessionOf` names the session the recording flow owns.
 */
import { safeParseSession } from '@surgeonpulse/core';
import type { HeartRateSample, PostOpReport, RRInterval } from '@surgeonpulse/core';
import type { HealthStore } from '../../services/health/types';
import { measurementToData } from '../../services/sensors/measurement';
import type { HeartRateSource, SensorListener } from '../../services/sensors/types';
import { createMemoryRepository } from '../../services/storage/memory';
import type { MemoryRepository } from '../../services/storage/memory';
import {
  UNDO_WINDOW_MS,
  UNSAVED_SIGNALS_ERROR,
  activeSessionOf,
  canImportHealthInto,
  createRecordingStore,
} from '../recordingStore';
import type { RecordingDeps } from '../recordingStore';
import { DEFAULT_SETTINGS } from '../settings';

jest.mock('../../services/platform', () => ({ defaultResearchServerUrl: () => '' }));
jest.mock('../../services/kv', () => ({
  kvStore: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

const START = new Date('2026-03-02T08:00:00.000Z');
const REPORT: PostOpReport = {
  workload: {
    instrument: 'surg-tlx',
    ratings: { mental: 50, physical: 50, temporal: 50, complexity: 50, stress: 50, distraction: 50 },
    completedAt: START.getTime(),
  },
};

interface Harness {
  store: ReturnType<typeof createRecordingStore>;
  repo: MemoryRepository;
  emit(samples: HeartRateSample[], rr: RRInterval[]): void;
  /** Deliver a raw GATT 0x2A37 notification exactly like the BLE sources do. */
  notify(bytes: number[]): void;
}

function setup(overrides: Partial<RecordingDeps> & { repo?: MemoryRepository } = {}): Harness {
  const repo = overrides.repo ?? createMemoryRepository();
  let listener: SensorListener | null = null;
  const source: HeartRateSource = {
    kind: 'ble',
    label: 'Strap',
    canScan: true,
    isSupported: async () => true,
    requestPermissions: async () => true,
    scan: () => () => undefined,
    connect: async () => ({ source: 'ble', name: 'Strap', id: 'x' }),
    start: async (l) => {
      listener = l;
    },
    stop: async () => undefined,
    disconnect: async () => {
      listener = null;
    },
  };
  const healthStore: HealthStore = {
    source: 'healthkit',
    label: 'Apple Health',
    isAvailable: async () => true,
    requestAccess: async () => true,
    importRange: async (start) => ({ source: 'healthkit', samples: [{ t: start + 500, bpm: 90 }], rr: [], externalHrv: [] }),
  };
  const store = createRecordingStore({
    repository: repo,
    getSource: () => source,
    healthStore,
    getSettings: () => ({ ...DEFAULT_SETTINGS }),
    getProfile: async () => ({ code: 'SP-014' }),
    appInfo: () => ({ version: '0.1.0', platform: 'android' }),
    tzOffsetMin: () => 600,
    now: () => Date.now(),
    haptic: () => undefined,
    keepAwake: { activate: () => undefined, deactivate: () => undefined },
    ...overrides,
  });
  return {
    store,
    repo,
    emit: (samples, rr) => listener?.onData(samples, rr),
    notify: (bytes) => {
      const d = measurementToData(bytes, Date.now());
      if (d) listener?.onData([d.sample], d.rr);
    },
  };
}

async function startRecording(h: Harness): Promise<string> {
  const s = h.store.getState();
  s.beginSetup();
  s.setProcedure({ name: 'Laparoscopic cholecystectomy', catalogId: 'laparoscopic-cholecystectomy' });
  await h.store.getState().chooseSource('ble');
  await h.store.getState().connect('x');
  h.store.getState().skipBaseline();
  await h.store.getState().startRecording();
  return h.store.getState().session!.id;
}

async function stream(h: Harness, seconds: number): Promise<void> {
  for (let i = 0; i < seconds; i++) {
    const t = Date.now();
    h.emit([{ t, bpm: 80 }], [{ t, ms: 750 }]);
    await jest.advanceTimersByTimeAsync(1000);
  }
}

beforeEach(() => jest.useFakeTimers({ now: START }));
afterEach(() => jest.useRealTimers());

describe('SP-MOB-1: out-of-range sensor values', () => {
  const NORMAL = [0x10, 0x48, 0x2c, 0x03]; // 72 bpm, RR 793 ms
  const UINT16_HR_400 = [0x01, 0x90, 0x01]; // flags: uint16 HR; 0x0190 = 400 bpm
  const RR_6000MS = [0x10, 0x30, 0x00, 0x18]; // 48 bpm with RR raw 0x1800 = 6000 ms

  it.each([
    ['a uint16 heart rate of 400 bpm', UINT16_HR_400],
    ['an RR interval of 6000 ms', RR_6000MS],
  ])('one notification with %s does not make the session unreadable', async (_name, bad) => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
    const repo = createMemoryRepository({ persist: { storage, debounceMs: 10 } });
    const h = setup({ repo });
    const id = await startRecording(h);
    for (let i = 0; i < 30; i++) {
      await jest.advanceTimersByTimeAsync(1000);
      h.notify(i === 20 ? bad : NORMAL);
    }
    expect(h.store.getState().currentBpm).toBeLessThanOrEqual(300);
    await h.store.getState().endRecording();
    await h.store.getState().submitDebrief(REPORT);

    const stored = await repo.getSession(id);
    expect(stored).not.toBeNull();
    expect(safeParseSession(stored).ok).toBe(true);
    expect(stored!.samples.every((s) => s.bpm <= 300)).toBe(true);
    expect(stored!.rr.every((r) => r.ms <= 5000)).toBe(true);
    expect(stored!.samples.length).toBeGreaterThanOrEqual(29);

    // The web build reloads the session from localStorage: it must still be there.
    repo.flushPersistence();
    const reloaded = createMemoryRepository({ persist: { storage } });
    expect(await reloaded.getSession(id)).not.toBeNull();
  });

  it('drops out-of-range values from the baseline buffer too', async () => {
    const h = setup();
    const s = h.store.getState();
    s.beginSetup();
    s.setProcedure({ name: 'Laparoscopic cholecystectomy' });
    await h.store.getState().chooseSource('ble');
    await h.store.getState().connect('x');
    await h.store.getState().startBaseline(60);
    for (let i = 0; i < 60; i++) {
      const t = Date.now();
      h.emit([{ t, bpm: i === 10 ? 4000 : 62 }], [{ t, ms: i === 10 ? 60_000 : 968 }]);
      await jest.advanceTimersByTimeAsync(1000);
    }
    h.store.getState().finishBaseline();
    const baseline = h.store.getState().baseline;
    expect(baseline).not.toBeNull();
    expect(baseline!.restingHr).toBeLessThan(100);
  });
});

describe('SP-MOB-7: final flush failure', () => {
  it('keeps the case in the debrief until every captured sample is stored', async () => {
    const repo = createMemoryRepository();
    let failAppends = false;
    const flaky: MemoryRepository = {
      ...repo,
      appendSignals: (id, samples, rr) =>
        failAppends ? Promise.reject(new Error('SQLITE_FULL')) : repo.appendSignals(id, samples, rr),
    };
    const h = setup({ repo: flaky });
    const id = await startRecording(h);
    await stream(h, 600);
    failAppends = true; // storage fails for the last five minutes and for the final flush
    await stream(h, 300);
    await h.store.getState().endRecording();
    expect(h.store.getState().stage).toBe('debrief');

    await expect(h.store.getState().submitDebrief(REPORT)).rejects.toThrow(UNSAVED_SIGNALS_ERROR);
    expect(h.store.getState().stage).toBe('debrief');
    expect((await repo.getSession(id))?.status).toBe('recording'); // not marked completed with data missing

    failAppends = false; // storage recovers: saving the debrief again stores everything first
    await h.store.getState().submitDebrief(REPORT);
    const stored = await repo.getSession(id);
    expect(stored?.status).toBe('completed');
    expect(stored?.samples).toHaveLength(900);
    const summary = (await repo.listSessions())[0]?.summary;
    expect(summary?.hr?.count).toBe(900);
  });

  it('reset() also writes data still buffered while the debrief is open', async () => {
    const repo = createMemoryRepository();
    let failAppends = false;
    const flaky: MemoryRepository = {
      ...repo,
      appendSignals: (id, samples, rr) =>
        failAppends ? Promise.reject(new Error('I/O error')) : repo.appendSignals(id, samples, rr),
    };
    const h = setup({ repo: flaky });
    const id = await startRecording(h);
    failAppends = true;
    await stream(h, 20);
    await h.store.getState().endRecording();
    failAppends = false;
    h.store.getState().reset();
    await jest.advanceTimersByTimeAsync(0);
    expect((await repo.getSession(id))?.samples).toHaveLength(20);
  });
});

describe('SP-MOB-2: app leaves / returns to the foreground', () => {
  function appState() {
    const listeners = new Set<(state: string) => void>();
    return {
      subscribe: jest.fn((l: (state: string) => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      }),
      send: (state: string) => {
        for (const l of [...listeners]) l(state);
      },
      count: () => listeners.size,
    };
  }

  it('flushes at once when the app goes to the background and persists it', async () => {
    const app = appState();
    const persistNow = jest.fn();
    const h = setup({ subscribeAppState: app.subscribe, persistNow, flushIntervalMs: 60_000 });
    const id = await startRecording(h);
    expect(app.count()).toBe(1);
    for (let i = 0; i < 10; i++) h.emit([{ t: Date.now() + i, bpm: 80 }], []);
    expect((await h.repo.getSession(id))?.samples).toHaveLength(0); // the 60 s timer has not fired

    app.send('background');
    await jest.advanceTimersByTimeAsync(0);
    expect((await h.repo.getSession(id))?.samples).toHaveLength(10);
    expect(persistNow).toHaveBeenCalled();

    await h.store.getState().endRecording();
    expect(app.count()).toBe(0); // unsubscribed when the recording stops
  });

  it('shows "signal lost" immediately on return when no data arrived in the background', async () => {
    const app = appState();
    const h = setup({ subscribeAppState: app.subscribe });
    await startRecording(h);
    await stream(h, 5);
    app.send('background');
    // Android pauses JS timers while backgrounded: move the clock without running them.
    jest.setSystemTime(Date.now() + 5 * 60_000);
    app.send('active');
    expect(h.store.getState().signalLost).toBe(true);
  });
});

describe('SP-MOB-3: health-store import into a strap session', () => {
  it('is refused for a session that already has live sensor data', async () => {
    const h = setup();
    const id = await startRecording(h);
    await stream(h, 60);
    await h.store.getState().endRecording();
    await h.store.getState().submitDebrief(REPORT);
    h.store.getState().reset();
    const before = await h.repo.getSession(id);
    await expect(h.store.getState().importFromHealth(id)).rejects.toThrow(/mix data from two devices/);
    expect((await h.repo.getSession(id))?.samples).toEqual(before?.samples);
  });

  it('canImportHealthInto: timed sessions and sessions without HR data only', () => {
    const empty = { samples: [], rr: [] };
    expect(canImportHealthInto({ sensor: { source: 'healthkit' }, samples: [{ t: 1, bpm: 70 }], rr: [] })).toBe(true);
    expect(canImportHealthInto({ sensor: { source: 'health-connect' }, ...empty })).toBe(true);
    expect(canImportHealthInto({ sensor: { source: 'ble' }, ...empty })).toBe(true);
    expect(canImportHealthInto({ sensor: { source: 'ble' }, samples: [{ t: 1, bpm: 70 }], rr: [] })).toBe(false);
    expect(canImportHealthInto({ sensor: { source: 'web-bluetooth' }, samples: [], rr: [{ t: 1, ms: 800 }] })).toBe(false);
  });
});

describe('SP-MOB-10: undo window', () => {
  it('undoes within the window but not after it (e.g. after Minimise)', async () => {
    const h = setup();
    await startRecording(h);
    h.store.getState().addMarker('teaching');
    await jest.advanceTimersByTimeAsync(5_000);
    h.store.getState().undoLastEvent();
    expect(h.store.getState().session?.events).toHaveLength(0);

    h.store.getState().addMarker('complication');
    await jest.advanceTimersByTimeAsync(UNDO_WINDOW_MS + 20 * 60_000);
    h.store.getState().undoLastEvent();
    expect(h.store.getState().session?.events.map((e) => e.type === 'marker' && e.marker)).toEqual(['complication']);
    expect(h.store.getState().lastEvent).toBeNull();
  });
});

describe('SP-MOB-6: activeSessionOf', () => {
  it('names the session from recording until the debrief is saved', async () => {
    const h = setup();
    expect(activeSessionOf(h.store.getState())).toBeNull();
    const id = await startRecording(h);
    expect(activeSessionOf(h.store.getState())).toBe(id);
    await h.store.getState().endRecording();
    expect(activeSessionOf(h.store.getState())).toBe(id); // debrief
    await h.store.getState().submitDebrief(REPORT);
    expect(activeSessionOf(h.store.getState())).toBeNull(); // done
  });
});
