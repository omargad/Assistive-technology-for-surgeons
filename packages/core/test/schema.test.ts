import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { ExportBundle, SessionEvent, SurgicalSession } from '../src/types';
import {
  BaselineSchema,
  ExportBundleSchema,
  HeartRateSampleSchema,
  ParticipantProfileSchema,
  PostOpReportSchema,
  ProcedureInfoSchema,
  RRIntervalSchema,
  SessionEventSchema,
  SessionParseError,
  SurgicalSessionSchema,
  migrateSession,
  parseSession,
  safeParseSession,
} from '../src/io/schema';

const T0 = Date.UTC(2026, 0, 5, 8, 0);

// Compile-time: the zod output types and the contract types are mutually assignable.
type Infer<S extends z.ZodType> = z.infer<S>;
const sessionFromZod: SurgicalSession = {} as Infer<typeof SurgicalSessionSchema>;
const zodFromSession: Infer<typeof SurgicalSessionSchema> = {} as SurgicalSession;
const bundleFromZod: ExportBundle = {} as Infer<typeof ExportBundleSchema>;
const zodFromBundle: Infer<typeof ExportBundleSchema> = {} as ExportBundle;
const eventFromZod: SessionEvent = {} as Infer<typeof SessionEventSchema>;
void [sessionFromZod, zodFromSession, bundleFromZod, zodFromBundle, eventFromZod];

function deepFreeze<T>(x: T): T {
  if (typeof x === 'object' && x !== null && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x)) deepFreeze(v);
  }
  return x;
}

function fullSession(): SurgicalSession {
  return {
    schemaVersion: 1,
    id: 'session-1',
    participantCode: 'SP-014',
    procedure: {
      name: 'Laparoscopic cholecystectomy',
      catalogId: 'laparoscopic-cholecystectomy',
      specialty: 'General surgery',
      approach: 'laparoscopic',
      role: 'primary',
      complexity: 3,
      urgency: 'elective',
    },
    startedAt: T0,
    endedAt: T0 + 3_600_000,
    status: 'completed',
    sensor: { source: 'ble', name: 'Polar H10', id: 'AA:BB:CC:DD:EE:FF', location: 'chest' },
    app: { version: '1.2.0', platform: 'ios' },
    tzOffsetMin: 600,
    participantSnapshot: { trainingLevel: 'registrar', specialty: 'General surgery', yearsExperience: 5, birthYear: 1990, maxHr: 185, restingHr: 62 },
    baseline: { startedAt: T0 - 300_000, endedAt: T0, restingHr: 64, rmssd: 42, sdnn: 55, source: 'measured' },
    samples: [
      { t: T0, bpm: 70, contact: true },
      { t: T0 + 1000, bpm: 72 },
    ],
    rr: [
      { t: T0 + 1000, ms: 850 },
      { t: T0 + 1000, ms: 845.5 },
    ],
    externalHrv: [{ t: T0 + 60_000, metric: 'sdnn', ms: 48, source: 'healthkit' }],
    events: [
      { id: 'e1', t: T0, type: 'phase', phase: 'pre-op', loggedBy: 'self' },
      { id: 'e2', t: T0 + 600_000, type: 'marker', marker: 'complication', note: 'bleeding from cystic artery' },
    ],
    postOp: {
      workload: {
        instrument: 'surg-tlx',
        ratings: { mental: 60, physical: 30, temporal: 45, complexity: 55, stress: 70, distraction: 20 },
        weights: { mental: 4, physical: 1, temporal: 2, complexity: 3, stress: 5, distraction: 0 },
        completedAt: T0 + 3_700_000,
      },
      performance: 8,
      perceivedStress: 6,
      sleepHours: 6.5,
      caffeine: true,
      outcome: 'as-planned',
      notes: 'free text',
    },
    tags: ['pilot'],
  };
}

function issuesOf(raw: unknown): string[] {
  const r = safeParseSession(raw);
  if (r.ok) throw new Error('expected failure');
  return r.error.issues;
}

