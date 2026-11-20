/**
 * Health-store import — fallback for platforms without a health store (the
 * web). Metro resolves `index.ios.ts` / `index.android.ts` on native builds,
 * so the HealthKit and Health Connect native modules never reach the web bundle.
 */
import type { HealthImportResult, HealthStore } from './types';

export const healthStore: HealthStore = {
  source: null,
  label: 'Health data',
  async isAvailable() {
    return false;
  },
  async requestAccess() {
    return false;
  },
  async importRange(): Promise<HealthImportResult> {
    throw new Error('Importing heart rate from a health app is not available on this platform.');
  },
};
