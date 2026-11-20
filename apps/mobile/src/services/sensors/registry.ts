/**
 * Which heart-rate sources exist on this platform, and the single instance of
 * each. Platform differences are resolved by Metro's file suffixes:
 *
 * | Platform | `./ble` resolves to | `../health` resolves to |
 * | -------- | ------------------- | ----------------------- |
 * | iOS      | ble.native.ts (ble) | index.ios.ts (Apple Health) |
 * | Android  | ble.native.ts (ble) | index.android.ts (Health Connect) |
 * | Web      | ble.web.ts (web-bluetooth) | index.ts (none) |
 *
 * so the web bundle never contains native BLE or health-store modules.
 */
import { healthStore } from '../health';
import { BLE_CHOICE, createBleSource } from './ble';
import { createSimulatedSource } from './simulated';
import { createTimedSource } from './timed';
import type { TimedChoice } from './timed';
import type { HeartRateSource, SourceChoice } from './types';
import { createUnsupportedSource } from './unsupported';

export interface SourceOption {
  choice: SourceChoice;
  label: string;
  description: string;
  supported: boolean;
  /** True when the source streams heart rate live during the case. */
  live: boolean;
}

const LABELS: Record<SourceChoice, { label: string; description: string }> = {
  ble: {
    label: 'Bluetooth heart-rate strap',
    description:
      'Polar H10, Garmin HRM, Wahoo TICKR or any strap using the standard Bluetooth Heart Rate profile. ' +
      'Records beat-to-beat (RR) intervals for HRV.',
  },
  'web-bluetooth': {
    label: 'Bluetooth heart-rate strap (browser)',
    description:
      'Connects to a chest strap from Chrome or Edge using Web Bluetooth. Keep this tab open and visible while recording.',
  },
  healthkit: {
    label: 'Apple Watch (via Apple Health)',
    description:
      'No live heart rate. Start a workout on the watch; heart rate is imported from Apple Health after the case.',
  },
  'health-connect': {
    label: 'Smartwatch (via Health Connect)',
    description:
      'No live heart rate. Wear OS, Fitbit, Samsung or Garmin data synced to Health Connect is imported after the case.',
  },
  simulated: {
    label: 'Simulator (demo)',
    description: 'Generates realistic heart-rate data for demos and training. Not real data.',
  },
};

const instances = new Map<SourceChoice, HeartRateSource>();

function isTimedChoice(choice: SourceChoice): choice is TimedChoice {
  return choice === 'healthkit' || choice === 'health-connect';
}

function createSource(choice: SourceChoice): HeartRateSource {
  if (choice === 'simulated') return createSimulatedSource();
  if (isTimedChoice(choice)) {
    if (healthStore.source === choice) return createTimedSource(choice, healthStore);
    return createUnsupportedSource(choice, LABELS[choice].label, `${LABELS[choice].label} is not available on this device.`);
  }
  if (choice === BLE_CHOICE) return createBleSource();
  return createUnsupportedSource(choice, LABELS[choice].label, `${LABELS[choice].label} is not available on this platform.`);
}

/**
 * The source for `choice` (one shared instance per choice, so a connection is
 * never orphaned). Health-store choices return a no-op "timed" source.
 */
export function getSource(choice: SourceChoice): HeartRateSource {
  let source = instances.get(choice);
  if (!source) {
    source = createSource(choice);
    instances.set(choice, source);
  }
  return source;
}

/** True for sources that stream live heart rate (false for health-store imports). */
export function isLiveChoice(choice: SourceChoice): boolean {
  return !isTimedChoice(choice);
}

async function supported(source: HeartRateSource): Promise<boolean> {
  try {
    return await source.isSupported();
  } catch {
    return false;
  }
}

/**
 * Sources offered on this platform, in display order:
 * Bluetooth (native or browser), then the platform health store (if any),
 * then the simulator.
 */
export async function availableSources(): Promise<SourceOption[]> {
  const choices: SourceChoice[] = [BLE_CHOICE];
  if (healthStore.source) choices.push(healthStore.source);
  choices.push('simulated');
  return Promise.all(
    choices.map(async (choice) => ({
      choice,
      ...LABELS[choice],
      supported: await supported(getSource(choice)),
      live: isLiveChoice(choice),
    })),
  );
}
