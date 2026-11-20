/**
 * Small, fast test fixtures built with the core simulator (never hand-made
 * physiology), so tests exercise real core output.
 */
import { simulateSession } from '@surgeonpulse/core';
import type { ProcedureInfo, SurgicalSession } from '@surgeonpulse/core';

const DAY = 24 * 60 * 60 * 1000;

export interface FixtureOptions {
  seed?: number;
  participantCode?: string;
  procedure?: ProcedureInfo;
  dayOffset?: number;
  includeRr?: boolean;
}

/** A 20-minute simulated session with 5-second samples. */
export function makeSession(opts: FixtureOptions = {}): SurgicalSession {
  return simulateSession({
    seed: opts.seed ?? 1,
    participantCode: opts.participantCode ?? 'SP-001',
    durationMin: 20,
    sampleIntervalMs: 5000,
    includeRr: opts.includeRr ?? false,
    startedAt: Date.UTC(2026, 0, 5, 8, 0) + (opts.dayOffset ?? 0) * DAY,
    ...(opts.procedure ? { procedure: opts.procedure } : {}),
  });
}

/** Give a session a different id (simulated ids are random UUIDs, but keep tests explicit). */
export function withId(s: SurgicalSession, id: string): SurgicalSession {
  return { ...s, id };
}
