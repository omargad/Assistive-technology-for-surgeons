import { describe, expect, it } from 'vitest';
import type { HeartRateSample, RRInterval, SessionEvent, SurgicalSession } from '../src/types';
import {
  addEvent,
  appendRr,
  appendSamples,
  createSession,
  finishSession,
  removeEvent,
  sortSession,
  updateEvent,
} from '../src/util/session';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const T0 = Date.UTC(2026, 0, 5, 8, 0);

/** Recursively freeze so any mutation throws (ES modules run in strict mode). */
function deepFreeze<T>(x: T): T {
  if (typeof x === 'object' && x !== null && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x)) deepFreeze(v);
  }
  return x;
}

function base(): SurgicalSession {
  return createSession({
    id: 's1',
    participantCode: 'SP-001',
    procedure: { name: 'Laparoscopic cholecystectomy', catalogId: 'laparoscopic-cholecystectomy' },
    sensor: { source: 'ble', name: 'Polar H10' },
    app: { version: '1.0.0', platform: 'ios' },
    startedAt: T0,
  });
}

const s = (t: number, bpm: number): HeartRateSample => ({ t, bpm });
const r = (t: number, ms: number): RRInterval => ({ t, ms });

describe('createSession', () => {
  it('creates a recording session with empty arrays and only the given optional fields', () => {
    const session = base();
    expect(session).toEqual({
      schemaVersion: 1,
      id: 's1',
      participantCode: 'SP-001',
      procedure: { name: 'Laparoscopic cholecystectomy', catalogId: 'laparoscopic-cholecystectomy' },
      startedAt: T0,
      status: 'recording',
      sensor: { source: 'ble', name: 'Polar H10' },
      app: { version: '1.0.0', platform: 'ios' },
      samples: [],
      rr: [],
      events: [],
    });
    expect(Object.keys(session)).not.toContain('endedAt');
    expect(Object.keys(session)).not.toContain('tzOffsetMin');
    expect(Object.keys(session)).not.toContain('baseline');
  });

  it('generates a v4 UUID when no id is given', () => {
    const a = createSession({
      participantCode: 'SP-001',
      procedure: { name: 'X' },
      sensor: { source: 'simulated' },
      app: { version: '1', platform: 'web' },
      startedAt: T0,
    });
    expect(a.id).toMatch(UUID_V4);
  });

  it('copies optional fields and does not alias nested inputs', () => {
    const procedure = { name: 'Tonsillectomy' };
    const snapshot = { trainingLevel: 'registrar' as const, birthYear: 1990 };
    const baseline = { startedAt: T0 - 300_000, endedAt: T0, restingHr: 66, source: 'measured' as const };
    const session = createSession({
      participantCode: 'SP-002',
      procedure,
      sensor: { source: 'ble' },
      app: { version: '1', platform: 'android' },
      startedAt: T0,
      tzOffsetMin: 600,
      participantSnapshot: snapshot,
      baseline,
    });
    expect(session.tzOffsetMin).toBe(600);
    expect(session.participantSnapshot).toEqual(snapshot);
    expect(session.baseline).toEqual(baseline);
    procedure.name = 'changed';
    snapshot.birthYear = 2000;
    expect(session.procedure.name).toBe('Tonsillectomy');
    expect(session.participantSnapshot?.birthYear).toBe(1990);
    expect(session.participantSnapshot).not.toBe(snapshot);
    expect(session.baseline).not.toBe(baseline);
  });

  it('rejects a non-finite start time', () => {
    expect(() => createSession({ ...base(), startedAt: Number.NaN })).toThrow(RangeError);
  });
});

