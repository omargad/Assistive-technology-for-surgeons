import { describe, expect, it } from 'vitest';
import type { ExportBundle, SurgicalSession } from '../src/types';
import {
  DEIDENTIFY_KEPT_TAGS,
  UNSPECIFIED_PROCEDURE_NAME,
  deidentifyBundle,
  deidentifySession,
  isValidParticipantCode,
  sensorModelName,
} from '../src/io/deidentify';
import { createExportBundle } from '../src/io/bundle';
import { parseSession } from '../src/io/schema';
import { PROCEDURE_CATALOG, findProcedure } from '../src/catalog/procedures';

const T0 = Date.UTC(2026, 2, 9, 7, 30);
const SHIFT = -123 * 86_400_000 + 4321;

function deepFreeze<T>(x: T): T {
  if (typeof x === 'object' && x !== null && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x)) deepFreeze(v);
  }
  return x;
}

function session(): SurgicalSession {
  return {
    schemaVersion: 1,
    id: 's-1',
    participantCode: 'SP-014',
    procedure: {
      name: 'Lap chole for Mrs Smith, bed 12',
      catalogId: 'laparoscopic-cholecystectomy',
      approach: 'laparoscopic',
    },
    startedAt: T0,
    endedAt: T0 + 5_400_000,
    status: 'completed',
    sensor: { source: 'ble', name: 'Polar H10', id: 'C8:4A:1F:00:12:34', location: 'chest' },
    app: { version: '1.0.0', platform: 'android' },
    tzOffsetMin: 660,
    participantSnapshot: { trainingLevel: 'fellow', birthYear: 1988, restingHr: 60 },
    baseline: { startedAt: T0 - 300_000, endedAt: T0, restingHr: 63, source: 'measured' },
    samples: [
      { t: T0, bpm: 70, contact: true },
      { t: T0 + 1000, bpm: 71, contact: true },
    ],
    rr: [
      { t: T0 + 1000, ms: 850 },
      { t: T0 + 1000, ms: 842 },
    ],
    externalHrv: [{ t: T0 + 60_000, metric: 'rmssd', ms: 35, source: 'health-connect' }],
    events: [
      { id: 'e1', t: T0, type: 'phase', phase: 'pre-op', note: 'patient MRN 1234567' },
      { id: 'e2', t: T0 + 900_000, type: 'marker', marker: 'complication', note: 'bile spill', loggedBy: 'team' },
      { id: 'e3', t: T0 + 1_800_000, type: 'phase', phase: 'critical' },
    ],
    postOp: {
      workload: {
        instrument: 'surg-tlx',
        ratings: { mental: 60, physical: 30, temporal: 45, complexity: 55, stress: 70, distraction: 20 },
        completedAt: T0 + 6_000_000,
      },
      performance: 7,
      notes: 'Discussed with Dr Jones about the patient',
    },
    tags: ['pilot'],
  };
}

const TIME_KEYS = new Set(['t', 'startedAt', 'endedAt', 'completedAt', 'givenAt', 'withdrawnAt', 'exportedAt']);

/** Collect every timestamp-like field with its path, anywhere in the object. */
function timestamps(x: unknown, path = ''): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (v: unknown, p: string): void => {
    if (Array.isArray(v)) v.forEach((item, i) => walk(item, `${p}[${i}]`));
    else if (typeof v === 'object' && v !== null) {
      for (const [k, child] of Object.entries(v)) {
        const cp = p ? `${p}.${k}` : k;
        if (TIME_KEYS.has(k) && typeof child === 'number') out.set(cp, child);
        else walk(child, cp);
      }
    }
  };
  walk(x, path);
  return out;
}

