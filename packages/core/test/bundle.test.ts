import { describe, expect, it } from 'vitest';
import type { ParticipantProfile, SurgicalSession } from '../src/types';
import { createExportBundle, parseImport } from '../src/io/bundle';
import { SessionParseError } from '../src/io/schema';

const T0 = Date.UTC(2026, 3, 1, 9, 0);
const NOW = Date.UTC(2026, 3, 2, 12, 0);

function deepFreeze<T>(x: T): T {
  if (typeof x === 'object' && x !== null && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x)) deepFreeze(v);
  }
  return x;
}

function session(id: string, code: string, startedAt = T0): SurgicalSession {
  return {
    schemaVersion: 1,
    id,
    participantCode: code,
    procedure: { name: 'Typed name', catalogId: 'carotid-endarterectomy' },
    startedAt,
    endedAt: startedAt + 3_600_000,
    status: 'completed',
    sensor: { source: 'ble', id: 'device-123' },
    app: { version: '1.0.0', platform: 'ios' },
    samples: [{ t: startedAt, bpm: 72 }],
    rr: [],
    events: [{ id: `${id}-e1`, t: startedAt + 10, type: 'marker', marker: 'note', note: 'free text' }],
  };
}

describe('createExportBundle', () => {
  it('builds a bundle and synthesises a profile for every session code without one', () => {
    const participants: ParticipantProfile[] = [{ code: 'SP-001', trainingLevel: 'consultant' }];
    const sessions = [session('a', 'SP-001'), session('b', 'SP-002'), session('c', 'SP-002')];
    deepFreeze(participants);
    deepFreeze(sessions);
    const bundle = createExportBundle({ sessions, participants, app: { version: '2.0.0', platform: 'web' }, now: NOW });
    expect(bundle).toMatchObject({
      format: 'surgeonpulse-export',
      version: 1,
      exportedAt: NOW,
      app: { version: '2.0.0', platform: 'web' },
      deidentified: false,
    });
    expect(bundle.participants).toEqual([{ code: 'SP-001', trainingLevel: 'consultant' }, { code: 'SP-002' }]);
    expect(bundle.sessions).toEqual(sessions);
    expect(bundle.sessions).not.toBe(sessions);
    expect('app' in createExportBundle({ sessions: [], now: NOW })).toBe(false);
  });

  it('de-identifies with default options when deidentify is true', () => {
    const bundle = createExportBundle({ sessions: [session('a', 'SP-001')], deidentify: true, now: NOW });
    expect(bundle.deidentified).toBe(true);
    const s = bundle.sessions[0] as SurgicalSession;
    expect('id' in s.sensor).toBe(false);
    expect(s.events[0] && 'note' in s.events[0]).toBe(false);
    expect(s.procedure.name).toBe('Carotid endarterectomy');
    expect(bundle.exportedAt).toBe(NOW);
  });

  it('passes explicit options through, shifting exportedAt with the data', () => {
    const shift = -86_400_000;
    const bundle = createExportBundle({
      sessions: [session('a', 'SP-001')],
      deidentify: { timeShiftMs: shift, dropNotes: false },
      now: NOW,
    });
    expect(bundle.deidentified).toBe(true);
    expect(bundle.exportedAt).toBe(NOW + shift);
    expect(bundle.sessions[0]?.startedAt).toBe(T0 + shift);
    expect(bundle.sessions[0]?.events[0]?.note).toBe('free text');
  });

  it('deidentify: false leaves data untouched', () => {
    const bundle = createExportBundle({ sessions: [session('a', 'SP-001')], deidentify: false, now: NOW });
    expect(bundle.deidentified).toBe(false);
    expect(bundle.sessions[0]?.sensor.id).toBe('device-123');
  });
});