describe('appendSamples', () => {
  it('appends in order without mutating the input session or batch', () => {
    const start = deepFreeze(appendSamples(base(), [s(T0, 70), s(T0 + 1000, 71)]));
    const batch = deepFreeze([s(T0 + 2000, 72)]);
    const next = appendSamples(start, batch);
    expect(next).not.toBe(start);
    expect(next.samples).not.toBe(start.samples);
    expect(next.samples.map((x) => x.bpm)).toEqual([70, 71, 72]);
    expect(start.samples).toHaveLength(2);
  });

  it('inserts late or out-of-order samples in time order', () => {
    let session = appendSamples(base(), [s(T0, 70), s(T0 + 3000, 73)]);
    session = appendSamples(session, deepFreeze([s(T0 + 4000, 74), s(T0 + 1000, 71), s(T0 + 2000, 72)]));
    expect(session.samples.map((x) => x.t - T0)).toEqual([0, 1000, 2000, 3000, 4000]);
  });

  it('places new samples after existing samples with the same t (stable)', () => {
    let session = appendSamples(base(), [s(T0, 1), s(T0 + 1000, 2)]);
    session = appendSamples(session, [s(T0, 3), s(T0 + 1000, 4)]);
    expect(session.samples.map((x) => x.bpm)).toEqual([1, 3, 2, 4]);
  });

  it('returns a copy for an empty batch', () => {
    const session = deepFreeze(appendSamples(base(), [s(T0, 70)]));
    const next = appendSamples(session, []);
    expect(next).toEqual(session);
    expect(next.samples).not.toBe(session.samples);
  });
});

describe('appendRr', () => {
  it('keeps beat order for intervals that share a notification timestamp', () => {
    let session = appendRr(base(), deepFreeze([r(T0 + 1000, 800), r(T0 + 1000, 810)]));
    session = appendRr(session, deepFreeze([r(T0 + 2000, 820), r(T0 + 2000, 790), r(T0 + 2000, 805)]));
    expect(session.rr.map((x) => x.ms)).toEqual([800, 810, 820, 790, 805]);
  });

  it('puts a late batch with an equal t after the existing beats', () => {
    let session = appendRr(base(), [r(T0 + 1000, 1), r(T0 + 2000, 2)]);
    session = appendRr(session, [r(T0 + 1000, 3), r(T0 + 1000, 4)]);
    expect(session.rr.map((x) => x.ms)).toEqual([1, 3, 4, 2]);
  });
});

describe('events', () => {
  const phase = (id: string, t: number): SessionEvent => ({ id, t, type: 'phase', phase: 'incision' });
  const marker = (id: string, t: number): SessionEvent => ({ id, t, type: 'marker', marker: 'complication' });

  it('addEvent inserts in time order, after existing events with the same t', () => {
    let session = deepFreeze(addEvent(base(), phase('a', T0 + 5000)));
    session = deepFreeze(addEvent(session, marker('b', T0 + 1000)));
    session = deepFreeze(addEvent(session, marker('c', T0 + 5000)));
    expect(session.events.map((e) => e.id)).toEqual(['b', 'a', 'c']);
  });

  it('addEvent generates an id when omitted and drops undefined keys', () => {
    const session = addEvent(base(), { t: T0, type: 'marker', marker: 'note', note: undefined });
    const e = session.events[0];
    expect(e?.id).toMatch(UUID_V4);
    expect(e && 'note' in e).toBe(false);
  });

  it('addEvent rejects a non-finite time', () => {
    expect(() => addEvent(base(), marker('x', Number.NaN))).toThrow(RangeError);
  });

  it('updateEvent patches fields in place when t is unchanged', () => {
    const session = deepFreeze(
      addEvent(addEvent(base(), marker('a', T0 + 1000)), { ...marker('b', T0 + 2000), note: 'bleeding', loggedBy: 'self' }),
    );
    const next = updateEvent(session, 'b', { note: 'minor bleeding', marker: 'equipment' });
    expect(next.events[1]).toEqual({
      id: 'b',
      t: T0 + 2000,
      type: 'marker',
      marker: 'equipment',
      note: 'minor bleeding',
      loggedBy: 'self',
    });
    expect(session.events[1]).toMatchObject({ note: 'bleeding', marker: 'complication' });
  });

  it('updateEvent removes an optional field patched to undefined', () => {
    const session = deepFreeze(addEvent(base(), { ...marker('a', T0), note: 'remove me' }));
    const next = updateEvent(session, 'a', { note: undefined });
    expect(next.events[0] && 'note' in next.events[0]).toBe(false);
  });

  it('updateEvent re-sorts when t changes, and ignores phase/marker on the wrong type', () => {
    let session = addEvent(base(), phase('p', T0 + 1000));
    session = addEvent(session, marker('m', T0 + 2000));
    session = addEvent(session, marker('n', T0 + 3000));
    deepFreeze(session);
    const next = updateEvent(session, 'p', { t: T0 + 3000, marker: 'teaching' });
    expect(next.events.map((e) => e.id)).toEqual(['m', 'n', 'p']);
    expect(next.events[2]).toEqual({ id: 'p', t: T0 + 3000, type: 'phase', phase: 'incision' });
  });

  it('updateEvent and removeEvent return the input unchanged for an unknown id', () => {
    const session = deepFreeze(addEvent(base(), marker('a', T0)));
    expect(updateEvent(session, 'zzz', { note: 'x' })).toBe(session);
    expect(removeEvent(session, 'zzz')).toBe(session);
  });

  it('removeEvent returns a new session without the event', () => {
    const session = deepFreeze(addEvent(addEvent(base(), marker('a', T0)), marker('b', T0 + 1)));
    const next = removeEvent(session, 'a');
    expect(next.events.map((e) => e.id)).toEqual(['b']);
    expect(session.events).toHaveLength(2);
  });
});

