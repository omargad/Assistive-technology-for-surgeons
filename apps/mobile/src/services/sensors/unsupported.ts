/**
 * A source that reports itself unsupported (e.g. native BLE on the web, or
 * Web Bluetooth in a browser without `navigator.bluetooth`).
 */
import type { SensorInfo } from '@surgeonpulse/core';
import type { HeartRateSource, SensorListener, SourceChoice } from './types';

export function createUnsupportedSource(kind: SourceChoice, label: string, reason: string): HeartRateSource {
  return {
    kind,
    label,
    canScan: false,
    async isSupported() {
      return false;
    },
    async requestPermissions() {
      return false;
    },
    scan() {
      return () => undefined;
    },
    async connect(): Promise<SensorInfo> {
      throw new Error(reason);
    },
    async start(listener: SensorListener) {
      listener.onStatus({ state: 'unsupported', message: reason });
    },
    async stop() {},
    async disconnect() {},
  };
}