describe('parseImport', () => {
  it('round-trips a bundle through JSON', () => {
    const bundle = createExportBundle({
      sessions: [session('a', 'SP-001'), session('b', 'SP-002')],
      participants: [{ code: 'SP-001', consent: { version: 'PICF-1.2', givenAt: T0 - 1 } }],
      app: { version: '2.0.0', platform: 'android' },
      now: NOW,
    });
    const { bundle: parsed, warnings } = parseImport(JSON.stringify(bundle));
    expect(warnings).toEqual([]);
    expect(parsed).toEqual(bundle);
  });

  it('accepts a single session object', () => {
    const { bundle, warnings } = parseImport(JSON.stringify(session('a', 'SP-009')));
    expect(warnings).toEqual([]);
    expect(bundle).toEqual({
      format: 'surgeonpulse-export',
      version: 1,
      exportedAt: T0 + 3_600_000,
      deidentified: false,
      participants: [{ code: 'SP-009' }],
      sessions: [session('a', 'SP-009')],
    });
  });

  it('accepts an array of sessions, skipping invalid ones with a warning naming the index and issues', () => {
    const bad = { ...session('bad', 'SP-002'), samples: [{ t: T0, bpm: 999 }] };
    const text = JSON.stringify([session('a', 'SP-001'), bad, session('c', 'SP-003', T0 + 86_400_000)]);
    const { bundle, warnings } = parseImport(text);
    expect(bundle.deidentified).toBe(false);
    expect(bundle.sessions.map((s) => s.id)).toEqual(['a', 'c']);
    expect(bundle.participants).toEqual([{ code: 'SP-001' }, { code: 'SP-003' }]);
    expect(bundle.exportedAt).toBe(T0 + 86_400_000 + 3_600_000);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('sessions[1]');
    expect(warnings[0]).toContain('samples[0].bpm');
  });

  it('skips sessions with a duplicate id', () => {
    const { bundle, warnings } = parseImport(JSON.stringify([session('a', 'SP-001'), session('a', 'SP-001')]));
    expect(bundle.sessions).toHaveLength(1);
    expect(warnings).toEqual(['Skipped sessions[1]: duplicate session id "a"']);
  });

  it('migrates and sorts sessions inside a bundle and skips invalid participants', () => {
    const s = session('a', 'SP-001');
    const raw = {
      format: 'surgeonpulse-export',
      version: 1,
      exportedAt: NOW,
      deidentified: true,
      participants: [{ code: '' }, { code: 'SP-001', unknownField: 1 }],
      sessions: [
        { ...s, samples: [{ t: T0 + 1000, bpm: 80 }, { t: T0, bpm: 70 }] },
        { ...s, id: 'future', schemaVersion: 7 },
      ],
    };
    const { bundle, warnings } = parseImport(JSON.stringify(raw));
    expect(bundle.deidentified).toBe(true);
    expect(bundle.participants).toEqual([{ code: 'SP-001' }]);
    expect(bundle.sessions).toHaveLength(1);
    expect(bundle.sessions[0]?.samples.map((x) => x.bpm)).toEqual([70, 80]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^Skipped participants\[0\]: code: /);
    expect(warnings[1]).toMatch(/^Skipped sessions\[1\]: schemaVersion: .*newer/);
  });

  it('ignores a leading byte-order mark', () => {
    const { bundle } = parseImport('﻿' + JSON.stringify([session('a', 'SP-001')]));
    expect(bundle.sessions).toHaveLength(1);
  });

  it('throws SessionParseError for input that cannot be a bundle', () => {
    const cases = [
      '',
      '{not json',
      '42',
      '"text"',
      'null',
      JSON.stringify({ format: 'other-tool', version: 1 }),
      JSON.stringify({ format: 'surgeonpulse-export', version: 1, exportedAt: NOW, deidentified: false, participants: [] }),
      JSON.stringify({ ...session('a', 'SP-001'), status: 'unknown' }),
      JSON.stringify({ hello: 'world' }),
    ];
    for (const text of cases) expect(() => parseImport(text), text).toThrow(SessionParseError);
  });

  it('reports a newer bundle version clearly', () => {
    const text = JSON.stringify({ format: 'surgeonpulse-export', version: 2, somethingNew: [] });
    try {
      parseImport(text);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SessionParseError);
      expect((err as SessionParseError).issues).toEqual([
        'version: Unsupported export bundle version 2; update SurgeonPulse to read it',
      ]);
    }
  });
});
