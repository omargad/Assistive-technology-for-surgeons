/**
 * Recording flow state machine (see `state/types.ts` for the diagram).
 *
 * This module is a factory with injected dependencies so the whole flow can
 * be tested with a fake sensor, the in-memory repository and fake timers;
 * `recording.ts` wires it to the real services.
 *
 * Data safety while recording
 * - The live session (full signals) is kept in memory.
 * - Every `flushIntervalMs` (5 s) newly ingested samples/RR are appended to
 *   storage, tracked with flushed indices into the session arrays. Incoming
 *   timestamps are clamped to be non-decreasing, so the arrays are append-only
 *   and the indices stay valid.
 * - Events and other metadata are persisted immediately.
 * - All writes go through one serial queue, so they reach storage in order.
 */
import {
  addEvent,
  computeBaseline,
  createId,
  createSession,
  removeEvent,
  sessionEnd,
  summarizeSession,
} from '@surgeonpulse/core';
import type {
  AppInfo,
  HeartRateSample,
  MarkerEvent,
  ParticipantProfile,
  ParticipantSnapshot,
  PhaseEvent,
  PhaseKind,
  RRInterval,
  SessionEvent,
  SurgicalSession,
} from '@surgeonpulse/core';
import { create } from 'zustand';
import type { HapticKind, KeepAwakeController } from '../services/feedback';
import { mergeHealthImport } from '../services/health/merge';
import type { HealthStore } from '../services/health/types';
import type { HeartRateSource, SensorListener, SensorStatus, SourceChoice } from '../services/sensors/types';
import type { SessionMeta, SessionRepository } from '../services/storage/types';
import { createSerialQueue } from '../services/util/serialQueue';
import type { RecordingState, RecordingStore, Settings } from './types';

export interface RecordingDeps {
  repository: SessionRepository;
  getSource(choice: SourceChoice): HeartRateSource;
  healthStore: HealthStore;
  getSettings(): Settings;
  /** Remember the chosen source/device for next time (optional). */
  updateSettings?(patch: Partial<Settings>): Promise<void> | void;
  getProfile(): Promise<ParticipantProfile | null>;
  appInfo(): AppInfo;
  tzOffsetMin(t: number): number;
  now(): number;
  haptic(kind: HapticKind): void;
  keepAwake: KeepAwakeController;
  /** Upload a just-completed session (called only when auto-upload is enabled and configured). */
  uploadSession?(session: SurgicalSession, profile: ParticipantProfile | null): Promise<unknown>;
  /** Notify listeners (e.g. the sessions list) that stored sessions changed. */
  onSessionsChanged?(): void;
  /** Flush interval for signals (ms). Default 5000. */
  flushIntervalMs?: number;
  /** No data for longer than this while recording sets `signalLost` (ms). Default 15 000. */
  signalLostMs?: number;
  /** Scan duration (ms). Default 15 000. */
  scanTimeoutMs?: number;
}

/** Participant code used if a case is recorded before onboarding saved a profile. */
export const UNASSIGNED_PARTICIPANT_CODE = 'UNASSIGNED';

const SAVE_ERROR = 'Saving to storage failed. Recording continues and saving will be retried.';

type SummaryOptions = NonNullable<Parameters<typeof summarizeSession>[1]>;

/** How much of a stored session's signal arrays has been written to storage. */
interface FlushCursor {
  id: string;
  samples: number;
  rr: number;
}

const DEFAULT_FLUSH_MS = 5_000;
const DEFAULT_SIGNAL_LOST_MS = 15_000;
const DEFAULT_SCAN_MS = 15_000;
const WATCHDOG_TICK_MS = 1_000;
const MIN_BASELINE_SEC = 10;
const MAX_BASELINE_SEC = 600;

const IDLE_STATUS: SensorStatus = { state: 'idle' };

export function initialRecordingState(logger: RecordingState['logger'] = 'team'): RecordingState {
  return {
    stage: 'idle',
    procedure: null,
    sourceChoice: null,
    devices: [],
    scanning: false,
    sensor: null,
    sensorStatus: IDLE_STATUS,
    baselineStartedAt: null,
    baselineDurationSec: 180,
    baseline: null,
    session: null,
    currentBpm: null,
    currentPhase: null,
    lastEvent: null,
    logger,
    signalLost: false,
    timedOnly: false,
    error: null,
  };
}

