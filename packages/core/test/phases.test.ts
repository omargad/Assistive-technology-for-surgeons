import { describe, expect, it } from 'vitest';
import { derivePhases, phaseAt, sessionEnd } from '../src/analytics/phases';
import type { PhaseKind, PhaseSegment, SessionEvent, SurgicalSession } from '../src/types';

function makeSession(partial: Partial<SurgicalSession> = {}): SurgicalSession {
  return {
    schemaVersion: 1,
    id: 'S1',
    participantCode: 'SP-001',
    procedure: { name: 'Laparoscopic cholecystectomy' },
    startedAt: 0,
    status: 'completed',
    sensor: { source: 'simulated' },
    app: { version: '0.1.0', platform: 'web' },
    samples: [],
    rr: [],
    events: [],
    ...partial,
  };
}

const phase = (id: string, t: number, p: PhaseKind): SessionEvent => ({ id, t, type: 'phase', phase: p });

describe('sessionEnd', () => {
  it('prefers endedAt', () => {
    expect(sessionEnd(makeSession({ endedAt: 5000, samples: [{ t: 9000, bpm: 70 }] }))).toBe(5000);
  });
  it('falls back to the latest sample, RR or event time', () => {
    const s = makeSession({
      samples: [
        { t: 1000, bpm: 70 },
        { t: 2000, bpm: 70 },
      ],
      rr: [{ t: 2500, ms: 800 }],
      events: [phase('p', 2200, 'incision')],
    });
    expect(sessionEnd(s)).toBe(2500);
    expect(sessionEnd(makeSession({ events: [phase('p', 3000, 'closure')] }))).toBe(3000);
  });
  it('falls back to startedAt without data', () => {
    expect(sessionEnd(makeSession({ startedAt: 1234 }))).toBe(1234);
  });
});

describe('derivePhases', () => {
  it('clamps, de-duplicates and drops zero-length segments except a final one at sessionEnd', () => {
    const s = makeSession({
      startedAt: 0,
      endedAt: 100000,
      // deliberately unsorted; the two events at 30000 keep their array order (dissection, then critical)
      events: [
        phase('e7', 120000, 'post-op'), // after the end → clamped to 100000; final zero-length segment kept
        phase('e1', -5000, 'pre-op'), // before the start → clamped to 0
        phase('e2', 10000, 'incision'),
        phase('e3', 15000, 'incision'), // same phase as the previous event → ignored
        { id: 'm1', t: 20000, type: 'marker', marker: 'note' }, // markers are not phases
        phase('e4', 30000, 'dissection'), // zero length (next phase at the same t) → dropped
        phase('e5', 30000, 'critical'),
        phase('e6', 80000, 'closure'),
      ],
    });
    expect(derivePhases(s)).toEqual([
      { phase: 'pre-op', index: 0, start: 0, end: 10000 },
      { phase: 'incision', index: 1, start: 10000, end: 30000 },
      { phase: 'critical', index: 2, start: 30000, end: 80000 },
      { phase: 'closure', index: 3, start: 80000, end: 100000 },
      { phase: 'post-op', index: 4, start: 100000, end: 100000 },
    ]);
  });

  it('does not create a segment for time before the first phase event', () => {
    const s = makeSession({ startedAt: 0, endedAt: 60000, events: [phase('a', 10000, 'dissection')] });
    expect(derivePhases(s)).toEqual([{ phase: 'dissection', index: 0, start: 10000, end: 60000 }]);
  });

  it('keeps the first of consecutive same-phase events, even when others intervene later', () => {
    const s = makeSession({
      startedAt: 0,
      endedAt: 40000,
      events: [
        phase('a', 0, 'dissection'),
        phase('b', 5000, 'dissection'),
        phase('c', 10000, 'critical'),
        phase('d', 20000, 'dissection'),
      ],
    });
    expect(derivePhases(s)).toEqual([
      { phase: 'dissection', index: 0, start: 0, end: 10000 },
      { phase: 'critical', index: 1, start: 10000, end: 20000 },
      { phase: 'dissection', index: 2, start: 20000, end: 40000 },
    ]);
  });

  it('uses the derived session end while recording', () => {
    const s = makeSession({
      startedAt: 0,
      samples: [{ t: 50000, bpm: 80 }],
      events: [phase('a', 1000, 'incision')],
    });
    expect(derivePhases(s)).toEqual([{ phase: 'incision', index: 0, start: 1000, end: 50000 }]);
  });

  it('returns [] without phase events and does not mutate the session', () => {
    expect(derivePhases(makeSession())).toEqual([]);
    const events = [phase('b', 2000, 'closure'), phase('a', 1000, 'incision')];
    const s = makeSession({ endedAt: 3000, events });
    derivePhases(s);
    expect(s.events.map((e) => e.id)).toEqual(['b', 'a']);
  });
});

describe('phaseAt', () => {
  const segments: PhaseSegment[] = [
    { phase: 'incision', index: 0, start: 1000, end: 2000 },
    { phase: 'critical', index: 1, start: 2000, end: 5000 },
  ];
  it('finds the segment with start ≤ t < end', () => {
    expect(phaseAt(segments, 1000)).toBe('incision');
    expect(phaseAt(segments, 1999)).toBe('incision');
    expect(phaseAt(segments, 2000)).toBe('critical');
  });
  it('returns the last phase at exactly the last end', () => {
    expect(phaseAt(segments, 5000)).toBe('critical');
    expect(phaseAt([{ phase: 'post-op', index: 0, start: 9000, end: 9000 }], 9000)).toBe('post-op');
  });
  it('returns undefined outside the segments', () => {
    expect(phaseAt(segments, 999)).toBeUndefined();
    expect(phaseAt(segments, 5001)).toBeUndefined();
    expect(phaseAt([], 0)).toBeUndefined();
  });
});
