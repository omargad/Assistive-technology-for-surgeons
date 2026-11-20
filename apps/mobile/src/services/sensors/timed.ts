/**
 * "Timed" source for health-store choices (Apple Health / Health Connect).
 *
 * These are not live sources: the surgeon's watch records heart rate into the
 * platform health store and the app imports it for the session window after
 * the case. This source therefore never delivers data; it reports a
 * `connected` status with an explanatory message so the live screen can show
 * elapsed time and event buttons only.
 */
import type { SensorInfo } from '@surgeonpulse/core';
import type { HealthStore } from '../health/types';
import type { HeartRateSource, SensorListener, SourceChoice } from './types';

export type TimedChoice = Extract<SourceChoice, 'healthkit' | 'health-connect'>;

export function timedMessage(label: string): string {
  return `Heart rate will be imported from ${label} after the case.`;
}

export function createTimedSource(kind: TimedChoice, store: HealthStore): HeartRateSource {
  let listener: SensorListener | null = null;
  const label = store.label;
  return {
    kind,
    label,
    canScan: false,
    async isSupported() {
      if (store.source !== kind) return false;
      try {
        return await store.isAvailable();
      } catch {
        return false;
      }
    },
    async requestPermissions() {
      try {
        return await store.requestAccess();
      } catch {
        return false;
      }
    },
    scan() {
      return () => undefined;
    },
    async connect(): Promise<SensorInfo> {
      if (store.source !== kind) throw new Error(`${label} is not available on this device.`);
      return { source: kind, name: label };
    },
    async start(next: SensorListener) {
      listener = next;
      listener.onStatus({ state: 'connected', deviceName: label, message: timedMessage(label) });
    },
    async stop() {},
    async disconnect() {
      try {
        listener?.onStatus({ state: 'idle', deviceName: label });
      } catch {
        // ignore
      }
      listener = null;
    },
  };
}