export function isTimedChoice(choice: string | null | undefined): choice is 'healthkit' | 'health-connect' {
  return choice === 'healthkit' || choice === 'health-connect';
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/** Profile fields copied into each session so sessions are self-describing. */
export function snapshotFromProfile(profile: ParticipantProfile | null): ParticipantSnapshot | undefined {
  if (!profile) return undefined;
  const snap: ParticipantSnapshot = {};
  if (profile.trainingLevel !== undefined) snap.trainingLevel = profile.trainingLevel;
  if (profile.specialty !== undefined) snap.specialty = profile.specialty;
  if (profile.yearsExperience !== undefined) snap.yearsExperience = profile.yearsExperience;
  if (profile.birthYear !== undefined) snap.birthYear = profile.birthYear;
  if (profile.maxHr !== undefined) snap.maxHr = profile.maxHr;
  if (profile.restingHr !== undefined) snap.restingHr = profile.restingHr;
  return Object.keys(snap).length > 0 ? snap : undefined;
}

/** Summary options derived from the participant profile (measured max HR wins over the age estimate). */
export function summaryOptionsFor(profile: ParticipantProfile | null): SummaryOptions {
  return profile?.maxHr !== undefined ? { maxHr: profile.maxHr } : {};
}

/** The phase in progress at the end of the event list (events are sorted by `t`). */
function lastPhase(events: readonly SessionEvent[]): PhaseKind | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as SessionEvent;
    if (e.type === 'phase') return e.phase;
  }
  return null;
}

/**
 * Clamp timestamps so the batch is non-decreasing and not before `floor`
 * (guards against wall-clock adjustments); non-finite times become `now`.
 */
function monotonic<T extends { t: number }>(items: readonly T[], floor: number, now: number): T[] {
  let last = floor;
  return items.map((item) => {
    let t = Number.isFinite(item.t) ? item.t : now;
    if (t < last) t = last;
    last = t;
    return t === item.t ? item : { ...item, t };
  });
}

function validBpm(samples: readonly HeartRateSample[]): number | null | undefined {
  const last = samples[samples.length - 1];
  if (!last) return undefined; // no sample in this batch: leave the display unchanged
  return Number.isFinite(last.bpm) && last.bpm > 0 ? last.bpm : null;
}

function cleanNote(note: string | undefined): string | undefined {
  const n = note?.trim();
  return n ? n : undefined;
}

