import { parseSession } from '@surgeonpulse/core';
import type { ProcedureInfo, SurgicalSession } from '@surgeonpulse/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, bundleJson, createTestApp, enrol, simSession, upload } from './helpers';
import type { TestContext } from './helpers';

const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 5, 8, 0);

const GENERAL: ProcedureInfo = { name: 'Laparoscopic cholecystectomy', catalogId: 'laparoscopic-cholecystectomy', specialty: 'General surgery' };
const UROLOGY: ProcedureInfo = { name: 'Cystoscopy', specialty: 'Urology' };

interface ListItem {
  id: string;
  participantCode: string;
  startedAt: number;
  specialty: string | null;
  summary: { sessionId: string };
}

describe('admin session access', () => {
  let t: TestContext;
  const sessions: SurgicalSession[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    const a = await enrol(t.app, 'SP-001');
    const b = await enrol(t.app, 'SP-002');
    // SP-001: five sessions on days 0..4 (general, urology alternating); SP-002: two sessions on days 1 and 3.
    const mine = [0, 1, 2, 3, 4].map((day) =>
      simSession('SP-001', 100 + day, { startedAt: START + day * DAY, procedure: day % 2 === 0 ? GENERAL : UROLOGY }),
    );
    const theirs = [1, 3].map((day) => simSession('SP-002', 200 + day, { startedAt: START + day * DAY + 3_600_000, procedure: GENERAL }));
    sessions.push(...mine, ...theirs);
    expect((await upload(t.app, a.token, bundleJson(mine))).statusCode).toBe(200);
    expect((await upload(t.app, b.token, bundleJson(theirs))).statusCode).toBe(200);
  });
  afterAll(async () => {
    await t.close();
  });

  async function list(query = ''): Promise<{ items: ListItem[]; total: number }> {
    const res = await t.app.inject({ method: 'GET', url: `/api/v1/sessions${query}`, headers: ADMIN });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  it('lists every session in start order with summaries and a total', async () => {
    const { items, total } = await list();
    expect(total).toBe(7);
    const expected = [...sessions].sort((x, y) => x.startedAt - y.startedAt).map((s) => s.id);
    expect(items.map((i) => i.id)).toEqual(expected);
    for (const item of items) expect(item.summary.sessionId).toBe(item.id);
  });

  it('filters by participant, specialty (case-insensitive) and time window', async () => {
    expect((await list('?participant=SP-002')).items.every((i) => i.participantCode === 'SP-002')).toBe(true);
    expect((await list('?participant=SP-002')).total).toBe(2);
    expect((await list('?specialty=urology')).total).toBe(2);
    expect((await list('?participant=SP-001&specialty=General%20surgery')).total).toBe(3);
    // from is inclusive, to is exclusive (epoch ms on startedAt).
    const window = await list(`?from=${START + DAY}&to=${START + 3 * DAY}`);
    expect(window.items.map((i) => i.startedAt)).toEqual([
      START + DAY,
      START + DAY + 3_600_000,
      START + 2 * DAY,
    ]);
    expect((await list('?participant=NOBODY')).total).toBe(0);
    expect((await list('?specialty=')).total).toBe(7); // blank filters are ignored
  });

  it('paginates with limit and offset while reporting the full total', async () => {
    const all = (await list()).items.map((i) => i.id);
    const page = await list('?limit=3&offset=2');
    expect(page.total).toBe(7);
    expect(page.items.map((i) => i.id)).toEqual(all.slice(2, 5));
    expect((await list('?limit=3&offset=6')).items.map((i) => i.id)).toEqual(all.slice(6));
    expect((await list('?offset=50')).items).toEqual([]);
  });

  it('validates query parameters', async () => {
    for (const query of ['?limit=1001', '?limit=0', '?limit=ten', '?offset=-1', '?from=abc', `?from=${START + DAY}&to=${START}`]) {
      const res = await t.app.inject({ method: 'GET', url: `/api/v1/sessions${query}`, headers: ADMIN });
      expect(res.statusCode, query).toBe(400);
      expect(res.json().error).toBe('invalid request');
      expect(res.json().details.length).toBeGreaterThan(0);
    }
  });

  it('returns the full de-identified session by id, or 404', async () => {
    const target = sessions[2] as SurgicalSession;
    const res = await t.app.inject({ method: 'GET', url: `/api/v1/sessions/${target.id}`, headers: ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    const stored = parseSession(res.json());
    expect(stored.id).toBe(target.id);
    expect(stored.samples).toEqual(target.samples);
    const missing = await t.app.inject({ method: 'GET', url: '/api/v1/sessions/does-not-exist', headers: ADMIN });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'session not found' });
  });

  it('deletes a session (204), then reports 404', async () => {
    const target = sessions[6] as SurgicalSession;
    const del = () => t.app.inject({ method: 'DELETE', url: `/api/v1/sessions/${target.id}`, headers: ADMIN });
    const first = await del();
    expect(first.statusCode).toBe(204);
    expect(first.body).toBe('');
    expect((await del()).statusCode).toBe(404);
    expect((await list()).total).toBe(6);
  });
});
