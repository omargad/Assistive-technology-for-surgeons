/**
 * Spec-conformance and robustness checks found in review.
 *
 * Every test here asserts behaviour that SPEC.md requires. The tests failed
 * against the implementation when they were written (each one names the rule it
 * checks), so a failure here is a known bug, not a flaky test. Once a bug is
 * fixed, its test turns green and stays as a regression guard.
 */
import { describe, expect, it } from 'vitest';
import { cleanRr } from '../src/analytics/rr';
import { mean, median, percentile } from '../src/analytics/stats';
import { summarizeSession } from '../src/analytics/summary';
import { timeInZones, zonesFromMaxHr } from '../src/analytics/zones';
import type { HeartRateSample, RRInterval, SurgicalSession } from '../src/types';

const S = Date.UTC(2026, 0, 5, 8, 0);

/** Paths of every NaN / ±Infinity number inside `x`. */
function nonFinitePaths(x: unknown, path = '$', out: string[] = []): string[] {
  if (typeof x === 'number' && !Number.isFinite(x)) out.push(`${path}=${String(x)}`);
  else if (Array.isArray(x)) x.forEach((v, i) => nonFinitePaths(v, `${path}[${i}]`, out));
  else if (x !== null && typeof x === 'object') {
    for (const [k, v] of Object.entries(x)) nonFinitePaths(v, `${path}.${k}`, out);
  }
  return out;
}

function session(): SurgicalSession {
  const samples: HeartRateSample[] = Array.from({ length: 600 }, (_, i) => ({ t: S + i * 1000, bpm: 80 + (i % 30) }));
  const rr: RRInterval[] = Array.from({ length: 700 }, (_, i) => ({
    t: S + Math.floor(i * 0.857) * 1000,
    ms: 750 + 20 * Math.sin(i),
  }));
  return {
    schemaVersion: 1,
    id: 'conf-1',
    participantCode: 'SP-001',
    procedure: { name: 'Test' },
    startedAt: S,
    endedAt: S + 600000,
    status: 'completed',
    sensor: { source: 'ble' },
    app: { version: '1', platform: 'web' },
    participantSnapshot: { birthYear: 1980 },
    samples,
    rr,
    events: [
      { id: 'p1', t: S, type: 'phase', phase: 'pre-op' },
      { id: 'p2', t: S + 300000, type: 'phase', phase: 'critical' },
    ],
  };
}

describe('Ground rule: never return NaN or Infinity (option values)', () => {
  // A NaN option is easy to produce in an app (e.g. Number('') from a settings field).
  // zones.ts sampleDwells: Math.min(dt, NaN) → NaN dwell → NaN seconds and fractions.
  it('timeInZones with maxGapMs = NaN gives finite seconds and fractions', () => {
    const out = timeInZones(session().samples, zonesFromMaxHr(190), Number.NaN);
    expect(nonFinitePaths(out)).toEqual([]);
  });

  it('summarizeSession with maxGapMs = NaN has no NaN anywhere in the summary', () => {
    const out = summarizeSession(session(), { maxGapMs: Number.NaN });
    expect(nonFinitePaths(out)).toEqual([]);
  });
});

describe('Ground rule: never return NaN or Infinity (finite inputs whose result is representable)', () => {
  const MAX = Number.MAX_VALUE;

  it('mean of two MAX_VALUE inputs is finite (sum overflows to Infinity)', () => {
    expect(Number.isFinite(mean([MAX, MAX]))).toBe(true);
  });

  it('median of two MAX_VALUE inputs is finite ((a + b) / 2 overflows)', () => {
    expect(Number.isFinite(median([MAX, MAX]))).toBe(true);
  });

  it('percentile([-MAX, MAX], 50) is 0, not -Infinity (b − a overflows in the lerp)', () => {
    expect(percentile([-MAX, MAX], 50)).toBe(0);
  });
});

describe('cleanRr rule 2 follows the spec comparison literally', () => {
  // SPEC: an interval is invalid if |ms − localMedian| / localMedian > maxDeviation.
  // With maxDeviation = NaN that comparison is false, so rule 2 never rejects a beat (the Python
  // port agrees). rr.ts tests `… <= maxDeviation` instead, which rejects every beat.
  it('maxDeviation = NaN never rejects an in-range beat', () => {
    const rr: RRInterval[] = Array.from({ length: 12 }, (_, i) => ({ t: S + i * 1000, ms: 800 + (i % 2) * 10 }));
    const { valid, report } = cleanRr(rr, { maxDeviation: Number.NaN });
    expect(valid.every(Boolean)).toBe(true);
    expect(report.removed).toBe(0);
  });
});