describe('deidentifySession', () => {
  it('by default removes notes and the sensor id, and substitutes the catalogue name', () => {
    const input = deepFreeze(session());
    const out = deidentifySession(input);
    for (const e of out.events) expect('note' in e).toBe(false);
    expect(out.postOp && 'notes' in out.postOp).toBe(false);
    expect(out.postOp?.performance).toBe(7);
    expect('id' in out.sensor).toBe(false);
    expect(out.sensor).toEqual({ source: 'ble', name: 'Polar H10', location: 'chest' });
    expect(out.procedure.name).toBe(findProcedure('laparoscopic-cholecystectomy')?.name);
    expect(out.procedure.name).toBe('Laparoscopic cholecystectomy');
    // untouched by default
    expect(out.startedAt).toBe(T0);
    expect(out.tzOffsetMin).toBe(660);
    expect(out.participantSnapshot?.birthYear).toBe(1988);
    expect(out.events[1]?.loggedBy).toBe('team');
  });

  it('replaces a free-text name that cannot be matched to the catalogue (it might name a patient)', () => {
    const s = { ...session(), procedure: { name: 'Custom procedure', catalogId: 'no-such-procedure' } };
    expect(deidentifySession(s).procedure).toEqual({ name: UNSPECIFIED_PROCEDURE_NAME });
    const noId = { ...session(), procedure: { name: 'Lap chole for Mrs Jones MRN 1234', specialty: 'General surgery' } };
    expect(deidentifySession(noId).procedure).toEqual({ name: 'Unspecified procedure', specialty: 'General surgery' });
  });

  it('keeps a typed name that exactly matches a catalogue name (case-insensitive) and records its id', () => {
    const entry = PROCEDURE_CATALOG[0]!;
    const s = { ...session(), procedure: { name: `  ${entry.name.toUpperCase()} ` } };
    expect(deidentifySession(s).procedure).toEqual({ name: entry.name, catalogId: entry.id });
  });

  it('keeps notes, name and sensor id when those options are off', () => {
    const out = deidentifySession(session(), { dropNotes: false, dropSensorId: false });
    expect(out.events[0]?.note).toBe('patient MRN 1234567');
    expect(out.postOp?.notes).toBe('Discussed with Dr Jones about the patient');
    expect(out.procedure.name).toBe('Lap chole for Mrs Smith, bed 12');
    expect(out.sensor.id).toBe('C8:4A:1F:00:12:34');
  });

  it('shifts every timestamp by timeShiftMs, consistently', () => {
    const input = deepFreeze(session());
    const out = deidentifySession(input, { timeShiftMs: SHIFT });
    const before = timestamps(input);
    const after = timestamps(out);
    expect([...after.keys()]).toEqual([...before.keys()]);
    expect(before.size).toBe(13);
    for (const [path, t] of before) expect(after.get(path), path).toBe(t + SHIFT);
    // spot-check the fields named in the spec
    expect(out.baseline?.startedAt).toBe(T0 - 300_000 + SHIFT);
    expect(out.postOp?.workload?.completedAt).toBe(T0 + 6_000_000 + SHIFT);
    expect(out.externalHrv?.[0]?.t).toBe(T0 + 60_000 + SHIFT);
    // all intervals and offsets are preserved
    expect((out.endedAt ?? 0) - out.startedAt).toBe(5_400_000);
    expect(out.events.map((e) => e.t - out.startedAt)).toEqual(input.events.map((e) => e.t - input.startedAt));
  });

  it('drops the timezone offset and birth year on request', () => {
    const out = deidentifySession(session(), { dropTzOffset: true, dropBirthYear: true });
    expect('tzOffsetMin' in out).toBe(false);
    expect(out.participantSnapshot).toEqual({ trainingLevel: 'fellow', restingHr: 60 });
  });

  it('never mutates the input and returns a valid session', () => {
    const input = deepFreeze(session());
    const snapshot = JSON.stringify(input);
    const out = deidentifySession(input, { timeShiftMs: SHIFT, dropTzOffset: true, dropBirthYear: true });
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(out).not.toBe(input);
    expect(parseSession(out)).toEqual(out);
  });

  it('handles a session without optional parts', () => {
    const minimal: SurgicalSession = {
      schemaVersion: 1,
      id: 'm',
      participantCode: 'P01',
      procedure: { name: 'x' },
      startedAt: 1000,
      status: 'recording',
      sensor: { source: 'simulated' },
      app: { version: '1', platform: 'web' },
      samples: [],
      rr: [],
      events: [],
    };
    expect(deidentifySession(minimal, { timeShiftMs: 500 })).toEqual({
      ...minimal,
      procedure: { name: UNSPECIFIED_PROCEDURE_NAME },
      startedAt: 1500,
    });
  });

  it('rejects a non-finite time shift', () => {
    expect(() => deidentifySession(session(), { timeShiftMs: Number.NaN })).toThrow(RangeError);
  });
});

describe('deidentifyBundle', () => {
  function bundle(): ExportBundle {
    return {
      format: 'surgeonpulse-export',
      version: 1,
      exportedAt: T0 + 86_400_000,
      app: { version: '1.0.0', platform: 'web' },
      deidentified: false,
      participants: [
        {
          code: 'SP-014',
          trainingLevel: 'fellow',
          birthYear: 1988,
          consent: { version: 'PICF-1.2', givenAt: T0 - 7 * 86_400_000, withdrawnAt: T0 + 30 * 86_400_000 },
        },
        { code: 'SP-015' },
      ],
      sessions: [session(), { ...session(), id: 's-2', participantCode: 'SP-015' }],
    };
  }

  it('applies the options to every session and participant and marks the bundle', () => {
    const input = deepFreeze(bundle());
    const out = deidentifyBundle(input, { timeShiftMs: SHIFT, dropBirthYear: true });
    expect(out.deidentified).toBe(true);
    expect(out.participants[0]).toEqual({
      code: 'SP-014',
      trainingLevel: 'fellow',
      consent: {
        version: 'PICF-1.2',
        givenAt: T0 - 7 * 86_400_000 + SHIFT,
        withdrawnAt: T0 + 30 * 86_400_000 + SHIFT,
      },
    });
    expect(out.participants[1]).toEqual({ code: 'SP-015' });
    for (const s of out.sessions) {
      expect(s.startedAt).toBe(T0 + SHIFT);
      expect('id' in s.sensor).toBe(false);
      expect(s.participantSnapshot && 'birthYear' in s.participantSnapshot).toBe(false);
    }
    // every timestamp in the bundle, including exportedAt and consent, moves together
    const before = timestamps(input);
    const after = timestamps(out);
    expect([...after.keys()]).toEqual([...before.keys()]);
    for (const [path, t] of before) expect(after.get(path), path).toBe(t + SHIFT);
    expect(input.deidentified).toBe(false);
  });

  it('defaults: notes dropped, times unchanged', () => {
    const out = deidentifyBundle(bundle());
    expect(out.exportedAt).toBe(T0 + 86_400_000);
    expect(out.sessions.every((s) => s.events.every((e) => !('note' in e)))).toBe(true);
    expect(out.participants[0]?.consent?.givenAt).toBe(T0 - 7 * 86_400_000);
  });
});

