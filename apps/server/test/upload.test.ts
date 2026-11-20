import { findProcedure, parseSession } from '@surgeonpulse/core';
import type { SurgicalSession } from '@surgeonpulse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, bearer, bundleJson, createTestApp, enrol, simSession, upload } from './helpers';
import type { TestContext, UploadResponse } from './helpers';

describe('POST /api/v1/sessions', () => {
  let t: TestContext;
  let token: string;

  beforeEach(async () => {
    t = await createTestApp();
    ({ token } = await enrol(t.app, 'SP-001'));
  });
  afterEach(async () => {
    await t.close();
  });

  async function accept(body: string): Promise<UploadResponse> {
    const res = await upload(t.app, token, body);
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  async function storedSession(id: string): Promise<SurgicalSession> {
    const res = await t.app.inject({ method: 'GET', url: `/api/v1/sessions/${id}`, headers: ADMIN });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it('reports created, then unchanged, then updated', async () => {
    const a = simSession('SP-001', 1);
    const b = simSession('SP-001', 2);
    expect(await accept(bundleJson([a, b]))).toEqual({
      accepted: [
        { id: a.id, status: 'created' },
        { id: b.id, status: 'created' },
      ],
      rejected: [],
    });

    // Same content (here as a bare array of raw sessions) → same canonical digest.
    expect((await accept(JSON.stringify([a, b]))).accepted).toEqual([
      { id: a.id, status: 'unchanged' },
      { id: b.id, status: 'unchanged' },
    ]);

    const edited: SurgicalSession = { ...a, postOp: { ...a.postOp, performance: 3 } };
    expect((await accept(bundleJson([edited, b]))).accepted).toEqual([
      { id: a.id, status: 'updated' },
      { id: b.id, status: 'unchanged' },
    ]);
    expect((await storedSession(a.id)).postOp?.performance).toBe(3);
  });

  it('accepts a single session object', async () => {
    const s = simSession('SP-001', 3);
    expect(await accept(JSON.stringify(s))).toEqual({ accepted: [{ id: s.id, status: 'created' }], rejected: [] });
  });

  it('rejects sessions of another participant with a reason', async () => {
    const mine = simSession('SP-001', 4);
    const theirs = simSession('SP-999', 5);
    const result = await accept(bundleJson([theirs, mine]));
    expect(result.accepted).toEqual([{ id: mine.id, status: 'created' }]);
    expect(result.rejected).toEqual([
      { index: 0, id: theirs.id, reason: expect.stringMatching(/participantCode does not match/) },
    ]);
    const list = await t.app.inject({ method: 'GET', url: '/api/v1/sessions', headers: ADMIN });
    expect(list.json().total).toBe(1);
  });

  it('maps invalid and duplicate sessions back to their upload index', async () => {
    const a = simSession('SP-001', 6);
    const b = simSession('SP-001', 7);
    const other = simSession('SP-002', 8);
    const result = await accept(JSON.stringify([{ hello: 'world' }, a, a, other, b]));
    expect(result.accepted).toEqual([
      { id: a.id, status: 'created' },
      { id: b.id, status: 'created' },
    ]);
    expect(result.rejected.map((r) => r.index)).toEqual([0, 2, 3]);
    expect(result.rejected[0]?.reason).toMatch(/schemaVersion/);
    expect(result.rejected[1]?.reason).toMatch(/duplicate/);
    expect(result.rejected[2]).toMatchObject({ id: other.id });
  });

  it('refuses to overwrite a session id owned by another participant', async () => {
    const s = simSession('SP-001', 9);
    await accept(bundleJson([s]));
    const intruder = await enrol(t.app, 'SP-002');
    const res = await upload(t.app, intruder.token, bundleJson([{ ...s, participantCode: 'SP-002' }]));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      accepted: [],
      rejected: [{ index: 0, id: s.id, reason: 'session id conflicts with an existing session' }],
    });
    expect((await storedSession(s.id)).participantCode).toBe('SP-001');
  });

  it('strips notes, free-text procedure names and sensor ids server-side', async () => {
    const s = simSession('SP-001', 10);
    expect(s.procedure.catalogId).toBeDefined();
    const raw: SurgicalSession = {
      ...s,
      procedure: { ...s.procedure, name: 'Lap chole for Mrs Jane Doe, MRN 123456' },
      sensor: { ...s.sensor, id: 'C4:7F:51:00:11:22' },
      events: s.events.map((e, i) => ({ ...e, note: `step ${i}: patient John Smith` })),
      postOp: { ...s.postOp, notes: 'John Smith, bed 4, uneventful' },
    };
    // Sent as a raw (not de-identified) session, as a careless client might.
    await accept(JSON.stringify(raw));

    const res = await t.app.inject({ method: 'GET', url: `/api/v1/sessions/${s.id}`, headers: ADMIN });
    for (const secret of ['John Smith', 'Jane Doe', '123456', 'C4:7F:51']) expect(res.body).not.toContain(secret);
    const stored = parseSession(res.json());
    expect(stored.procedure.name).toBe(findProcedure(s.procedure.catalogId ?? '')?.name);
    expect(stored.sensor.id).toBeUndefined();
    expect(stored.postOp?.notes).toBeUndefined();
    expect(stored.events.length).toBe(s.events.length);
    expect(stored.events.every((e) => e.note === undefined)).toBe(true);
    // The physiological data itself is kept intact.
    expect(stored.samples).toEqual(s.samples);
    expect(stored.rr).toEqual(s.rr);
  });

  it('stores a summary computed server-side', async () => {
    const s = simSession('SP-001', 11);
    await accept(bundleJson([s]));
    const list = await t.app.inject({ method: 'GET', url: '/api/v1/sessions', headers: ADMIN });
    const [item] = list.json().items;
    expect(item).toMatchObject({
      id: s.id,
      participantCode: 'SP-001',
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      procedureName: s.procedure.name,
      specialty: s.procedure.specialty,
      receivedAt: t.clock.now,
    });
    expect(item.summary.sessionId).toBe(s.id);
    expect(item.summary.hr.count).toBeGreaterThan(0);
  });

  it('updates the stored profile from the bundle but never with a bare placeholder', async () => {
    const s = simSession('SP-001', 12);
    await accept(
      bundleJson(
        [s],
        [
          { code: 'SP-001', trainingLevel: 'registrar', birthYear: 1990 },
          { code: 'SP-777', trainingLevel: 'consultant' },
        ],
      ),
    );
    const profileOf = async (code: string) => {
      const res = await t.app.inject({ method: 'GET', url: '/api/v1/admin/participants', headers: ADMIN });
      return (res.json().items as { code: string; profile: unknown }[]).find((p) => p.code === code)?.profile;
    };
    expect(await profileOf('SP-001')).toEqual({ code: 'SP-001', trainingLevel: 'registrar', birthYear: 1990 });
    expect(await profileOf('SP-777')).toBeUndefined(); // other participants' profiles are ignored

    // A bundle without a profile gets a synthesised { code } from parseImport: keep the stored one.
    await accept(bundleJson([s]));
    expect(await profileOf('SP-001')).toEqual({ code: 'SP-001', trainingLevel: 'registrar', birthYear: 1990 });
  });

  it('returns 413 for a body above MAX_UPLOAD_MB', async () => {
    const small = await createTestApp({ MAX_UPLOAD_MB: '0.01' });
    try {
      const { token: smallToken } = await enrol(small.app, 'SP-001');
      const body = bundleJson([simSession('SP-001', 13)]);
      expect(body.length).toBeGreaterThan(small.config.bodyLimit);
      const res = await upload(small.app, smallToken, body);
      expect(res.statusCode).toBe(413);
      expect(res.json()).toEqual({ error: 'payload too large' });
    } finally {
      await small.close();
    }
  });

  it('returns 400 for invalid JSON without echoing it into logs or errors beyond the issue', async () => {
    const res = await upload(t.app, token, '{"format": "surgeonpulse-export", oops');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid upload', details: [expect.stringMatching(/Not valid JSON/)] });
  });

  it('returns 400 for empty or session-less bodies and unsupported bundles', async () => {
    const cases: [string, string][] = [
      ['', 'empty body'],
      ['   ', 'empty body'],
      ['[]', 'no sessions in upload'],
      ['{"format":"surgeonpulse-export","version":1,"exportedAt":0,"deidentified":true,"participants":[],"sessions":[]}', 'no sessions in upload'],
      ['{"format":"surgeonpulse-export","version":2,"exportedAt":0,"deidentified":true,"participants":[],"sessions":[]}', 'invalid upload'],
      ['42', 'invalid upload'],
      ['{"id":"lonely"}', 'invalid upload'],
    ];
    for (const [body, error] of cases) {
      const res = await upload(t.app, token, body);
      expect(res.statusCode, body).toBe(400);
      expect(res.json().error, body).toBe(error);
    }
  });

  it('returns 400 when no body is sent at all and 415 for other media types', async () => {
    const none = await t.app.inject({ method: 'POST', url: '/api/v1/sessions', headers: bearer(token) });
    expect(none.statusCode).toBe(400);
    expect(none.json()).toEqual({ error: 'empty body' });
    const xml = await t.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { ...bearer(token), 'content-type': 'application/xml' },
      payload: '<session/>',
    });
    expect(xml.statusCode).toBe(415);
    expect(xml.json().error).toBe('unsupported media type');
  });

  it('confirms enrolment and counts uploads via GET /me', async () => {
    const before = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(token) });
    expect(before.json()).toEqual({ participantCode: 'SP-001', sessionCount: 0, lastUploadAt: null });
    await accept(bundleJson([simSession('SP-001', 14), simSession('SP-001', 15)]));
    const after = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(token) });
    expect(after.json()).toEqual({ participantCode: 'SP-001', sessionCount: 2, lastUploadAt: t.clock.now });
  });
});
