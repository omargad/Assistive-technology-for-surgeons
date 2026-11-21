import { describe, expect, it } from 'vitest';
import { parseCsv, samplesToCsv } from '@surgeonpulse/core';
import type { SurgicalSession } from '@surgeonpulse/core';
import { makeSession, withId } from '../test/fixtures';
import { buildDeidentifiedBundle, longEventsCsv, longRrCsv, longSamplesCsv, randomWeekShift } from './exports';

const WEEK = 7 * 24 * 60 * 60 * 1000;

function withNotes(s: SurgicalSession): SurgicalSession {
  return {
    ...s,
    sensor: { ...s.sensor, id: 'DEVICE-1234' },
    postOp: { ...(s.postOp ?? {}), notes: 'free text that must not leave' },
    events: s.events.map((e) => ({ ...e, note: 'note' })),
  };
}

const a1 = withNotes(withId(makeSession({ seed: 1, participantCode: 'SP-001', includeRr: true }), 'a1'));
const a2 = withNotes(withId(makeSession({ seed: 2, participantCode: 'SP-001', dayOffset: 7 }), 'a2'));
const b1 = withNotes(withId(makeSession({ seed: 3, participantCode: 'SP-002', dayOffset: 3 }), 'b1'));

/** Deterministic sequence for the RNG. */
function sequence(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe('long-format CSVs', () => {
  it('concatenates sessions under one header', () => {
    const rows = parseCsv(longSamplesCsv([a1, b1]));
    expect(rows[0]).toEqual(['session_id', 'participant_code', 't_iso', 't_offset_s', 'bpm', 'contact', 'phase']);
    expect(rows.length).toBe(1 + a1.samples.length + b1.samples.length);
    expect(rows.filter((r) => r[0] === 'session_id')).toHaveLength(1);
    expect(new Set(rows.slice(1).map((r) => r[0]))).toEqual(new Set(['a1', 'b1']));
    // Identical to core's per-session output for a single session.
    expect(longSamplesCsv([a1])).toBe(samplesToCsv(a1));
  });

  it('builds events and RR CSVs (RR only for sessions that have it)', () => {
    const events = parseCsv(longEventsCsv([a1, b1]));
    expect(events.length).toBe(1 + a1.events.length + b1.events.length);
    // DOC-S2: free-text notes from a file that was not de-identified never reach the CSV.
    const noteCol = events[0]!.indexOf('note');
    expect(noteCol).toBeGreaterThan(-1);
    expect(events.slice(1).every((r) => r[noteCol] === '')).toBe(true);
    const secret = withId({ ...a1, events: a1.events.map((e) => ({ ...e, note: 'Mrs Jones UR 1234567' })) }, 'secret');
    expect(longEventsCsv([secret])).not.toContain('Jones');
    expect(a1.events.every((e) => e.note === 'note')).toBe(true); // input untouched
    const rr = parseCsv(longRrCsv([a1, b1]));
    expect(rr.length).toBe(1 + a1.rr.length);
    expect(longRrCsv([b1])).toBe('');
  });
});

describe('randomWeekShift', () => {
  it('returns a non-zero whole number of weeks within the bound', () => {
    expect(randomWeekShift(52, sequence([0, 0.9]))).toBe(1);
    expect(randomWeekShift(52, sequence([0.999999, 0.1]))).toBe(-52);
    expect(randomWeekShift(1, sequence([0.5, 0.7]))).toBe(1);
    for (let i = 0; i < 200; i++) {
      const w = randomWeekShift(10);
      expect(Number.isInteger(w)).toBe(true);
      expect(w).not.toBe(0);
      expect(Math.abs(w)).toBeLessThanOrEqual(10);
    }
  });
});

describe('buildDeidentifiedBundle', () => {
  const participants = [
    { code: 'SP-001', birthYear: 1985, consent: { version: 'PICF-1.0', givenAt: Date.UTC(2025, 11, 1) } },
    { code: 'SP-002', birthYear: 1990 },
  ];

  it('applies one shift per participant, different between participants', () => {
    // SP-001: magnitude 1 + floor(0.1·52) = 6 weeks, sign + ; SP-002: 1 + floor(0.5·52) = 27 weeks, sign −
    const random = sequence([0.1, 0.9, 0.5, 0.1]);
    const { bundle, shiftedParticipants } = buildDeidentifiedBundle(
      [a1, a2, b1],
      participants,
      { shiftDates: true, maxShiftWeeks: 52, dropTzOffset: false, dropBirthYear: true },
      { now: Date.UTC(2026, 5, 1), random },
    );
    expect(shiftedParticipants).toBe(2);
    expect(bundle.deidentified).toBe(true);
    const byId = new Map(bundle.sessions.map((s) => [s.id, s]));
    const shiftA1 = byId.get('a1')!.startedAt - a1.startedAt;
    const shiftA2 = byId.get('a2')!.startedAt - a2.startedAt;
    const shiftB1 = byId.get('b1')!.startedAt - b1.startedAt;
    expect(shiftA1).toBe(6 * WEEK);
    expect(shiftA2).toBe(shiftA1);
    expect(shiftB1).toBe(-27 * WEEK);
    // Intervals inside a session are preserved.
    const s = byId.get('a1')!;
    expect(s.samples[5]!.t - s.samples[0]!.t).toBe(a1.samples[5]!.t - a1.samples[0]!.t);
    // Consent dates move with the participant; birth years are gone.
    const p1 = bundle.participants.find((p) => p.code === 'SP-001')!;
    expect(p1.consent?.givenAt).toBe(participants[0]!.consent!.givenAt + 6 * WEEK);
    expect(p1.birthYear).toBeUndefined();
    // exportedAt does not reveal the real export time when shifting.
    expect(bundle.exportedAt).not.toBe(Date.UTC(2026, 5, 1));
  });

  it('removes notes and sensor ids and keeps the real time when not shifting', () => {
    const { bundle, shiftedParticipants } = buildDeidentifiedBundle(
      [a1, b1],
      participants,
      { shiftDates: false, dropTzOffset: true, dropBirthYear: false },
      { now: 123 },
    );
    expect(shiftedParticipants).toBe(0);
    expect(bundle.exportedAt).toBe(123);
    for (const s of bundle.sessions) {
      expect(s.sensor.id).toBeUndefined();
      expect(s.postOp?.notes).toBeUndefined();
      expect(s.events.every((e) => e.note === undefined)).toBe(true);
      expect(s.tzOffsetMin).toBeUndefined();
    }
    expect(bundle.sessions.find((s) => s.id === 'a1')!.startedAt).toBe(a1.startedAt);
    expect(JSON.stringify(bundle)).not.toContain('free text that must not leave');
    expect(bundle.participants.map((p) => p.code).sort()).toEqual(['SP-001', 'SP-002']);
  });

  it('only includes participants that have exported sessions', () => {
    const { bundle } = buildDeidentifiedBundle([b1], participants, { shiftDates: false, dropTzOffset: false, dropBirthYear: false }, { now: 0 });
    expect(bundle.participants.map((p) => p.code)).toEqual(['SP-002']);
  });
});
