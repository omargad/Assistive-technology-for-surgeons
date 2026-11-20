import { SUMMARY_CSV_COLUMNS, parseCsv, parseImport } from '@surgeonpulse/core';
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
});
