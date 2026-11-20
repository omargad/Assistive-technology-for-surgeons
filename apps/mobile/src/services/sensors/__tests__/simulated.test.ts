/// <reference types="jest" />
import { createSimulatedSource } from '../simulated';
import type { SensorListener, SensorStatus } from '../types';

beforeEach(() => jest.useFakeTimers({ now: new Date('2026-03-02T08:00:00.000Z') }));
afterEach(() => jest.useRealTimers());

describe('simulated source', () => {
  it('streams ~1 Hz heart rate and responds to markers', async () => {
    const source = createSimulatedSource({ seed: 7, restingHr: 65 });
    await expect(source.isSupported()).resolves.toBe(true);
    await expect(source.connect()).resolves.toEqual({ source: 'simulated', name: 'Simulator' });

    const samples: number[] = [];
    const statuses: SensorStatus[] = [];
    const listener: SensorListener = {
      onData: (s) => samples.push(...s.map((x) => x.bpm)),
      onStatus: (s) => statuses.push(s),
    };
    await source.start(listener);
    expect(statuses[0]).toMatchObject({ state: 'streaming', deviceName: 'Simulator' });

    await jest.advanceTimersByTimeAsync(120_000);
    expect(samples.length).toBeGreaterThanOrEqual(115);
    expect(samples.length).toBeLessThanOrEqual(122);
    const before = samples.slice(-30).reduce((a, b) => a + b, 0) / 30;

    source.onPhase?.('critical');
    source.onMarker?.('complication');
    await jest.advanceTimersByTimeAsync(180_000);
    const after = samples.slice(-30).reduce((a, b) => a + b, 0) / 30;
    expect(after).toBeGreaterThan(before);

    await source.stop();
    const n = samples.length;
    await jest.advanceTimersByTimeAsync(10_000);
    expect(samples.length).toBe(n);
    await source.disconnect();
  });
});
