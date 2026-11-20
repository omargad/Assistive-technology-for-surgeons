import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { databasePath } from '../src/db';
import { ADMIN, bearer, bundleJson, createTestApp, enrol, simSession, upload } from './helpers';
import type { TestContext } from './helpers';

interface AuditItem {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string | null;
  detail: unknown;
}

describe('audit log', () => {
  let t: TestContext;

  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  async function audit(): Promise<AuditItem[]> {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/admin/audit', headers: ADMIN });
    expect(res.statusCode).toBe(200);
    return res.json().items;
  }

  it('records every mutating call with actor, action and target, newest first', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/participants',
      headers: ADMIN,
      payload: { code: 'SP-001', profile: { trainingLevel: 'registrar' } },
    });
    expect(created.statusCode).toBe(201);
    const updated = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/participants',
      headers: ADMIN,
      payload: { code: 'SP-001', profile: { trainingLevel: 'fellow' } },
    });
    expect(updated.statusCode).toBe(200);
    const { id: enrolmentId, token } = await enrol(t.app, 'SP-001');
    const session = simSession('SP-001', 1);
    await upload(t.app, token, bundleJson([session]));
    await t.app.inject({ method: 'DELETE', url: `/api/v1/sessions/${session.id}`, headers: ADMIN });
    await t.app.inject({ method: 'DELETE', url: `/api/v1/admin/enrolments/${enrolmentId}`, headers: ADMIN });
    await enrol(t.app, 'SP-002'); // creates the participant implicitly
    await t.app.inject({ method: 'DELETE', url: '/api/v1/admin/participants/SP-002', headers: ADMIN });
    await t.app.inject({ method: 'GET', url: '/api/v1/export', headers: ADMIN });

    const rows = await audit();
    expect(rows.map((r) => [r.actor, r.action, r.target])).toEqual(
      [
        ['admin', 'participant.create', 'SP-001'],
        ['admin', 'participant.update', 'SP-001'],
        ['admin', 'enrolment.create', enrolmentId],
        ['participant:SP-001', 'sessions.upload', 'SP-001'],
        ['admin', 'session.delete', session.id],
        ['admin', 'enrolment.revoke', enrolmentId],
        ['admin', 'participant.create', 'SP-002'],
        ['admin', 'enrolment.create', expect.any(String)],
        ['admin', 'participant.withdraw', 'SP-002'],
        ['admin', 'export.bundle', null],
      ].reverse(),
    );
    expect(rows.find((r) => r.action === 'sessions.upload')?.detail).toEqual({
      created: 1,
      updated: 0,
      unchanged: 0,
      rejected: 0,
      profileUpdated: false,
    });
    for (const row of rows) expect(row.at).toBe(t.clock.now);

    // Audit rows never contain secrets or health data.
    const text = JSON.stringify(rows);
    expect(text).not.toContain(token);
    expect(text).not.toContain('bpm');
    expect(text).not.toContain('registrar');
  });

  it('does not audit failed or read-only calls', async () => {
    await t.app.inject({ method: 'GET', url: '/api/v1/admin/participants', headers: ADMIN });
    await t.app.inject({ method: 'POST', url: '/api/v1/admin/participants', headers: ADMIN, payload: { code: 'a@b.org' } });
    await t.app.inject({ method: 'DELETE', url: '/api/v1/sessions/missing', headers: ADMIN });
    await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer('spk_nope') });
    expect(await audit()).toEqual([]);
  });

  it('returns only the latest 500 rows', async () => {
    const db = new DatabaseSync(databasePath(t.dataDir));
    try {
      const insert = db.prepare("INSERT INTO audit (at, actor, action, target) VALUES (?, 'test', 'bulk', ?)");
      db.exec('BEGIN');
      for (let i = 0; i < 620; i++) insert.run(i, String(i));
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    const rows = await audit();
    expect(rows).toHaveLength(500);
    expect(rows[0]?.target).toBe('619');
    expect(rows[499]?.target).toBe('120');
  });
});
