/**
 * Simulated heart-rate source for demos, training and automated tests. Runs on
 * every platform (including the web) using the core physiological simulator,
 * ticked once per second with the wall clock. Tapping a phase or marker in the
 * live screen is forwarded here so the simulated heart rate responds (e.g. a
 * "Complication" visibly raises HR).
 */
import { createLiveSimulator } from '@surgeonpulse/core';
import type { MarkerKind, PhaseKind, SensorInfo } from '@surgeonpulse/core';
import type { HeartRateSource, SensorListener, SensorStatus } from './types';

type LiveSimulator = ReturnType<typeof createLiveSimulator>;

export const SIMULATOR_NAME = 'Simulator';

export interface SimulatedSourceOptions {
  /** Simulator seed (default: random, so each demo differs). */
  seed?: number;
  restingHr?: number;
  reactivity?: number;
  /** Tick interval in ms (default 1000). */
  intervalMs?: number;
  now?: () => number;
}

export function createSimulatedSource(options: SimulatedSourceOptions = {}): HeartRateSource {
  const intervalMs = options.intervalMs ?? 1000;
  const now = options.now ?? Date.now;

  let sim: LiveSimulator | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let listener: SensorListener | null = null;
  let connected = false;

  function status(state: SensorStatus['state'], lastSampleAt?: number): SensorStatus {
    const s: SensorStatus = { state, deviceName: SIMULATOR_NAME, battery: 100, contact: true };
    if (lastSampleAt !== undefined) s.lastSampleAt = lastSampleAt;
    return s;
  }

  function tick(): void {
    if (!sim || !listener) return;
    try {
      const t = now();
      const { samples, rr } = sim.tick(t);
      if (samples.length === 0 && rr.length === 0) return;
      listener.onData(samples, rr);
    } catch {
      // A simulator hiccup must not crash the app.
    }
  }

  function clearTimer(): void {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  const source: HeartRateSource = {
    kind: 'simulated',
    label: 'Simulator (demo data)',
    canScan: false,
    async isSupported() {
      return true;
    },
    async requestPermissions() {
      return true;
    },
    scan() {
      return () => undefined;
    },
    async connect(): Promise<SensorInfo> {
      connected = true;
      return { source: 'simulated', name: SIMULATOR_NAME };
    },
    async start(next: SensorListener) {
      if (!connected) await source.connect();
      clearTimer();
      listener = next;
      const opts: { seed: number; startedAt: number; restingHr?: number; reactivity?: number } = {
        seed: options.seed ?? Math.floor(Math.random() * 2 ** 31),
        startedAt: now(),
      };
      if (options.restingHr !== undefined) opts.restingHr = options.restingHr;
      if (options.reactivity !== undefined) opts.reactivity = options.reactivity;
      sim = createLiveSimulator(opts);
      listener.onStatus(status('streaming'));
      timer = setInterval(tick, intervalMs);
    },
    async stop() {
      clearTimer();
    },
    async disconnect() {
      clearTimer();
      if (listener) {
        try {
          listener.onStatus({ state: 'disconnected', deviceName: SIMULATOR_NAME });
        } catch {
          // ignore
        }
      }
      listener = null;
      sim = null;
      connected = false;
    },
    onPhase(phase: PhaseKind) {
      sim?.setPhase(phase);
    },
    onMarker(marker: MarkerKind) {
      sim?.trigger(marker);
    },
  };
  return source;
}