describe('parseSession', () => {
  it('accepts a complete valid session and returns an equal, new object', () => {
    const input = deepFreeze(fullSession());
    const parsed = parseSession(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed.samples).not.toBe(input.samples);
    expect(parsed.procedure).not.toBe(input.procedure);
  });

  it('accepts a minimal recording session', () => {
    const minimal = {
      schemaVersion: 1,
      id: 'x',
      participantCode: 'P1',
      procedure: { name: '' },
      startedAt: T0,
      status: 'recording',
      sensor: { source: 'simulated' },
      app: { version: '0.0.1', platform: 'unknown' },
      samples: [],
      rr: [],
      events: [],
    };
    expect(parseSession(minimal)).toEqual(minimal);
  });

  it('strips unknown keys at every level instead of rejecting them', () => {
    const raw = {
      ...fullSession(),
      futureField: 1,
      procedure: { ...fullSession().procedure, surgeonName: 'should go' },
      samples: [{ t: T0, bpm: 70, extra: true }],
      events: [{ id: 'e', t: T0, type: 'marker', marker: 'note', colour: 'red' }],
      postOp: { workload: { ...fullSession().postOp?.workload, extra: 1 } },
    };
    const parsed = parseSession(raw) as unknown as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('futureField');
    expect(parsed.procedure).not.toHaveProperty('surgeonName');
    expect((parsed.samples as object[])[0]).toEqual({ t: T0, bpm: 70 });
    expect((parsed.events as object[])[0]).toEqual({ id: 'e', t: T0, type: 'marker', marker: 'note' });
    expect((parsed.postOp as { workload: object }).workload).not.toHaveProperty('extra');
  });

  it('stably sorts samples, rr, events and externalHrv by t without mutating the input', () => {
    const raw = deepFreeze({
      ...fullSession(),
      samples: [
        { t: T0 + 2000, bpm: 1 },
        { t: T0, bpm: 2 },
        { t: T0 + 2000, bpm: 3 },
      ],
      rr: [
        { t: T0 + 2000, ms: 801 },
        { t: T0 + 1000, ms: 802 },
        { t: T0 + 1000, ms: 803 },
      ],
      events: [
        { id: 'b', t: T0 + 5, type: 'marker', marker: 'note' },
        { id: 'a', t: T0, type: 'phase', phase: 'incision' },
        { id: 'c', t: T0 + 5, type: 'marker', marker: 'teaching' },
      ],
      externalHrv: [
        { t: T0 + 2, metric: 'rmssd', ms: 30, source: 'health-connect' },
        { t: T0 + 1, metric: 'rmssd', ms: 31, source: 'health-connect' },
      ],
    });
    const parsed = parseSession(raw);
    expect(parsed.samples.map((s) => s.bpm)).toEqual([2, 1, 3]);
    expect(parsed.rr.map((r) => r.ms)).toEqual([802, 803, 801]);
    expect(parsed.events.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(parsed.externalHrv?.map((x) => x.ms)).toEqual([31, 30]);
    expect(raw.samples.map((s) => s.bpm)).toEqual([1, 2, 3]);
  });

  it('enforces the numeric ranges from the spec', () => {
    const s = fullSession();
    const bad: [string, unknown][] = [
      ['samples[0].bpm', { ...s, samples: [{ t: T0, bpm: 301 }] }],
      ['samples[0].bpm', { ...s, samples: [{ t: T0, bpm: -1 }] }],
      ['rr[1].ms', { ...s, rr: [{ t: T0, ms: 800 }, { t: T0, ms: 5001 }] }],
      ['postOp.workload.ratings.stress', { ...s, postOp: { workload: { ...s.postOp?.workload, ratings: { ...(s.postOp?.workload?.ratings ?? {}), stress: 101 } } } }],
      ['postOp.performance', { ...s, postOp: { performance: 11 } }],
      ['postOp.perceivedStress', { ...s, postOp: { perceivedStress: -0.5 } }],
      ['procedure.complexity', { ...s, procedure: { name: 'x', complexity: 6 } }],
      ['procedure.complexity', { ...s, procedure: { name: 'x', complexity: 2.5 } }],
      ['baseline.restingHr', { ...s, baseline: { ...s.baseline, restingHr: 400 } }],
    ];
    for (const [path, raw] of bad) {
      const issues = issuesOf(raw);
      expect(issues.some((i) => i.startsWith(`${path}: `)), `${path} in ${issues.join(' | ')}`).toBe(true);
    }
    // inclusive bounds
    expect(() => parseSession({ ...s, samples: [{ t: T0, bpm: 0 }, { t: T0, bpm: 300 }] })).not.toThrow();
    expect(() => parseSession({ ...s, rr: [{ t: T0, ms: 0 }, { t: T0, ms: 5000 }] })).not.toThrow();
    expect(() => parseSession({ ...s, postOp: { performance: 0, perceivedStress: 10 } })).not.toThrow();
  });

  it('rejects NaN and Infinity anywhere a number is expected', () => {
    const s = fullSession();
    expect(issuesOf({ ...s, startedAt: Number.NaN })[0]).toMatch(/^startedAt: /);
    expect(issuesOf({ ...s, samples: [{ t: Number.POSITIVE_INFINITY, bpm: 70 }] })[0]).toMatch(/^samples\[0\]\.t: /);
  });

  it('reports every problem as a readable "path: message" line', () => {
    const issues = issuesOf({
      ...fullSession(),
      participantCode: '',
      status: 'paused',
      events: [{ id: 'e', t: T0, type: 'bookmark' }],
    });
    expect(issues).toHaveLength(3);
    for (const line of issues) expect(line).toMatch(/^[\w[\].]+: \S/);
    expect(issues.some((l) => l.startsWith('participantCode: '))).toBe(true);
    expect(issues.some((l) => l.startsWith('status: '))).toBe(true);
    expect(issues.some((l) => l.startsWith('events[0].type: '))).toBe(true);
  });

  it('throws SessionParseError (an Error with issues) for invalid input', () => {
    try {
      parseSession({ ...fullSession(), samples: [{ t: T0 }] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SessionParseError);
      expect(err).toBeInstanceOf(Error);
      const e = err as SessionParseError;
      expect(e.name).toBe('SessionParseError');
      expect(e.issues).toEqual(['samples[0].bpm: Invalid input: expected number, received undefined']);
      expect(e.message).toContain('samples[0].bpm');
    }
  });

  it('rejects non-object input with a root-level issue', () => {
    for (const raw of [null, 42, 'session', [fullSession()], undefined]) {
      const issues = issuesOf(raw);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatch(/^\(root\): /);
    }
  });
});

describe('migrateSession', () => {
  it('returns v1 objects unchanged (identity)', () => {
    const raw = fullSession();
    expect(migrateSession(raw)).toBe(raw);
  });

  it('treats a missing schemaVersion as an error', () => {
    const { schemaVersion: _drop, ...noVersion } = fullSession();
    expect(() => migrateSession(noVersion)).toThrow(SessionParseError);
    expect(issuesOf(noVersion)[0]).toMatch(/^schemaVersion: /);
  });

  it('rejects a future schemaVersion with an "update the app" message', () => {
    try {
      migrateSession({ ...fullSession(), schemaVersion: 2 });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SessionParseError);
      expect((err as SessionParseError).issues[0]).toMatch(/^schemaVersion: .*newer.*update/i);
    }
  });

  it('rejects malformed versions', () => {
    for (const v of [0, -1, 1.5, '1', null, 10n]) {
      expect(() => migrateSession({ ...fullSession(), schemaVersion: v })).toThrow(SessionParseError);
    }
  });
});

describe('safeParseSession', () => {
  it('returns ok with the session, or the error, without throwing', () => {
    const ok = safeParseSession(fullSession());
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.session.id).toBe('session-1');
    const bad = safeParseSession({ ...fullSession(), schemaVersion: 99 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBeInstanceOf(SessionParseError);
  });
});

describe('component schemas', () => {
  it('validate their own shapes', () => {
    expect(HeartRateSampleSchema.parse({ t: 1, bpm: 60, junk: 1 })).toEqual({ t: 1, bpm: 60 });
    expect(RRIntervalSchema.safeParse({ t: 1, ms: -1 }).success).toBe(false);
    expect(SessionEventSchema.safeParse({ id: 'a', t: 1, type: 'phase', phase: 'critical' }).success).toBe(true);
    expect(SessionEventSchema.safeParse({ id: 'a', t: 1, type: 'phase', marker: 'note' }).success).toBe(false);
    expect(SessionEventSchema.safeParse({ id: '', t: 1, type: 'marker', marker: 'note' }).success).toBe(false);
    expect(ProcedureInfoSchema.safeParse({ name: 'x', approach: 'keyhole' }).success).toBe(false);
    expect(BaselineSchema.safeParse({ startedAt: 0, endedAt: 1, restingHr: 60, source: 'guess' }).success).toBe(false);
    expect(PostOpReportSchema.parse({})).toEqual({});
    expect(
      ParticipantProfileSchema.parse({ code: 'SP-1', consent: { version: 'PICF-1.2', givenAt: 5 }, email: 'x@y.z' }),
    ).toEqual({ code: 'SP-1', consent: { version: 'PICF-1.2', givenAt: 5 } });
  });

  it('validates both workload instruments, with optional weights', () => {
    const nasa = {
      instrument: 'nasa-tlx',
      ratings: { mental: 50, physical: 10, temporal: 40, performance: 20, effort: 55, frustration: 15 },
      completedAt: T0,
    };
    expect(PostOpReportSchema.safeParse({ workload: nasa }).success).toBe(true);
    // a SURG-TLX dimension under a NASA-TLX response is missing NASA keys
    const wrong = { ...nasa, instrument: 'surg-tlx' };
    expect(PostOpReportSchema.safeParse({ workload: wrong }).success).toBe(false);
  });

  it('ExportBundleSchema accepts a bundle', () => {
    const bundle = {
      format: 'surgeonpulse-export',
      version: 1,
      exportedAt: T0,
      deidentified: true,
      participants: [{ code: 'SP-014' }],
      sessions: [fullSession()],
    };
    expect(ExportBundleSchema.parse(bundle)).toEqual(bundle);
    expect(ExportBundleSchema.safeParse({ ...bundle, version: 2 }).success).toBe(false);
  });
});

describe('time windows must not run backwards', () => {
  it('rejects a session whose endedAt is before startedAt', () => {
    const s = fullSession();
    expect(issuesOf({ ...s, endedAt: s.startedAt - 1000 })).toEqual(['endedAt: endedAt must not be before startedAt']);
    expect(safeParseSession({ ...s, endedAt: s.startedAt }).ok).toBe(true);
    const { endedAt: _drop, ...recording } = s;
    expect(safeParseSession({ ...recording, status: 'recording' }).ok).toBe(true);
  });
  it('rejects a baseline whose endedAt is before startedAt', () => {
    const s = fullSession();
    const baseline = { startedAt: T0, endedAt: T0 - 1, restingHr: 60, source: 'manual' as const };
    expect(BaselineSchema.safeParse(baseline).success).toBe(false);
    expect(issuesOf({ ...s, baseline })).toEqual(['baseline.endedAt: endedAt must not be before startedAt']);
  });
});
