/**
 * Fallback BLE source for platforms without a Bluetooth implementation.
 *
 * Resolution order: Metro picks `ble.native.ts` (iOS/Android) or `ble.web.ts`
 * (web) before this file; TypeScript type-checks imports of `./ble` against
 * this file, so its exports define the shape every variant must provide.
 */
import { createUnsupportedSource } from './unsupported';
import type { HeartRateSource, SourceChoice } from './types';

/** The source choice this platform's BLE implementation provides. */
export const BLE_CHOICE: SourceChoice = 'ble';

export function createBleSource(): HeartRateSource {
  return createUnsupportedSource(
    'ble',
    'Bluetooth heart-rate sensor',
    'Bluetooth heart-rate sensors are not supported on this platform.',
  );
}
