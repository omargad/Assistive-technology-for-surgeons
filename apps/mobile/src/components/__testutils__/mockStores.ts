/// <reference types="jest" />
/**
 * Test doubles for the zustand stores (`@/state/*`). Each factory returns a
 * real zustand store whose actions are `jest.fn()`s, so screens can be
 * rendered with any state (`store.setState`) and actions asserted on.
 *
 * Usage (inside a jest.mock factory, which may only reference `require`):
 *   jest.mock('@/state/recording', () => ({
 *     useRecording: require('@/components/__testutils__/mockStores').makeRecordingStore(),
 *   }));
 */
import { create } from 'zustand';

import type { ParticipantProfile, SurgicalSession } from '@surgeonpulse/core';

import type { RecordingState, RecordingStore, Settings, SettingsStore, SessionsStore } from '@/state/types';

export const TEST_SETTINGS: Settings = {
  baselineDurationSec: 180,
  keepAwake: true,
  haptics: true,
  preferredSource: 'simulated',
  preferredDeviceId: null,
  preferredDeviceName: null,
  orModeDark: true,
  showLiveHr: true,
  researchServerUrl: '',
  researchToken: '',
  autoUpload: false,
  onboardingComplete: true,
};

export const INITIAL_RECORDING_STATE: RecordingState = {
  stage: 'idle',
  procedure: null,
  sourceChoice: null,
  devices: [],
  scanning: false,
  sensor: null,
  sensorStatus: { state: 'idle' },
  baselineStartedAt: null,
  baselineDurationSec: 180,
  baseline: null,
  session: null,
  currentBpm: null,
  currentPhase: null,
  lastEvent: null,
  logger: 'self',
  signalLost: false,
  streamSince: null,
  rrSeenAt: null,
  timedOnly: false,
  error: null,
};

const asyncNoop = () => jest.fn(async () => undefined);

export function makeRecordingStore() {
  return create<RecordingStore>()(() => ({
    ...INITIAL_RECORDING_STATE,
    beginSetup: jest.fn(),
    setProcedure: jest.fn(),
    chooseSource: asyncNoop(),
    startScan: asyncNoop(),
    stopScan: jest.fn(),
    connect: asyncNoop(),
    startBaseline: asyncNoop(),
    finishBaseline: jest.fn(),
    skipBaseline: jest.fn(),
    startRecording: asyncNoop(),
    setLogger: jest.fn(),
    markPhase: jest.fn(),
    addMarker: jest.fn(),
    undoLastEvent: jest.fn(),
    endRecording: asyncNoop(),
    submitDebrief: jest.fn(async () => 'session-1'),
    abort: asyncNoop(),
    reset: jest.fn(),
    recoverInterrupted: asyncNoop(),
    finishInterrupted: asyncNoop(),
    importFromHealth: jest.fn(async () => 0),
    ingest: jest.fn(),
  }));
}

export function makeSettingsStore() {
  return create<SettingsStore>()(() => ({
    settings: { ...TEST_SETTINGS },
    loaded: true,
    load: asyncNoop(),
    update: asyncNoop(),
  }));
}

export function makeSessionsStore(profile: ParticipantProfile | null = { code: 'SP-014' }) {
  return create<SessionsStore>()(() => ({
    items: [],
    profile,
    loading: false,
    refresh: asyncNoop(),
    saveProfile: asyncNoop(),
    deleteSession: asyncNoop(),
    deleteAll: asyncNoop(),
    loadDemoData: asyncNoop(),
    removeDemoData: jest.fn(async () => 0),
    importBundle: jest.fn(async () => ({ imported: 0, warnings: [] })),
  }));
}

/** A live session with `minutes` of 1-Hz heart-rate data ending at `now`. */
export function makeLiveSession(now: number, minutes = 12): SurgicalSession {
  const startedAt = now - minutes * 60_000;
  const samples = Array.from({ length: minutes * 60 }, (_, i) => ({
    t: startedAt + i * 1000,
    bpm: 72 + Math.round(10 * Math.sin(i / 60)),
  }));
  return {
    schemaVersion: 1,
    id: 'session-1',
    participantCode: 'SP-014',
    procedure: { name: 'Laparoscopic cholecystectomy', catalogId: 'lap-chole', specialty: 'General surgery', approach: 'laparoscopic' },
    startedAt,
    status: 'recording',
    sensor: { source: 'simulated', name: 'Simulator' },
    app: { version: '0.1.0', platform: 'ios' },
    samples,
    rr: [],
    events: [],
  };
}
