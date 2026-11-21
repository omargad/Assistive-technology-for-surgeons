import type {
  Baseline,
  EventLogger,
  HeartRateSample,
  MarkerKind,
  ParticipantProfile,
  PhaseKind,
  PostOpReport,
  ProcedureInfo,
  RRInterval,
  SensorInfo,
  SessionEvent,
  SurgicalSession,
} from '@surgeonpulse/core';
import type { SessionListItem } from '../services/storage/types';
import type { DiscoveredDevice, SensorStatus, SourceChoice } from '../services/sensors/types';

/**
 * Recording flow (state machine):
 *
 *   idle ──beginSetup──▶ setup ──startBaseline──▶ baseline ──finishBaseline──▶ ready
 *                          │                         │ skipBaseline                │
 *                          └──────skipBaseline───────┴─────────────────────────────┤
 *                                                                                  ▼
 *   idle ◀──reset── done ◀──submitDebrief── debrief ◀──endRecording── recording ◀─startRecording
 *
 *   abort() from any non-idle stage → idle (session marked 'aborted' if it was created).
 */
export type RecordingStage = 'idle' | 'setup' | 'baseline' | 'ready' | 'recording' | 'debrief' | 'done';

export interface RecordingState {
  stage: RecordingStage;
  procedure: ProcedureInfo | null;
  sourceChoice: SourceChoice | null;
  devices: DiscoveredDevice[];
  scanning: boolean;
  sensor: SensorInfo | null;
  sensorStatus: SensorStatus;
  /** Baseline capture window (epoch ms). */
  baselineStartedAt: number | null;
  baselineDurationSec: number;
  baseline: Baseline | null;
  /** The live session (full signals kept in memory; flushed to storage every few seconds). */
  session: SurgicalSession | null;
  /** Latest HR for the big display. */
  currentBpm: number | null;
  currentPhase: PhaseKind | null;
  /** Most recent event that can still be undone (cleared after ~10 s by the UI). */
  lastEvent: SessionEvent | null;
  /** Who is tapping the event buttons right now (sterile surgeon vs a team member). */
  logger: Extract<EventLogger, 'self' | 'team'>;
  /** True when no data has arrived for > 15 s while recording (live sources only). */
  signalLost: boolean;
  /** When data first arrived from the current sensor connection (epoch ms), or null before any. */
  streamSince: number | null;
  /** When beat-to-beat (RR) intervals last arrived (epoch ms), or null if none yet on this connection. */
  rrSeenAt: number | null;
  /** True for health-store sources: no live HR, data imported after the case. */
  timedOnly: boolean;
  error: string | null;
}

export interface RecordingActions {
  beginSetup(): void;
  setProcedure(procedure: ProcedureInfo): void;
  chooseSource(choice: SourceChoice): Promise<void>;
  startScan(opts?: { showAll?: boolean }): Promise<void>;
  stopScan(): void;
  /** Connect to a device (BLE id) or start the simulator / web chooser. */
  connect(deviceId?: string): Promise<void>;
  startBaseline(durationSec: number): Promise<void>;
  /** Computes the Baseline from data captured since startBaseline. */
  finishBaseline(): void;
  skipBaseline(): void;
  /** Creates the session in storage and begins recording. */
  startRecording(): Promise<void>;
  setLogger(logger: Extract<EventLogger, 'self' | 'team'>): void;
  markPhase(phase: PhaseKind, note?: string): void;
  addMarker(marker: MarkerKind, note?: string): void;
  undoLastEvent(): void;
  /** Stops the sensor, sets endedAt, persists, moves to 'debrief'. */
  endRecording(): Promise<void>;
  /** Saves the post-op report, marks session 'completed', computes & caches the summary. Returns the session id. */
  submitDebrief(report: PostOpReport): Promise<string>;
  /** Abandon the current flow. */
  abort(): Promise<void>;
  reset(): void;
  /** Resume an interrupted session (app was killed mid-case) — loads it and re-enters 'setup' so a source can be reconnected; startRecording then continues the same session. */
  recoverInterrupted(sessionId: string): Promise<void>;
  /** Close an interrupted session without resuming (sets endedAt to its last data point and moves to 'debrief'). */
  finishInterrupted(sessionId: string): Promise<void>;
  /** For timed (health-store) sessions or retrospective fixes: import HR from the platform health store for the session window, merge, re-summarise. Returns number of samples imported. */
  importFromHealth(sessionId: string): Promise<number>;
  /** Internal: called by the sensor listener. Exposed for tests. */
  ingest(samples: HeartRateSample[], rr: RRInterval[]): void;
}

export type RecordingStore = RecordingState & RecordingActions;

export interface Settings {
  baselineDurationSec: number; // default 180
  keepAwake: boolean; // default true
  haptics: boolean; // default true
  preferredSource: SourceChoice | null;
  preferredDeviceId: string | null;
  preferredDeviceName: string | null;
  /** Theme override for the live "OR mode" screen. */
  orModeDark: boolean; // default true
  /**
   * Show the heart rate (digits, zone, sparkline) on the live screen, which the theatre team can see.
   * When false the HR is still recorded; the live screen shows the clock, sensor status and event buttons only.
   */
  showLiveHr: boolean; // default true
  researchServerUrl: string;
  /** Enrolment token issued by the research team (stored locally; never logged). */
  researchToken: string;
  /** Upload completed sessions automatically after the debrief. */
  autoUpload: boolean; // default false
  onboardingComplete: boolean;
}

export interface SettingsStore {
  settings: Settings;
  loaded: boolean;
  load(): Promise<void>;
  update(patch: Partial<Settings>): Promise<void>;
}

export interface SessionsStore {
  items: SessionListItem[];
  profile: ParticipantProfile | null;
  loading: boolean;
  refresh(): Promise<void>;
  saveProfile(profile: ParticipantProfile): Promise<void>;
  deleteSession(id: string): Promise<void>;
  deleteAll(): Promise<void>;
  /** Load a simulated history for demos/training (marks sessions with tag 'demo'). */
  loadDemoData(): Promise<void>;
  /** Import an export bundle (JSON text). Returns counts + warnings. */
  importBundle(text: string): Promise<{ imported: number; warnings: string[] }>;
}