export function createRecordingStore(deps: RecordingDeps) {
  const flushIntervalMs = deps.flushIntervalMs ?? DEFAULT_FLUSH_MS;
  const signalLostMs = deps.signalLostMs ?? DEFAULT_SIGNAL_LOST_MS;
  const scanTimeoutMs = deps.scanTimeoutMs ?? DEFAULT_SCAN_MS;
  const writes = createSerialQueue();

  /** Mutable runtime that does not belong in React state. */
  const rt = {
    source: null as HeartRateSource | null,
    stopScan: null as (() => void) | null,
    scanTimer: null as ReturnType<typeof setTimeout> | null,
    flushTimer: null as ReturnType<typeof setInterval> | null,
    watchdogTimer: null as ReturnType<typeof setInterval> | null,
    /** Set once the session row exists in storage; tracks what has been flushed. */
    cursor: null as FlushCursor | null,
    baselineSamples: [] as HeartRateSample[],
    baselineRr: [] as RRInterval[],
    lastDataAt: 0,
  };

  return create<RecordingStore>()((set, get) => {
    // -- helpers ------------------------------------------------------------

    function settings(): Settings {
      return deps.getSettings();
    }

    function feedback(kind: HapticKind): void {
      if (settings().haptics) deps.haptic(kind);
    }

    function notifySessionsChanged(): void {
      try {
        deps.onSessionsChanged?.();
      } catch {
        // listeners must not break the recording flow
      }
    }

    function clearScan(): void {
      const stop = rt.stopScan;
      rt.stopScan = null;
      if (rt.scanTimer !== null) clearTimeout(rt.scanTimer);
      rt.scanTimer = null;
      try {
        stop?.();
      } catch {
        // ignore
      }
    }

    function stopTimers(): void {
      if (rt.flushTimer !== null) clearInterval(rt.flushTimer);
      if (rt.watchdogTimer !== null) clearInterval(rt.watchdogTimer);
      rt.flushTimer = null;
      rt.watchdogTimer = null;
    }

    function startTimers(): void {
      stopTimers();
      rt.flushTimer = setInterval(() => {
        void flush();
      }, flushIntervalMs);
      rt.watchdogTimer = setInterval(checkSignal, WATCHDOG_TICK_MS);
    }

    function checkSignal(): void {
      const s = get();
      if (s.stage !== 'recording' || s.timedOnly || s.signalLost) return;
      if (deps.now() - rt.lastDataAt > signalLostMs) set({ signalLost: true });
    }

    /** Stop and disconnect the current source (never throws). */
    async function releaseSource(): Promise<void> {
      clearScan();
      const source = rt.source;
      rt.source = null;
      if (!source) return;
      try {
        await source.stop();
      } catch {
        // ignore
      }
      try {
        await source.disconnect();
      } catch {
        // ignore
      }
    }

    /** Append the part of `session` not yet covered by `cursor` (call inside the write queue). */
    async function appendPending(session: SurgicalSession, cursor: FlushCursor): Promise<void> {
      if (cursor.id !== session.id) return;
      const samples = session.samples.slice(cursor.samples);
      const rr = session.rr.slice(cursor.rr);
      if (samples.length === 0 && rr.length === 0) return;
      try {
        await deps.repository.appendSignals(session.id, samples, rr);
        cursor.samples += samples.length;
        cursor.rr += rr.length;
        if (get().error === SAVE_ERROR) set({ error: null });
      } catch {
        // Keep the data in memory and retry on the next flush.
        if (rt.cursor === cursor) set({ error: SAVE_ERROR });
      }
    }

    /** Flush the live session's new signals (serialised with metadata writes). */
    function flush(): Promise<void> {
      return writes.run(async () => {
        const { session } = get();
        const cursor = rt.cursor;
        if (session && cursor) await appendPending(session, cursor);
      });
    }

    function cursorFor(session: SurgicalSession): FlushCursor {
      return { id: session.id, samples: session.samples.length, rr: session.rr.length };
    }

    function persistMeta(id: string, patch: Partial<SessionMeta>): Promise<void> {
      return writes.run(async () => {
        try {
          await deps.repository.updateMeta(id, patch);
        } catch {
          set({ error: SAVE_ERROR });
        }
      });
    }

    function listenerFor(source: HeartRateSource): SensorListener {
      return {
        onData(samples, rr) {
          if (rt.source !== source) return;
          get().ingest(samples, rr);
        },
        onStatus(status) {
          if (rt.source !== source) return;
          set({ sensorStatus: status });
        },
      };
    }

    function rememberSource(patch: Partial<Settings>): void {
      try {
        void Promise.resolve(deps.updateSettings?.(patch)).catch(() => undefined);
      } catch {
        // ignore
      }
    }

    function loadSessionIntoState(session: SurgicalSession, stage: 'setup' | 'debrief'): void {
      rt.cursor = cursorFor(session);
      const source = session.sensor.source;
      set({
        ...initialRecordingState(get().logger),
        stage,
        session,
        procedure: session.procedure,
        baseline: session.baseline ?? null,
        currentPhase: lastPhase(session.events),
        sourceChoice: stage === 'debrief' && source !== 'import' ? source : null,
        timedOnly: isTimedChoice(source),
      });
    }

    function addSessionEvent(event: PhaseEvent | MarkerEvent): SurgicalSession | null {
      const s = get();
      if (s.stage !== 'recording' || !s.session) return null;
      const session = addEvent(s.session, event);
      set({
        session,
        lastEvent: event,
        ...(event.type === 'phase' ? { currentPhase: event.phase } : {}),
      });
      void persistMeta(session.id, { events: session.events });
      return session;
    }

    // -- store --------------------------------------------------------------

    return {
      ...initialRecordingState(),

      beginSetup() {
        const { stage } = get();
        if (stage !== 'idle' && stage !== 'done') return; // a flow (or a recovered session) is in progress
        stopTimers();
        rt.cursor = null;
        const s = get();
        // Keep a sensor that is already connected (e.g. paired from the sensors screen).
        const keep = rt.source
          ? {
              sourceChoice: s.sourceChoice,
              sensor: s.sensor,
              sensorStatus: s.sensorStatus,
              timedOnly: s.timedOnly,
              currentBpm: s.currentBpm,
            }
          : {};
        set({ ...initialRecordingState(s.logger), ...keep, stage: 'setup' });
      },

      setProcedure(procedure) {
        const s = get();
        set({ procedure });
        if (s.session && rt.cursor) {
          set({ session: { ...s.session, procedure } });
          void persistMeta(s.session.id, { procedure });
        }
      },

      async chooseSource(choice) {
        const s = get();
        if (s.sourceChoice === choice && rt.source) return;
        await releaseSource();
        const source = deps.getSource(choice);
        rt.source = source;
        set({
          sourceChoice: choice,
          timedOnly: isTimedChoice(choice),
          devices: [],
          scanning: false,
          sensor: null,
          sensorStatus: IDLE_STATUS,
          currentBpm: null,
          error: null,
        });
        rememberSource({ preferredSource: choice });
        let supported = false;
        try {
          supported = await source.isSupported();
        } catch {
          supported = false;
        }
        if (rt.source !== source || supported) return;
        const message = `${source.label} is not available on this device.`;
        set({ sensorStatus: { state: 'unsupported', message }, error: message });
      },

      async startScan(opts) {
        const source = rt.source;
        if (!source) {
          set({ error: 'Choose a sensor type first.' });
          return;
        }
        if (!source.canScan) return;
        get().stopScan();
        let granted = false;
        try {
          granted = await source.requestPermissions();
        } catch (error) {
          const message = errorMessage(error, 'Bluetooth is not available.');
          if (rt.source === source) set({ error: message, sensorStatus: { state: 'error', message } });
          return;
        }
        if (rt.source !== source) return;
        if (!granted) {
          const message = 'Bluetooth permission is needed to find your heart-rate sensor.';
          set({ error: message, sensorStatus: { state: 'permission-denied', message } });
          return;
        }
        const busy = ['connecting', 'connected', 'streaming', 'reconnecting'].includes(get().sensorStatus.state);
        set({
          devices: [],
          scanning: true,
          error: null,
          ...(busy ? {} : { sensorStatus: { state: 'scanning' } as SensorStatus }),
        });
        rt.stopScan = source.scan(
          (device) => {
            if (rt.source !== source || !get().scanning) return;
            const devices = get().devices.filter((d) => d.id !== device.id);
            devices.push(device);
            // Heart-rate devices first, then by signal strength.
            devices.sort(
              (a, b) =>
                Number(b.advertisesHeartRate) - Number(a.advertisesHeartRate) ||
                (b.rssi ?? -999) - (a.rssi ?? -999),
            );
            set({ devices });
          },
          { timeoutMs: scanTimeoutMs, showAll: opts?.showAll ?? false },
        );
        rt.scanTimer = setTimeout(() => get().stopScan(), scanTimeoutMs);
      },

      stopScan() {
        clearScan();
        const s = get();
        if (!s.scanning && s.sensorStatus.state !== 'scanning') return;
        set({ scanning: false, ...(s.sensorStatus.state === 'scanning' ? { sensorStatus: IDLE_STATUS } : {}) });
      },

      async connect(deviceId) {
        const source = rt.source;
        if (!source) {
          set({ error: 'Choose a sensor type first.' });
          return;
        }
        get().stopScan();
        const deviceName = deviceId ? get().devices.find((d) => d.id === deviceId)?.name : undefined;
        set({
          error: null,
          sensorStatus: deviceName ? { state: 'connecting', deviceName } : { state: 'connecting' },
        });
        try {
          // Web Bluetooth: requestPermissions resolves at once, so `connect` still runs within the user gesture.
          const granted = await source.requestPermissions();
          if (rt.source !== source) return;
          if (!granted) {
            const message = isTimedChoice(source.kind)
              ? `Allow access to heart rate in ${source.label} to import it after the case.`
              : 'Bluetooth permission is needed to connect to your heart-rate sensor.';
            set({ error: message, sensorStatus: { state: 'permission-denied', message } });
            return;
          }
          const sensor = await source.connect(deviceId);
          if (rt.source !== source) return;
          set({ sensor });
          rt.lastDataAt = deps.now();
          await source.start(listenerFor(source));
          if (source.kind === 'ble' || source.kind === 'web-bluetooth') {
            rememberSource({ preferredDeviceId: sensor.id ?? null, preferredDeviceName: sensor.name ?? null });
          }
        } catch (error) {
          if (rt.source !== source) return;
          const message = errorMessage(error, 'Could not connect to the sensor.');
          set({ error: message, sensorStatus: { state: 'error', message } });
        }
      },

      async startBaseline(durationSec) {
        const s = get();
        if (s.stage !== 'setup' && s.stage !== 'ready') return;
        if (s.timedOnly) {
          set({ error: 'A resting baseline needs a live heart-rate sensor. Skip it for this case.' });
          return;
        }
        const duration = Math.round(
          Math.min(MAX_BASELINE_SEC, Math.max(MIN_BASELINE_SEC, Number.isFinite(durationSec) ? durationSec : 180)),
        );
        rt.baselineSamples = [];
        rt.baselineRr = [];
        rt.lastDataAt = deps.now();
        set({
          stage: 'baseline',
          baselineStartedAt: deps.now(),
          baselineDurationSec: duration,
          baseline: null,
          error: null,
        });
        if (settings().keepAwake) deps.keepAwake.activate();
      },

      finishBaseline() {
        const s = get();
        if (s.stage !== 'baseline' || s.baselineStartedAt === null) return;
        const lastT = rt.baselineSamples[rt.baselineSamples.length - 1]?.t ?? 0;
        const end = Math.max(deps.now(), lastT + 1);
        let baseline = null;
        try {
          baseline = computeBaseline(rt.baselineSamples, rt.baselineRr, s.baselineStartedAt, end);
        } catch {
          baseline = null;
        }
        rt.baselineSamples = [];
        rt.baselineRr = [];
        set({
          stage: 'ready',
          baseline,
          error: baseline
            ? null
            : 'Not enough heart-rate data for a baseline. Your profile resting heart rate will be used if set.',
        });
      },

      skipBaseline() {
        const s = get();
        if (s.stage !== 'setup' && s.stage !== 'baseline') return;
        rt.baselineSamples = [];
        rt.baselineRr = [];
        set({ stage: 'ready', baseline: null, baselineStartedAt: null });
      },

      async startRecording() {
        let s = get();
        if (s.stage === 'baseline') {
          get().finishBaseline();
          s = get();
        }
        if (s.stage !== 'setup' && s.stage !== 'ready') return;
        if (!s.sensor) {
          set({ error: 'Connect a heart-rate source before starting.' });
          return;
        }
        const startedAt = deps.now();

        if (s.session && rt.cursor) {
          // Resuming an interrupted session: keep its id, data and events.
          if (s.session.endedAt !== undefined) {
            const { endedAt: _ended, ...rest } = s.session;
            set({ session: rest });
            void persistMeta(s.session.id, { endedAt: undefined });
          }
        } else {
          if (!s.procedure) {
            set({ error: 'Choose the procedure before starting.' });
            return;
          }
          let profile: ParticipantProfile | null = null;
          try {
            profile = await deps.getProfile();
          } catch {
            profile = null;
          }
          const snapshot = snapshotFromProfile(profile);
          const session = createSession({
            participantCode: profile?.code ?? UNASSIGNED_PARTICIPANT_CODE,
            procedure: s.procedure,
            sensor: s.sensor,
            app: deps.appInfo(),
            startedAt,
            tzOffsetMin: deps.tzOffsetMin(startedAt),
            ...(snapshot ? { participantSnapshot: snapshot } : {}),
            ...(s.baseline ? { baseline: s.baseline } : {}),
          });
          try {
            await writes.run(() => deps.repository.createSession(session));
          } catch (error) {
            set({ error: errorMessage(error, 'Could not create the session in storage.') });
            return;
          }
          rt.cursor = cursorFor(session);
          set({ session, currentPhase: null });
          notifySessionsChanged();
        }

        rt.lastDataAt = startedAt;
        set({ stage: 'recording', lastEvent: null, signalLost: false, error: null });
        startTimers();
        if (settings().keepAwake) deps.keepAwake.activate();
        feedback('success');
      },

      setLogger(logger) {
        set({ logger });
      },

      markPhase(phase, note) {
        const s = get();
        const text = cleanNote(note);
        const event: PhaseEvent = {
          id: createId(),
          t: deps.now(),
          type: 'phase',
          phase,
          loggedBy: s.logger,
          ...(text ? { note: text } : {}),
        };
        if (!addSessionEvent(event)) return;
        try {
          rt.source?.onPhase?.(phase);
        } catch {
          // simulator hook only
        }
        feedback('medium');
      },

      addMarker(marker, note) {
        const s = get();
        const text = cleanNote(note);
        const event: MarkerEvent = {
          id: createId(),
          t: deps.now(),
          type: 'marker',
          marker,
          loggedBy: s.logger,
          ...(text ? { note: text } : {}),
        };
        if (!addSessionEvent(event)) return;
        try {
          rt.source?.onMarker?.(marker);
        } catch {
          // simulator hook only
        }
        feedback(marker === 'complication' ? 'heavy' : 'light');
      },

      undoLastEvent() {
        const s = get();
        if (!s.session || !s.lastEvent) return;
        const session = removeEvent(s.session, s.lastEvent.id);
        set({ session, lastEvent: null, currentPhase: lastPhase(session.events) });
        void persistMeta(session.id, { events: session.events });
        feedback('light');
      },

      async endRecording() {
        const s = get();
        if (s.stage !== 'recording' || !s.session) return;
        stopTimers();
        await releaseSource();
        const endedAt = Math.max(deps.now(), s.session.startedAt);
        const session: SurgicalSession = { ...(get().session ?? s.session), endedAt };
        set({
          session,
          stage: 'debrief',
          lastEvent: null,
          signalLost: false,
          currentBpm: null,
          sensorStatus: IDLE_STATUS,
        });
        deps.keepAwake.deactivate();
        await flush();
        await persistMeta(session.id, { endedAt });
        feedback('success');
        notifySessionsChanged();
      },

      async submitDebrief(report) {
        const s = get();
        const session = s.session;
        if (s.stage !== 'debrief' || !session) throw new Error('There is no finished case waiting for a debrief.');
        const endedAt = session.endedAt ?? Math.max(deps.now(), session.startedAt);
        const completed: SurgicalSession = { ...session, endedAt, status: 'completed', postOp: report };
        await writes.run(() =>
          deps.repository.updateMeta(session.id, { postOp: report, status: 'completed', endedAt }),
        );
        let profile: ParticipantProfile | null = null;
        try {
          profile = await deps.getProfile();
        } catch {
          profile = null;
        }
        try {
          const summary = summarizeSession(completed, summaryOptionsFor(profile));
          await writes.run(() => deps.repository.saveSummary(session.id, summary));
        } catch {
          // The session is saved; the summary can be recomputed when it is opened.
        }
        set({ session: completed, stage: 'done', error: null });
        notifySessionsChanged();

        const cfg = settings();
        if (cfg.autoUpload && cfg.researchServerUrl && cfg.researchToken && deps.uploadSession) {
          // Fire and forget: the debrief must never wait on the network.
          void deps
            .uploadSession(completed, profile)
            .then(() => notifySessionsChanged())
            .catch(() => undefined);
        }
        return session.id;
      },

      async abort() {
        const s = get();
        if (s.stage === 'idle') return;
        stopTimers();
        clearScan();
        deps.keepAwake.deactivate();
        await releaseSource();
        const session = s.session;
        if (session && rt.cursor && session.status === 'recording') {
          await flush();
          const endedAt = session.endedAt ?? Math.max(deps.now(), session.startedAt);
          await persistMeta(session.id, { status: 'aborted', endedAt });
          notifySessionsChanged();
        }
        rt.cursor = null;
        rt.baselineSamples = [];
        rt.baselineRr = [];
        set(initialRecordingState(get().logger));
      },

      reset() {
        const s = get();
        stopTimers();
        clearScan();
        deps.keepAwake.deactivate();
        const session = s.session;
        const cursor = rt.cursor;
        if (s.stage === 'recording' && session && cursor) {
          // Never drop buffered data: final flush of the captured session.
          void writes.run(() => appendPending(session, cursor));
        }
        void releaseSource();
        rt.cursor = null;
        rt.baselineSamples = [];
        rt.baselineRr = [];
        set(initialRecordingState(s.logger));
      },

      async recoverInterrupted(sessionId) {
        const s = get();
        if (s.stage === 'recording') throw new Error('Finish the current case first.');
        const session = await deps.repository.getSession(sessionId);
        if (!session) throw new Error('That session could not be found.');
        stopTimers();
        await releaseSource();
        loadSessionIntoState(session, 'setup');
      },

      async finishInterrupted(sessionId) {
        const s = get();
        if (s.stage === 'recording') throw new Error('Finish the current case first.');
        const stored = await deps.repository.getSession(sessionId);
        if (!stored) throw new Error('That session could not be found.');
        stopTimers();
        await releaseSource();
        const endedAt = stored.endedAt ?? sessionEnd(stored);
        await writes.run(() => deps.repository.updateMeta(sessionId, { endedAt }));
        loadSessionIntoState({ ...stored, endedAt }, 'debrief');
        notifySessionsChanged();
      },

      async importFromHealth(sessionId) {
        const store = deps.healthStore;
        if (!store.source) throw new Error('Importing heart rate from a health app is not available on this device.');
        const s = get();
        if (s.session?.id === sessionId && s.stage === 'recording') {
          throw new Error('End the case before importing heart rate.');
        }
        if (!(await store.isAvailable())) throw new Error(`${store.label} is not available on this device.`);
        if (!(await store.requestAccess())) throw new Error(`Access to heart rate in ${store.label} was not granted.`);

        const active = get().session?.id === sessionId ? get().session : null;
        const session = active ?? (await deps.repository.getSession(sessionId));
        if (!session) throw new Error('That session could not be found.');
        const start = session.startedAt;
        const end = session.endedAt ?? Math.max(sessionEnd(session), deps.now());
        const result = await store.importRange(start, end);
        const merged = mergeHealthImport(session, result);
        const changed = merged.addedSamples + merged.addedRr + merged.addedHrv > 0;
        if (changed) {
          await writes.run(() => deps.repository.saveSession(merged.session));
          if (merged.session.status !== 'recording') {
            try {
              const profile = await deps.getProfile();
              const summary = summarizeSession(merged.session, summaryOptionsFor(profile));
              await writes.run(() => deps.repository.saveSummary(sessionId, summary));
            } catch {
              // summary is recomputed on open if this fails
            }
          }
          if (get().session?.id === sessionId) {
            rt.cursor = cursorFor(merged.session);
            set({ session: merged.session });
          }
          notifySessionsChanged();
        }
        return merged.addedSamples;
      },

      ingest(samples, rr) {
        const s = get();
        if (s.stage === 'idle' || (samples.length === 0 && rr.length === 0)) return;
        rt.lastDataAt = deps.now();
        const patch: Partial<RecordingState> = {};
        const bpm = validBpm(samples);
        if (bpm !== undefined) patch.currentBpm = bpm;
        if (s.signalLost) patch.signalLost = false;

        if (s.stage === 'baseline') {
          for (const x of samples) rt.baselineSamples.push(x);
          for (const x of rr) rt.baselineRr.push(x);
        } else if (s.stage === 'recording' && s.session) {
          let session = s.session;
          const lastSampleT = session.samples[session.samples.length - 1]?.t ?? -Infinity;
          const lastRrT = session.rr[session.rr.length - 1]?.t ?? -Infinity;
          const now = deps.now();
          const newSamples = monotonic(samples, lastSampleT, now);
          const newRr = monotonic(rr, lastRrT, now);
          session = {
            ...session,
            samples: newSamples.length > 0 ? session.samples.concat(newSamples) : session.samples,
            rr: newRr.length > 0 ? session.rr.concat(newRr) : session.rr,
          };
          patch.session = session;
        }
        set(patch);
      },
    };
  });
}