describe('finishSession', () => {
  it('sets endedAt and status (completed by default)', () => {
    const session = deepFreeze(base());
    expect(finishSession(session, T0 + 60_000)).toMatchObject({ endedAt: T0 + 60_000, status: 'completed' });
    expect(finishSession(session, T0 + 60_000, 'aborted').status).toBe('aborted');
    expect(session.status).toBe('recording');
  });

  it('rejects an end before the start or a non-finite end', () => {
    expect(() => finishSession(base(), T0 - 1)).toThrow(RangeError);
    expect(() => finishSession(base(), Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('sortSession', () => {
  it('stably sorts samples, rr, events and externalHrv without mutating the input', () => {
    const session = deepFreeze<SurgicalSession>({
      ...base(),
      samples: [s(T0 + 2000, 1), s(T0, 2), s(T0 + 2000, 3), s(T0 + 1000, 4)],
      rr: [r(T0 + 2000, 1), r(T0 + 1000, 2), r(T0 + 2000, 3)],
      events: [
        { id: 'late', t: T0 + 9000, type: 'marker', marker: 'note' },
        { id: 'early', t: T0, type: 'phase', phase: 'pre-op' },
      ],
      externalHrv: [
        { t: T0 + 2, metric: 'sdnn', ms: 40, source: 'healthkit' },
        { t: T0 + 1, metric: 'sdnn', ms: 42, source: 'healthkit' },
      ],
    });
    const sorted = sortSession(session);
    expect(sorted.samples.map((x) => x.bpm)).toEqual([2, 4, 1, 3]);
    expect(sorted.rr.map((x) => x.ms)).toEqual([2, 1, 3]);
    expect(sorted.events.map((e) => e.id)).toEqual(['early', 'late']);
    expect(sorted.externalHrv?.map((x) => x.ms)).toEqual([42, 40]);
    expect(session.samples.map((x) => x.bpm)).toEqual([1, 2, 3, 4]);
  });

  it('is stable for many ties regardless of the engine sort', () => {
    const rr = Array.from({ length: 2000 }, (_, i) => r(T0 + ((i * 7919) % 13) * 1000, i));
    const sorted = sortSession({ ...base(), rr }).rr;
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1] as RRInterval;
      const b = sorted[i] as RRInterval;
      expect(a.t < b.t || (a.t === b.t && a.ms < b.ms)).toBe(true);
    }
  });

  it('moves items with a non-finite t to the end in their original order', () => {
    const sorted = sortSession({
      ...base(),
      samples: [s(Number.NaN, 1), s(T0 + 1, 2), s(Number.POSITIVE_INFINITY, 3), s(T0, 4)],
    });
    expect(sorted.samples.map((x) => x.bpm)).toEqual([4, 2, 1, 3]);
  });

  it('always returns new arrays, even when already sorted', () => {
    const session = deepFreeze(appendSamples(base(), [s(T0, 1)]));
    const sorted = sortSession(session);
    expect(sorted.samples).toEqual(session.samples);
    expect(sorted.samples).not.toBe(session.samples);
  });
});
