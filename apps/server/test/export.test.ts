import { SUMMARY_CSV_COLUMNS, parseCsv, parseImport, sessionEnd } from '@surgeonpulse/core';
import type { SurgicalSession } from '@surgeonpulse/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, bundleJson, createTestApp, enrol, simSession, upload } from './helpers';
import type { TestContext } from './helpers';

describe('exports', () => {
  let t: TestContext;
  let mine: SurgicalSession[];
  let theirs: SurgicalSession[];

  beforeAll(async () => {
    t = await createTestApp();
    const a = await enrol(t.app, 'SP-001');
    const b = await enrol(t.app, 'SP-002');
    mine = [1, 2, 3].map((seed) => simSession('SP-001', seed, { startedAt: Date.UTC(2026, 1, seed, 9) }));
    theirs = [simSession('SP-002', 9, { startedAt: Date.UTC(2026, 1, 10, 9) })];
    // A session note that must never leave the server.
    const noted = { ...theirs[0], postOp: { ...theirs[0]?.postOp, notes: 'confidential note' } } as SurgicalSession;
    await upload(t.app, a.token, bundleJson(mine, [{ code: 'SP-001', trainingLevel: 'resident', birthYear: 1995 }]));
    await upload(t.app, b.token, JSON.stringify([noted]));
  });
  afterAll(async () => {
    await t.close();
  });

  it('exports a de-identified ExportBundle attachment that core can import', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/export', headers: ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="surgeonpulse-export-20261120T000000Z.json"');
    expect(res.body).not.toContain('confidential note');

    const { bundle, warnings } = parseImport(res.body);
    expect(warnings).toEqual([]);
    expect(bundle.deidentified).toBe(true);
    expect(bundle.exportedAt).toBe(t.clock.now);
    expect(bundle.sessions.map((s) => s.id).sort()).toEqual([...mine, ...theirs].map((s) => s.id).sort());
    expect(bundle.participants).toEqual(
      expect.arrayContaining([
        { code: 'SP-001', trainingLevel: 'resident', birthYear: 1995 },
        { code: 'SP-002' },
      ]),
    );
    expect(bundle.participants).toHaveLength(2);
  });

  it('applies the list filters to the bundle', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/export?participant=SP-001&limit=2', headers: ADMIN });
    const { bundle } = parseImport(res.body);
    expect(bundle.sessions.map((s) => s.id)).toEqual(mine.slice(0, 2).map((s) => s.id));
    expect(bundle.participants.map((p) => p.code)).toEqual(['SP-001']);

    const empty = await t.app.inject({ method: 'GET', url: '/api/v1/export?participant=NOBODY', headers: ADMIN });
    expect(parseImport(empty.body).bundle.sessions).toEqual([]);
  });

  it('exports summaries as a CSV attachment (core summariesToCsv)', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/export/summaries.csv', headers: ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="surgeonpulse-summaries-20261120T000000Z.csv"');
    const rows = parseCsv(res.body);
    expect(rows[0]).toEqual([...SUMMARY_CSV_COLUMNS]);
    expect(rows).toHaveLength(1 + mine.length + theirs.length);
    const idColumn = rows[0]?.indexOf('session_id') ?? -1;
    expect(rows.slice(1).map((r) => r[idColumn])).toEqual([...mine, ...theirs].map((s) => s.id));

    const filtered = await t.app.inject({ method: 'GET', url: '/api/v1/export/summaries.csv?participant=SP-002', headers: ADMIN });
    expect(parseCsv(filtered.body)).toHaveLength(2);
  });

  it('validates export filters', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/export?from=yesterday', headers: ADMIN });
    expect(res.statusCode).toBe(400);
  });

  // PRIV-5: a shareable export hides calendar dates with a consistent secret shift per participant.
  it('with shiftDates=true shifts each participant by a secret, consistent, whole-week offset', async () => {
    const WEEK = 7 * 24 * 60 * 60 * 1000;
    const get = async (url: string) => {
      const res = await t.app.inject({ method: 'GET', url, headers: ADMIN });
      expect(res.statusCode, res.body).toBe(200);
      return res;
    };
    const real = parseImport((await get('/api/v1/export')).body).bundle;
    const first = parseImport((await get('/api/v1/export?shiftDates=true')).body).bundle;
    const again = parseImport((await get('/api/v1/export?shiftDates=1')).body).bundle;
    expect(first.deidentified).toBe(true);
    expect(again.sessions).toEqual(first.sessions); // same shift in every export

    const realById = new Map(real.sessions.map((s) => [s.id, s]));
    const shiftOf = new Map<string, number>();
    for (const s of first.sessions) {
      const r = realById.get(s.id)!;
      const shift = s.startedAt - r.startedAt;
      expect(Math.abs(shift) % WEEK).toBe(0); // weekday and time of day kept
      expect(Math.abs(shift)).toBeGreaterThanOrEqual(WEEK);
      expect(Math.abs(shift)).toBeLessThanOrEqual(52 * WEEK);
      expect(s.samples[0]!.t - r.samples[0]!.t).toBe(shift);
      expect(s.events.map((e) => e.t - shift)).toEqual(r.events.map((e) => e.t));
      expect(s.tzOffsetMin).toBe(r.tzOffsetMin);
      if (shiftOf.has(s.participantCode)) expect(shiftOf.get(s.participantCode)).toBe(shift);
      shiftOf.set(s.participantCode, shift);
    }
    expect(shiftOf.size).toBe(2);
    expect(first.exportedAt).toBe(Math.max(...first.sessions.map((s) => sessionEnd(s))));

    // The CSV uses the same per-participant shift.
    const rows = parseCsv((await get('/api/v1/export/summaries.csv?shiftDates=true')).body);
    const realRows = parseCsv((await get('/api/v1/export/summaries.csv')).body);
    const header = rows[0]!;
    const idCol = header.indexOf('session_id');
    const startCol = header.indexOf('started_at');
    const codeCol = header.indexOf('participant_code');
    const realStart = new Map(realRows.slice(1).map((r) => [r[idCol], Date.parse(r[startCol]!)]));
    for (const row of rows.slice(1)) {
      expect(Date.parse(row[startCol]!) - realStart.get(row[idCol])!).toBe(shiftOf.get(row[codeCol]!));
    }

    // The shift is not revealed anywhere in the API.
    const audit = await get('/api/v1/admin/audit');
    for (const shift of shiftOf.values()) expect(audit.body).not.toContain(String(shift));
    const bad = await t.app.inject({ method: 'GET', url: '/api/v1/export?shiftDates=maybe', headers: ADMIN });
    expect(bad.statusCode).toBe(400);
  });
});
