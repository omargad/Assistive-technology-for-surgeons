/// <reference types="jest" />
import type {
  HeartRateSample,
  ParticipantProfile,
  PostOpReport,
  ProcedureInfo,
  RRInterval,
  SurgicalSession,
} from '@surgeonpulse/core';
import type { HealthImportResult, HealthStore } from '../../services/health/types';
import { createTimedSource } from '../../services/sensors/timed';
import type { HeartRateSource, SensorListener, SensorStatus, SourceChoice } from '../../services/sensors/types';
import { createMemoryRepository } from '../../services/storage/memory';
import type { MemoryRepository } from '../../services/storage/memory';
import { createRecordingStore } from '../recordingStore';
import type { RecordingDeps } from '../recordingStore';
import { DEFAULT_SETTINGS } from '../settings';
import type { Settings } from '../types';

jest.mock('../../services/platform', () => ({
  defaultResearchServerUrl: () => '',
}));
jest.mock('../../services/kv', () => ({
  kvStore: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

const START = new Date('2026-03-02T08:00:00.000Z');

const PROCEDURE: ProcedureInfo = {
  name: 'Laparoscopic cholecystectomy',
  catalogId: 'laparoscopic-cholecystectomy',
  specialty: 'General surgery',
  approach: 'laparoscopic',
  role: 'primary',
};

const PROFILE: ParticipantProfile = { code: 'SP-014', trainingLevel: 'registrar', birthYear: 1990, maxHr: 190 };

const REPORT: PostOpReport = {
  workload: {
    instrument: 'surg-tlx',
    ratings: { mental: 60, physical: 30, temporal: 50, complexity: 55, stress: 40, distraction: 20 },
    completedAt: START.getTime() + 3_600_000,
  },
  performance: 8,
  perceivedStress: 4,
  notes: 'Routine case',
};

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeSensor {
  source: HeartRateSource;
  emit(samples: HeartRateSample[], rr: RRInterval[]): void;
  status(status: SensorStatus): void;
}

function createFakeSensor(kind: SourceChoice = 'ble'): FakeSensor {
  let listener: SensorListener | null = null;
  const source: HeartRateSource = {
    kind,
    label: 'Fake strap',
    canScan: true,
    isSupported: jest.fn(async () => true),
    requestPermissions: jest.fn(async () => true),
    scan: jest.fn((onDevice) => {
      onDevice({ id: 'weak', name: 'Weak strap', rssi: -90, advertisesHeartRate: true });
      onDevice({ id: 'polar', name: 'Polar H10 A1B2', rssi: -50, advertisesHeartRate: true });
      onDevice({ id: 'polar', name: 'Polar H10 A1B2', rssi: -48, advertisesHeartRate: true });
      return jest.fn();
    }),
    connect: jest.fn(async (id?: string) => ({ source: kind, name: 'Polar H10 A1B2', ...(id ? { id } : {}) })),
    start: jest.fn(async (l: SensorListener) => {
      listener = l;
      l.onStatus({ state: 'streaming', deviceName: 'Polar H10 A1B2' });
    }),
    stop: jest.fn(async () => undefined),
    disconnect: jest.fn(async () => {
      listener = null;
    }),
    onPhase: jest.fn(),
    onMarker: jest.fn(),
  };
  return {
    source,
    emit: (samples, rr) => listener?.onData(samples, rr),
    status: (s) => listener?.onStatus(s),
  };
}

function createFakeHealthStore(result: (start: number, end: number) => HealthImportResult): HealthStore {
  return {
    source: 'healthkit',
    label: 'Apple Health',
    isAvailable: jest.fn(async () => true),
    requestAccess: jest.fn(async () => true),
    importRange: jest.fn(async (start: number, end: number) => result(start, end)),
  };
}

interface Harness {
  store: ReturnType<typeof createRecordingStore>;
  repo: MemoryRepository;
  sensor: FakeSensor;
  deps: RecordingDeps;
  settings: Settings;
  keepAwake: { activate: jest.Mock; deactivate: jest.Mock };
  haptic: jest.Mock;
}

function setup(overrides: Partial<RecordingDeps> & { settings?: Partial<Settings> } = {}): Harness {
  const repo = createMemoryRepository();
  const sensor = createFakeSensor();
  const settings: Settings = { ...DEFAULT_SETTINGS, ...overrides.settings };
  const keepAwake = { activate: jest.fn(), deactivate: jest.fn() };
  const haptic = jest.fn();
  const deps: RecordingDeps = {
    repository: repo,
    getSource: () => sensor.source,
    healthStore: createFakeHealthStore((start) => ({
      source: 'healthkit',
      samples: [{ t: start + 500, bpm: 80 }],
      rr: [],
      externalHrv: [],
    })),
    getSettings: () => settings,
    updateSettings: jest.fn(),
    getProfile: async () => PROFILE,
    appInfo: () => ({ version: '0.1.0', platform: 'ios' }),
    tzOffsetMin: () => 600,
    now: () => Date.now(),
    haptic,
    keepAwake,
    onSessionsChanged: jest.fn(),
    ...overrides,
  };
  return { store: createRecordingStore(deps), repo, sensor, deps, settings, keepAwake, haptic };
}

/** Emit 1 Hz heart rate (and one RR per beat-second) for `seconds`, advancing fake time. */
async function stream(sensor: FakeSensor, seconds: number, bpm = 70): Promise<void> {
  for (let i = 0; i < seconds; i++) {
    const t = Date.now();
    const value = bpm + ((i % 5) - 2);
    sensor.emit([{ t, bpm: value, contact: true }], [{ t, ms: Math.round(60_000 / value) }]);
    await jest.advanceTimersByTimeAsync(1000);
  }
}

async function connected(h: Harness): Promise<void> {
  h.store.getState().beginSetup();
  h.store.getState().setProcedure(PROCEDURE);
  await h.store.getState().chooseSource('ble');
  await h.store.getState().connect('polar');
}

async function recording(h: Harness): Promise<SurgicalSession> {
  await connected(h);
  h.store.getState().skipBaseline();
  await h.store.getState().startRecording();
  const session = h.store.getState().session;
  if (!session) throw new Error('no session');
  return session;
}

beforeEach(() => {
  jest.useFakeTimers({ now: START });
});

afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recording store', () => {
  it('runs the full flow: setup → baseline → recording → events → debrief → cached summary', async () => {
    const h = setup();
    const { store, repo } = h;
    expect(store.getState().stage).toBe('idle');

    store.getState().beginSetup();
    expect(store.getState().stage).toBe('setup');
    store.getState().setProcedure(PROCEDURE);
    await store.getState().chooseSource('ble');
    expect(h.deps.updateSettings).toHaveBeenCalledWith({ preferredSource: 'ble' });

    await store.getState().startScan();
    // De-duplicated by id and ordered by signal strength.
    expect(store.getState().devices.map((d) => d.id)).toEqual(['polar', 'weak']);
    expect(store.getState().scanning).toBe(true);

    await store.getState().connect('polar');
    expect(store.getState().scanning).toBe(false);
    expect(store.getState().sensor).toEqual({ source: 'ble', name: 'Polar H10 A1B2', id: 'polar' });
    expect(store.getState().sensorStatus.state).toBe('streaming');
    expect(h.deps.updateSettings).toHaveBeenCalledWith({ preferredDeviceId: 'polar', preferredDeviceName: 'Polar H10 A1B2' });

    // Setup: data only updates the big HR display.
    h.sensor.emit([{ t: Date.now(), bpm: 66 }], []);
    expect(store.getState().currentBpm).toBe(66);
    expect(store.getState().session).toBeNull();

    // Baseline: 60 s at rest is captured and summarised with core computeBaseline.
    await store.getState().startBaseline(60);
    expect(store.getState().stage).toBe('baseline');
    expect(h.keepAwake.activate).toHaveBeenCalled();
    await stream(h.sensor, 60, 64);
    store.getState().finishBaseline();
    const baseline = store.getState().baseline;
    expect(store.getState().stage).toBe('ready');
    expect(baseline?.source).toBe('measured');
    expect(baseline?.restingHr).toBeCloseTo(64, 0);

    // Recording.
    await store.getState().startRecording();
    const state = store.getState();
    expect(state.stage).toBe('recording');
    const id = state.session!.id;
    const created = await repo.getSession(id);
    expect(created).toMatchObject({
      status: 'recording',
      participantCode: 'SP-014',
      tzOffsetMin: 600,
      procedure: PROCEDURE,
      participantSnapshot: { trainingLevel: 'registrar', birthYear: 1990, maxHr: 190 },
    });
    expect(created?.baseline?.restingHr).toBeCloseTo(64, 0);

    store.getState().markPhase('incision');
    await stream(h.sensor, 30, 80);
    store.getState().setLogger('self');
    store.getState().addMarker('complication', '  bleeding  ');
    await stream(h.sensor, 30, 100);
    store.getState().markPhase('closure');
    expect(h.sensor.source.onPhase).toHaveBeenCalledWith('incision');
    expect(h.sensor.source.onMarker).toHaveBeenCalledWith('complication');
    expect(store.getState().currentPhase).toBe('closure');

    // Events are persisted immediately, with who logged them.
    await jest.advanceTimersByTimeAsync(0);
    const stored = await repo.getSession(id);
    expect(stored?.events.map((e) => [e.type, e.type === 'phase' ? e.phase : e.marker, e.loggedBy])).toEqual([
      ['phase', 'incision', 'team'],
      ['marker', 'complication', 'self'],
      ['phase', 'closure', 'self'],
    ]);
    expect(stored?.events[1]?.note).toBe('bleeding');

    await store.getState().endRecording();
    expect(store.getState().stage).toBe('debrief');
    expect(h.sensor.source.stop).toHaveBeenCalled();
    expect(h.sensor.source.disconnect).toHaveBeenCalled();
    expect(h.keepAwake.deactivate).toHaveBeenCalled();
    const ended = await repo.getSession(id);
    expect(ended?.status).toBe('recording'); // only completed after the debrief
    expect(ended?.endedAt).toBe(Date.now());
    expect(ended?.samples).toHaveLength(60); // final flush wrote everything
    expect(ended?.rr).toHaveLength(60);

    const returned = await store.getState().submitDebrief(REPORT);
    expect(returned).toBe(id);
    expect(store.getState().stage).toBe('done');
    const [item] = await repo.listSessions();
    expect(item?.meta.status).toBe('completed');
    expect(item?.meta.postOp?.performance).toBe(8);
    expect(item?.summary).not.toBeNull();
    expect(item?.summary?.sessionId).toBe(id);
    expect(item?.summary?.maxHr).toBe(190);
    expect(item?.summary?.workload?.instrument).toBe('surg-tlx');
    expect(item?.summary?.markerCounts).toEqual({ complication: 1 });
    expect(h.deps.onSessionsChanged).toHaveBeenCalled();

    store.getState().reset();
    expect(store.getState().stage).toBe('idle');
    expect(store.getState().logger).toBe('self'); // the logger choice is kept
  });

  it('flushes newly ingested signals every 5 s in batches (tracking a flushed index)', async () => {
    const h = setup();
    const append = jest.spyOn(h.repo, 'appendSignals');
    const session = await recording(h);

    await stream(h.sensor, 4);
    expect(append).not.toHaveBeenCalled();
    await stream(h.sensor, 1);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]?.[1]).toHaveLength(5);

    await stream(h.sensor, 5);
    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[1]?.[1]).toHaveLength(5); // only the new samples
    expect(append.mock.calls[1]?.[1][0]?.t).toBe(session.startedAt + 5000);

    // Nothing new → no write.
    await jest.advanceTimersByTimeAsync(5000);
    expect(append).toHaveBeenCalledTimes(2);
    expect((await h.repo.getSession(session.id))?.samples).toHaveLength(10);
  });

  it('retries a failed flush without losing data', async () => {
    const h = setup();
    const session = await recording(h);
    const append = jest.spyOn(h.repo, 'appendSignals').mockRejectedValueOnce(new Error('disk full'));
    await stream(h.sensor, 5);
    expect(append).toHaveBeenCalledTimes(1);
    expect(h.store.getState().error).toMatch(/Saving to storage failed/);
    await stream(h.sensor, 5);
    expect(h.store.getState().error).toBeNull();
    expect((await h.repo.getSession(session.id))?.samples).toHaveLength(10);
  });

  it('clamps out-of-order timestamps so storage stays append-only', async () => {
    const h = setup();
    await recording(h);
    const t = Date.now();
    h.sensor.emit([{ t, bpm: 70 }], []);
    h.sensor.emit([{ t: t - 500, bpm: 71 }], []); // wall clock stepped back
    expect(h.store.getState().session?.samples.map((s) => s.t)).toEqual([t, t]);
  });

  it('undo removes the last event and restores the previous phase', async () => {
    const h = setup();
    const session = await recording(h);
    h.store.getState().markPhase('incision');
    await jest.advanceTimersByTimeAsync(1000);
    h.store.getState().markPhase('dissection');
    expect(h.store.getState().lastEvent?.type).toBe('phase');
    h.store.getState().undoLastEvent();
    expect(h.store.getState().currentPhase).toBe('incision');
    expect(h.store.getState().lastEvent).toBeNull();
    expect(h.store.getState().session?.events).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(0);
    expect((await h.repo.getSession(session.id))?.events).toHaveLength(1);
    // Nothing left to undo.
    h.store.getState().undoLastEvent();
    expect(h.store.getState().session?.events).toHaveLength(1);
  });

  it('allows phases in any order (cases loop) and ignores events outside recording', async () => {
    const h = setup();
    h.store.getState().markPhase('incision'); // idle: ignored
    expect(h.store.getState().session).toBeNull();
    await recording(h);
    for (const p of ['dissection', 'critical', 'dissection', 'critical'] as const) h.store.getState().markPhase(p);
    expect(h.store.getState().session?.events.map((e) => (e.type === 'phase' ? e.phase : ''))).toEqual([
      'dissection',
      'critical',
      'dissection',
      'critical',
    ]);
  });

  it('beginSetup keeps a sensor that is already connected, but not a released one', async () => {
    const h = setup();
    await h.store.getState().chooseSource('ble'); // e.g. paired from the sensors screen while idle
    await h.store.getState().connect('polar');
    h.store.getState().beginSetup();
    expect(h.store.getState().stage).toBe('setup');
    expect(h.store.getState().sensor?.id).toBe('polar');
    expect(h.sensor.source.disconnect).not.toHaveBeenCalled();

    h.store.getState().setProcedure(PROCEDURE);
    h.store.getState().skipBaseline();
    await h.store.getState().startRecording();
    await h.store.getState().endRecording(); // releases the sensor
    await h.store.getState().submitDebrief(REPORT);
    h.store.getState().beginSetup();
    expect(h.store.getState().sensor).toBeNull();
    expect(h.store.getState().sourceChoice).toBeNull();
  });

  it('ignores data when idle', () => {
    const h = setup();
    h.store.getState().ingest([{ t: Date.now(), bpm: 80 }], []);
    expect(h.store.getState().currentBpm).toBeNull();
  });

  it('flags signal loss after 15 s without data and clears it when data resumes', async () => {
    const h = setup();
    await recording(h);
    await stream(h.sensor, 3); // last sample at +2 s, clock now at +3 s
    await jest.advanceTimersByTimeAsync(14_000); // 15 s since the last sample
    expect(h.store.getState().signalLost).toBe(false);
    await jest.advanceTimersByTimeAsync(2_000); // 17 s
    expect(h.store.getState().signalLost).toBe(true);
    await stream(h.sensor, 1);
    expect(h.store.getState().signalLost).toBe(false);
  });

  it('mirrors sensor status changes', async () => {
    const h = setup();
    await recording(h);
    h.sensor.status({ state: 'reconnecting', message: 'Reconnecting (attempt 1)' });
    expect(h.store.getState().sensorStatus).toEqual({ state: 'reconnecting', message: 'Reconnecting (attempt 1)' });
  });

  it('respects the keep-awake and haptics settings', async () => {
    const h = setup({ settings: { keepAwake: false, haptics: false } });
    await recording(h);
    h.store.getState().markPhase('incision');
    expect(h.keepAwake.activate).not.toHaveBeenCalled();
    expect(h.haptic).not.toHaveBeenCalled();

    const h2 = setup();
    await recording(h2);
    h2.store.getState().addMarker('complication');
    expect(h2.keepAwake.activate).toHaveBeenCalled();
    expect(h2.haptic).toHaveBeenCalledWith('heavy');
  });

  it('requires a procedure and a connected source before recording', async () => {
    const h = setup();
    h.store.getState().beginSetup();
    await h.store.getState().startRecording();
    expect(h.store.getState().stage).toBe('setup');
    expect(h.store.getState().error).toMatch(/Connect/);
    await h.store.getState().chooseSource('ble');
    await h.store.getState().connect('polar');
    await h.store.getState().startRecording();
    expect(h.store.getState().error).toMatch(/procedure/);
    expect(h.store.getState().stage).toBe('setup');
  });

  it('reports permission problems and unsupported sources', async () => {
    const h = setup();
    (h.sensor.source.requestPermissions as jest.Mock).mockResolvedValueOnce(false);
    h.store.getState().beginSetup();
    await h.store.getState().chooseSource('ble');
    await h.store.getState().startScan();
    expect(h.store.getState().sensorStatus.state).toBe('permission-denied');
    expect(h.store.getState().scanning).toBe(false);

    (h.sensor.source.requestPermissions as jest.Mock).mockRejectedValueOnce(new Error('Bluetooth is off. Turn it on and try again.'));
    await h.store.getState().connect('polar');
    expect(h.store.getState().error).toBe('Bluetooth is off. Turn it on and try again.');
    expect(h.store.getState().sensorStatus.state).toBe('error');

    const h2 = setup();
    (h2.sensor.source.isSupported as jest.Mock).mockResolvedValueOnce(false);
    h2.store.getState().beginSetup();
    await h2.store.getState().chooseSource('ble');
    expect(h2.store.getState().sensorStatus.state).toBe('unsupported');
  });

  it('abort marks a created session as aborted and returns to idle', async () => {
    const h = setup();
    const session = await recording(h);
    await stream(h.sensor, 3);
    await h.store.getState().abort();
    expect(h.store.getState().stage).toBe('idle');
    expect(h.keepAwake.deactivate).toHaveBeenCalled();
    const stored = await h.repo.getSession(session.id);
    expect(stored?.status).toBe('aborted');
    expect(stored?.endedAt).toBeDefined();
    expect(stored?.samples).toHaveLength(3);
  });

  it('abort before a session exists stores nothing', async () => {
    const h = setup();
    await connected(h);
    await h.store.getState().abort();
    expect(await h.repo.listSessions()).toEqual([]);
    expect(h.sensor.source.disconnect).toHaveBeenCalled();
  });

  it('recovers an interrupted session and continues recording into it', async () => {
    const h = setup();
    const session = await recording(h);
    h.store.getState().markPhase('dissection');
    await stream(h.sensor, 10);

    // Simulate the app being killed: a new store over the same storage.
    const h2 = setup({ repository: h.repo });
    const interrupted = await h.repo.findInterrupted();
    expect(interrupted.map((m) => m.id)).toEqual([session.id]);

    await h2.store.getState().recoverInterrupted(session.id);
    expect(h2.store.getState().stage).toBe('setup');
    expect(h2.store.getState().currentPhase).toBe('dissection');
    h2.store.getState().beginSetup(); // UI may call this again: must not discard the recovered session
    expect(h2.store.getState().session?.id).toBe(session.id);

    await h2.store.getState().chooseSource('ble');
    await h2.store.getState().connect('polar');
    await h2.store.getState().startRecording();
    expect(h2.store.getState().session?.id).toBe(session.id);
    await stream(h2.sensor, 5);
    await h2.store.getState().endRecording();
    expect((await h.repo.getSession(session.id))?.samples).toHaveLength(15);
    expect((await h.repo.listSessions())).toHaveLength(1);
  });

  it('finishes an interrupted session at its last data point and goes to the debrief', async () => {
    const h = setup();
    const session = await recording(h);
    await stream(h.sensor, 10);
    const lastT = h.store.getState().session!.samples.at(-1)!.t;

    const h2 = setup({ repository: h.repo });
    await jest.advanceTimersByTimeAsync(60_000);
    await h2.store.getState().finishInterrupted(session.id);
    expect(h2.store.getState().stage).toBe('debrief');
    expect(h2.store.getState().session?.endedAt).toBe(lastT);
    await h2.store.getState().submitDebrief(REPORT);
    const stored = await h.repo.getSession(session.id);
    expect(stored?.status).toBe('completed');
    expect(stored?.endedAt).toBe(lastT);
  });

  it('records timed-only sessions for health-store sources and imports HR after the case', async () => {
    const healthStore = createFakeHealthStore((start, end) => ({
      source: 'healthkit',
      samples: [
        { t: start + 5_000, bpm: 82 },
        { t: start + 10_000, bpm: 90 },
        { t: end - 1_000, bpm: 76 },
      ],
      rr: [],
      externalHrv: [{ t: start + 30_000, metric: 'sdnn', ms: 42, source: 'healthkit' }],
    }));
    const timed = createTimedSource('healthkit', healthStore);
    const h = setup({ healthStore, getSource: () => timed });

    h.store.getState().beginSetup();
    h.store.getState().setProcedure(PROCEDURE);
    await h.store.getState().chooseSource('healthkit');
    expect(h.store.getState().timedOnly).toBe(true);
    await h.store.getState().connect();
    expect(h.store.getState().sensor).toEqual({ source: 'healthkit', name: 'Apple Health' });
    expect(h.store.getState().sensorStatus.message).toMatch(/imported from Apple Health after the case/);

    await h.store.getState().startBaseline(60); // needs live data
    expect(h.store.getState().stage).toBe('setup');
    h.store.getState().skipBaseline();
    await h.store.getState().startRecording();
    h.store.getState().markPhase('incision');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(h.store.getState().signalLost).toBe(false); // no live data expected
    await h.store.getState().endRecording();
    const id = h.store.getState().session!.id;

    const imported = await h.store.getState().importFromHealth(id);
    expect(imported).toBe(3);
    expect(h.store.getState().session?.samples.map((s) => s.bpm)).toEqual([82, 90, 76]);
    expect(h.store.getState().session?.externalHrv).toHaveLength(1);
    // Re-importing the same window adds nothing.
    expect(await h.store.getState().importFromHealth(id)).toBe(0);

    await h.store.getState().submitDebrief(REPORT);
    const [item] = await h.repo.listSessions();
    expect(item?.sampleCount).toBe(3);
    expect(item?.summary?.hr?.max).toBe(90);
  });

  it('re-summarises a completed session after a retrospective health import', async () => {
    // The strap delivered nothing (a health import never mixes into a strap's own data: SP-MOB-3).
    const h = setup();
    await recording(h);
    await h.store.getState().endRecording();
    const id = await h.store.getState().submitDebrief(REPORT);
    h.store.getState().reset();
    const before = (await h.repo.listSessions())[0]?.summary?.hr?.count;
    const added = await h.store.getState().importFromHealth(id);
    expect(added).toBe(1);
    const after = (await h.repo.listSessions())[0];
    expect(after?.summary?.hr?.count).toBe((before ?? 0) + 1);
  });

  it('refuses a health import while the case is still recording', async () => {
    const h = setup();
    const session = await recording(h);
    await expect(h.store.getState().importFromHealth(session.id)).rejects.toThrow(/End the case/);
  });

  it('auto-uploads after the debrief only when enabled and configured', async () => {
    const uploadSession = jest.fn(async () => undefined);
    const h = setup({
      uploadSession,
      settings: { autoUpload: true, researchServerUrl: 'https://research.example.edu', researchToken: 'spk_test' },
    });
    await recording(h);
    await h.store.getState().endRecording();
    await h.store.getState().submitDebrief(REPORT);
    expect(uploadSession).toHaveBeenCalledTimes(1);
    expect(uploadSession.mock.calls[0]).toEqual([expect.objectContaining({ status: 'completed' }), PROFILE]);

    const upload2 = jest.fn(async () => undefined);
    const h2 = setup({ uploadSession: upload2, settings: { autoUpload: true, researchToken: '' } });
    await recording(h2);
    await h2.store.getState().endRecording();
    await h2.store.getState().submitDebrief(REPORT);
    expect(upload2).not.toHaveBeenCalled();
  });

  // PRIV-3: withdrawn consent stops automatic upload even if the setting is still on.
  it('never auto-uploads once the profile records withdrawn consent', async () => {
    const uploadSession = jest.fn(async () => undefined);
    const h = setup({
      uploadSession,
      getProfile: async () => ({ ...PROFILE, consent: { version: 'PICF-1.0', givenAt: 1, withdrawnAt: 2 } }),
      settings: { autoUpload: true, researchServerUrl: 'https://research.example.edu', researchToken: 'spk_test' },
    });
    await recording(h);
    await h.store.getState().endRecording();
    await h.store.getState().submitDebrief(REPORT);
    expect(uploadSession).not.toHaveBeenCalled();
  });

  it('a failing auto-upload never breaks the debrief', async () => {
    const uploadSession = jest.fn(async () => {
      throw new Error('offline');
    });
    const h = setup({
      uploadSession,
      settings: { autoUpload: true, researchServerUrl: 'https://research.example.edu', researchToken: 'spk_test' },
    });
    await recording(h);
    await h.store.getState().endRecording();
    await expect(h.store.getState().submitDebrief(REPORT)).resolves.toEqual(expect.any(String));
    await jest.advanceTimersByTimeAsync(0);
    expect(h.store.getState().stage).toBe('done');
  });
});

// UX-10: researchers need to see whether a sensor sends beat-to-beat (RR) intervals before a study case.
describe('beat-to-beat (RR) tracking', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: START });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('records when data and RR intervals arrive, and resets on a new connection', async () => {
    const h = setup();
    await connected(h);
    expect(h.store.getState().streamSince).toBeNull();
    expect(h.store.getState().rrSeenAt).toBeNull();

    const t0 = Date.now();
    h.sensor.emit([{ t: t0, bpm: 70 }], []);
    expect(h.store.getState().streamSince).toBe(t0);
    expect(h.store.getState().rrSeenAt).toBeNull();

    await jest.advanceTimersByTimeAsync(2000);
    const t1 = Date.now();
    h.sensor.emit([{ t: t1, bpm: 71 }], [{ t: t1, ms: 845 }]);
    expect(h.store.getState().streamSince).toBe(t0);
    expect(h.store.getState().rrSeenAt).toBe(t1);

    await h.store.getState().connect('polar');
    expect(h.store.getState().streamSince).toBeNull();
    expect(h.store.getState().rrSeenAt).toBeNull();
  });
});
