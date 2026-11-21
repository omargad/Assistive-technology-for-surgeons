/// <reference types="jest" />
/**
 * Registry on iOS (jest-expo's default platform): BLE strap first, then Apple
 * Health, then the simulator. Native modules are mocked.
 */
import { availableSources, getSource, isLiveChoice } from '../registry';

jest.mock('react-native-ble-plx', () => ({
  BleManager: jest.fn(() => ({ state: async () => 'PoweredOn' })),
  State: { Unsupported: 'Unsupported', PoweredOn: 'PoweredOn' },
}));
jest.mock('@kingstinct/react-native-healthkit', () => ({
  isHealthDataAvailableAsync: jest.fn(async () => true),
  requestAuthorization: jest.fn(async () => true),
  queryQuantitySamples: jest.fn(async () => []),
  queryHeartbeatSeriesSamples: jest.fn(async () => []),
}));

describe('sensor registry (iOS)', () => {
  it('lists sources in display order with support flags', async () => {
    const options = await availableSources();
    expect(options.map((o) => [o.choice, o.supported, o.live])).toEqual([
      ['ble', true, true],
      ['healthkit', true, false],
      ['simulated', true, true],
    ]);
    expect(options.every((o) => o.label.length > 0 && o.description.length > 0)).toBe(true);
  });

  it('returns one shared instance per choice and timed sources for health stores', async () => {
    expect(getSource('ble')).toBe(getSource('ble'));
    const timed = getSource('healthkit');
    expect(timed.kind).toBe('healthkit');
    await expect(timed.connect()).resolves.toEqual({ source: 'healthkit', name: 'Apple Health' });
    expect(isLiveChoice('healthkit')).toBe(false);
    expect(isLiveChoice('simulated')).toBe(true);
  });

  it('reports sources of other platforms as unsupported', async () => {
    await expect(getSource('web-bluetooth').isSupported()).resolves.toBe(false);
    await expect(getSource('health-connect').isSupported()).resolves.toBe(false);
  });
});

describe('sensor registry (Android: Health Connect)', () => {
  it('describes Health Connect without promising any vendor (support varies by vendor)', async () => {
    let options: Awaited<ReturnType<typeof availableSources>> = [];
    await jest.isolateModulesAsync(async () => {
      jest.doMock('../../health', () => ({
        healthStore: { source: 'health-connect', label: 'Health Connect', isAvailable: async () => true },
      }));
      options = await (require('../registry') as typeof import('../registry')).availableSources();
    });
    const hc = options.find((o) => o.choice === 'health-connect');
    expect(hc?.label).toBe('Smartwatch (via Health Connect)');
    expect(hc?.description).toMatch(/writes to Health Connect .*support varies by vendor/);
  });
});
