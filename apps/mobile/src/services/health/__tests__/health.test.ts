/// <reference types="jest" />
import { createSession } from '@surgeonpulse/core';
import type { HealthStore } from '../types';
import {
  buildImportResult,
  cleanHeartRate,
  healthConnectHeartRate,
  healthConnectRmssd,
  heartbeatsToRr,
} from '../mapping';
import { mergeHealthImport } from '../merge';

const T0 = Date.UTC(2026, 2, 2, 8, 0, 0);

describe('health mapping', () => {
  it('keeps plausible heart rate inside the window, sorted and de-duplicated', () => {
    const out = cleanHeartRate(
      [
        { t: T0 + 2000, bpm: 80 },
        { t: T0 - 1, bpm: 70 }, // before the window
        { t: T0 + 1000, bpm: 75 },
        { t: T0 + 1000, bpm: 76 }, // duplicate time
        { t: T0 + 3000, bpm: 0 }, // artefact
        { t: T0 + 4000, bpm: Number.NaN },
      ],
      T0,
      T0 + 10_000,
    );
    expect(out).toEqual([
      { t: T0 + 1000, bpm: 75 },
      { t: T0 + 2000, bpm: 80 },
    ]);
  });

  it('turns an Apple Watch heartbeat series into RR intervals, skipping gaps', () => {
    const rr = heartbeatsToRr(
      T0,
      [
        { timeSinceSeriesStart: 0, precededByGap: false },
        { timeSinceSeriesStart: 0.8, precededByGap: false },
        { timeSinceSeriesStart: 1.65, precededByGap: false },
        { timeSinceSeriesStart: 5, precededByGap: true },
        { timeSinceSeriesStart: 5.9, precededByGap: false },
      ],
      T0,
      T0 + 60_000,
    );
    expect(rr).toEqual([
      { t: T0 + 800, ms: 800 },
      { t: T0 + 1650, ms: 850 },
      { t: T0 + 5900, ms: 900 },
    ]);
  });

  it('maps Health Connect records', () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    expect(
      healthConnectHeartRate([
        { samples: [{ time: iso(T0), beatsPerMinute: 71 }] },
        { samples: [{ time: iso(T0 + 5000), beatsPerMinute: 74 }] },
      ]),
    ).toEqual([
      { t: T0, bpm: 71 },
      { t: T0 + 5000, bpm: 74 },
    ]);
    expect(healthConnectRmssd([{ time: iso(T0), heartRateVariabilityMillis: 38 }])).toEqual([
      { t: T0, metric: 'rmssd', ms: 38, source: 'health-connect' },
    ]);
    const result = buildImportResult('health-connect', T0, T0 + 1000, {
      samples: [{ t: T0 + 5000, bpm: 74 }],
      externalHrv: [{ t: T0, metric: 'rmssd', ms: 38, source: 'health-connect' }],
    });
    expect(result.samples).toEqual([]);
    expect(result.externalHrv).toHaveLength(1);
  });

  it('the web fallback reports itself unavailable', async () => {
    // jest-expo resolves '../index' to index.ios.ts; load the fallback file explicitly.
    const fallback = jest.requireActual<{ healthStore: HealthStore }>('../index.ts').healthStore;
    expect(fallback.source).toBeNull();
    await expect(fallback.isAvailable()).resolves.toBe(false);
    await expect(fallback.requestAccess()).resolves.toBe(false);
    await expect(fallback.importRange(T0, T0 + 1)).rejects.toThrow(/not available/);
  });
});

describe('mergeHealthImport', () => {
  it('adds only new data and keeps arrays sorted', () => {
    const base = {
      ...createSession({
        participantCode: 'SP-014',
        procedure: { name: 'Test' },
        sensor: { source: 'healthkit' },
        app: { version: '0.1.0', platform: 'ios' },
        startedAt: T0,
      }),
      samples: [{ t: T0 + 2000, bpm: 70 }],
    };
    const result = {
      source: 'healthkit' as const,
      samples: [
        { t: T0 + 1000, bpm: 68 },
        { t: T0 + 2000, bpm: 99 },
      ],
      rr: [{ t: T0 + 1000, ms: 880 }],
      externalHrv: [{ t: T0, metric: 'sdnn' as const, ms: 40, source: 'healthkit' as const }],
    };
    const first = mergeHealthImport(base, result);
    expect(first.addedSamples).toBe(1);
    expect(first.session.samples).toEqual([
      { t: T0 + 1000, bpm: 68 },
      { t: T0 + 2000, bpm: 70 },
    ]);
    expect(first.session.rr).toHaveLength(1);
    expect(first.session.externalHrv).toHaveLength(1);
    const again = mergeHealthImport(first.session, result);
    expect([again.addedSamples, again.addedRr, again.addedHrv]).toEqual([0, 0, 0]);
    expect(again.session).toBe(first.session);
  });
});