describe('isValidParticipantCode', () => {
  it('accepts pseudonymous study codes', () => {
    for (const code of ['SP-014', 'P07', 'ab', 'site2_p13', 'A'.repeat(32), '7-alpha']) {
      expect(isValidParticipantCode(code), code).toBe(true);
    }
  });

  it('rejects bad shapes and e-mail-like strings', () => {
    for (const code of [
      '',
      'a',
      'A'.repeat(33),
      '-abc',
      '_abc',
      'with space',
      'jane.doe',
      'jane@hospital.org',
      'jane-at-hospital-org',
      'j_smith_at_nhs_uk',
      'émile',
    ]) {
      expect(isValidParticipantCode(code), code).toBe(false);
    }
  });
});

describe('de-identification coverage (review findings)', () => {
  it('reduces a BLE name to the device model with dropSensorId (the serial identifies the device)', () => {
    const s = { ...session(), sensor: { source: 'ble' as const, name: 'Polar H10 A1B2C3D4', id: 'AA:BB:CC:DD:EE:FF' } };
    expect(deidentifySession(s).sensor).toEqual({ source: 'ble', name: 'Polar H10' });
    expect(deidentifySession(s, { dropSensorId: false }).sensor).toEqual(s.sensor);
  });

  it('sensorModelName strips serial tokens and suffixes but keeps model names', () => {
    expect(sensorModelName('Polar H10 A1B2C3D4')).toBe('Polar H10');
    expect(sensorModelName('TICKR 1A2B')).toBe('TICKR');
    expect(sensorModelName('Movesense 174630000192')).toBe('Movesense');
    expect(sensorModelName('HRM-Dual:123456')).toBe('HRM-Dual');
    expect(sensorModelName('Polar Verity Sense (0A1B2C3D)')).toBe('Polar Verity Sense');
    expect(sensorModelName('Garmin HRM-Pro')).toBe('Garmin HRM-Pro');
    expect(sensorModelName('Polar H10')).toBe('Polar H10');
    expect(sensorModelName('Strap')).toBe('Strap');
    expect(sensorModelName('C8:4A:1F:00:12:34')).toBeUndefined();
  });

  it('drops free-text tags with dropNotes but keeps the synthetic-data markers', () => {
    expect(DEIDENTIFY_KEPT_TAGS).toEqual(['simulated', 'demo']);
    const s = { ...session(), tags: ['bed 4 Mrs Jones', 'simulated', 'uploaded:2026-03-09T08:00:00.000Z', 'demo'] };
    expect(deidentifySession(s).tags).toEqual(['simulated', 'demo']);
    expect(deidentifySession({ ...s, tags: ['bed 4 Mrs Jones'] }).tags).toBeUndefined();
    expect(deidentifySession(s, { dropNotes: false }).tags).toEqual(s.tags);
  });

  it('refuses to de-identify a participant code that is not a pseudonym', () => {
    const s = { ...session(), participantCode: 'jane.doe@hospital.org' };
    expect(() => deidentifySession(s)).toThrow(RangeError);
    expect(() => createExportBundle({ sessions: [s], deidentify: true, now: T0 })).toThrow(/pseudonymous/);
    const b = createExportBundle({ sessions: [session()], participants: [{ code: 'jane@x.org' }], now: T0 });
    expect(() => deidentifyBundle(b)).toThrow(RangeError);
    // Without de-identification nothing is checked (the caller did not ask for it).
    expect(createExportBundle({ sessions: [s], now: T0 }).sessions[0]!.participantCode).toBe('jane.doe@hospital.org');
  });

  it('shares no nested objects with the input (workload ratings and weights are copied)', () => {
    const input = session();
    input.postOp = {
      workload: {
        instrument: 'surg-tlx',
        ratings: { mental: 50, physical: 20, temporal: 40, complexity: 60, stress: 70, distraction: 10 },
        weights: { mental: 5, physical: 0, temporal: 2, complexity: 3, stress: 4, distraction: 1 },
        completedAt: T0,
      },
    };
    const out = deidentifySession(input);
    expect(out.postOp!.workload!.ratings).toEqual(input.postOp.workload!.ratings);
    expect(out.postOp!.workload!.ratings).not.toBe(input.postOp.workload!.ratings);
    expect(out.postOp!.workload!.weights).not.toBe(input.postOp.workload!.weights);
  });
});
