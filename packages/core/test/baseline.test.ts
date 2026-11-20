import { describe, expect, it } from 'vitest';
import { computeBaseline } from '../src/analytics/baseline';
import type { HeartRateSample, RRInterval } from '../src/types';

describe('computeBaseline', () => {
  // 5 samples in the window [0, 5000): 60, 62, 64, 66, 68 → mean 64; the sample at t = 5000 is outside.
  const samples: HeartRateSample[] = [
    { t: -1000, bpm: 100 },
    { t: 0, bpm: 60 },
    { t: 1000, bpm: 62 },
    { t: 2000, bpm: 64 },
    { t: 3000, bpm: 66 },
    { t: 4000, bpm: 68 },
    { t: 5000, bpm: 120 },
  ];

  it('uses HR in [start, end) and HRV from computeHrv with minIntervals 20', () => {
    // 20 beats alternating 950 / 1000 ms delivered every 200 ms inside the window:
    // RMSSD = 50; mean 975, deviations ±25 → SDNN = √(20·625/19)
    const rr: RRInterval[] = Array.from({ length: 20 }, (_, i) => ({ t: i * 200, ms: i % 2 === 0 ? 950 : 1000 }));
    rr.push({ t: 5000, ms: 400 }); // outside the window, would otherwise be an artefact
    const b = computeBaseline(samples, rr, 0, 5000);
    expect(b).not.toBeNull();
    expect(b!.source).toBe('measured');
    expect(b!.startedAt).toBe(0);
    expect(b!.endedAt).toBe(5000);
    expect(b!.restingHr).toBe(64);
    expect(b!.rmssd).toBe(50);
    expect(b!.sdnn).toBeCloseTo(Math.sqrt((20 * 625) / 19), 10);
  });

  it('omits rmssd/sdnn when there are fewer than 20 valid intervals', () => {
    const rr: RRInterval[] = Array.from({ length: 19 }, (_, i) => ({ t: i * 200, ms: i % 2 === 0 ? 950 : 1000 }));
    const b = computeBaseline(samples, rr, 0, 5000);
    expect(b).toEqual({ startedAt: 0, endedAt: 5000, restingHr: 64, source: 'measured' });
    expect('rmssd' in b!).toBe(false);
    expect('sdnn' in b!).toBe(false);
  });

  it('returns null when the window has no valid HR', () => {
    expect(computeBaseline(samples, [], 10000, 20000)).toBeNull();
    expect(computeBaseline([{ t: 0, bpm: 0 }], [], 0, 1000)).toBeNull();
  });
});
