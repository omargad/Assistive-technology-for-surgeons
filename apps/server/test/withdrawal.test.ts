import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { databasePath } from '../src/db';
import { ADMIN, ADMIN_TOKEN, bearer, bundleJson, createTestApp, enrol, makeTempDir, removeDir, simSession, upload } from './helpers';
import type { TestContext } from './helpers';

/** Database file plus its WAL (if any), as one latin1 string, read while the server is still running. */
function diskBytes(dataDir: string): string {
  const main = databasePath(dataDir);
  let wal = '';
  try {
    wal = readFileSync(`${main}-wal`, 'latin1');
  } catch {
    // no WAL file
  }
  return readFileSync(main, 'latin1') + wal;
}

describe('withdrawal erases data from the database file', () => {
  // PRIV-2: secure_delete does not cover the WAL, which kept the original INSERT frames until shutdown.
  it('leaves no copy of withdrawn or deleted sessions in the WAL file while the server runs', async () => {
    const dataDir = await makeTempDir();
    const app = buildApp(loadConfig({ ADMIN_TOKEN, DATA_DIR: dataDir, LOG_LEVEL: 'silent', ACCEPT_SIMULATED: 'true' }));
    try {
      const marker = 'WAL-RESIDUE-MARKER-91c2';
      const mk = (code: string, seed: number) => {
        const s = simSession(code, seed);
        return { ...s, app: { ...s.app, version: marker } }; // app.version survives de-identification
      };
      const leaving = await enrol(app, 'SP-060');
      const staying = await enrol(app, 'SP-061');
      const withdrawn = [mk('SP-060', 1), mk('SP-060', 2)];
      const deleted = mk('SP-061', 3);
      expect((await upload(app, leaving.token, bundleJson(withdrawn))).statusCode).toBe(200);
      expect((await upload(app, staying.token, bundleJson([deleted]))).statusCode).toBe(200);
      expect(diskBytes(dataDir)).toContain(marker);

      const res = await app.inject({ method: 'POST', url: '/api/v1/me/withdraw', headers: bearer(leaving.token) });
      expect(res.json()).toEqual({ deletedSessions: 2 });
      const del = await app.inject({ method: 'DELETE', url: `/api/v1/sessions/${deleted.id}`, headers: ADMIN });
      expect(del.statusCode).toBe(204);

      const bytes = diskBytes(dataDir);
      expect(bytes).not.toContain(marker);
      expect(bytes).not.toContain('"samples":[');
      for (const s of withdrawn) expect(bytes).not.toContain(s.id);
      // The deleted session's random id stays only in its audit row (`session.delete` target).
      const audit = await app.inject({ method: 'GET', url: '/api/v1/admin/audit', headers: ADMIN });
      expect(audit.body).toContain(deleted.id);
    } finally {
      await app.close();
      await removeDir(dataDir);
    }
  });

  it('leaves no recoverable session content in free pages (secure_delete)', async () => {
    const dataDir = await makeTempDir();
    try {
      const app = buildApp(loadConfig({ ADMIN_TOKEN, DATA_DIR: dataDir, LOG_LEVEL: 'silent', ACCEPT_SIMULATED: 'true' }));
      const { token } = await enrol(app, 'SP-050');
      const marker = 'UNIQUE-PROCEDURE-MARKER-7f3a';
      const s = simSession('SP-050', 1, { procedure: { name: marker, specialty: 'General surgery' } });
      expect((await upload(app, token, bundleJson([s]))).statusCode).toBe(200);
      const res = await app.inject({ method: 'POST', url: '/api/v1/me/withdraw', headers: bearer(token) });
      expect(res.json()).toEqual({ deletedSessions: 1 });
      await app.close(); // checkpoints the WAL into the main file

      const bytes = readFileSync(databasePath(dataDir), 'latin1');
      expect(bytes).not.toContain(marker);
      expect(bytes).not.toContain(s.id);
      expect(bytes).not.toContain('"samples":[');
    } finally {
      await removeDir(dataDir);
    }
  });
});

interface ParticipantItem {
  code: string;
  profile: Record<string, unknown>;
  withdrawn: boolean;
  withdrawnAt: number | null;
  sessionCount: number;
  enrolmentCount: number;
  activeEnrolmentCount: number;
}

describe('withdrawal', () => {
  let t: TestContext;
  let phone: { token: string };
  let tablet: { token: string };
  let bystander: { token: string };

  beforeEach(async () => {
    t = await createTestApp();
    phone = await enrol(t.app, 'SP-001', 'phone');
    tablet = await enrol(t.app, 'SP-001', 'tablet');
    bystander = await enrol(t.app, 'SP-002');
    const profile = [{ code: 'SP-001', trainingLevel: 'fellow' as const, birthYear: 1988 }];
    await upload(t.app, phone.token, bundleJson([simSession('SP-001', 1), simSession('SP-001', 2)], profile));
    await upload(t.app, tablet.token, bundleJson([simSession('SP-001', 3)]));
    await upload(t.app, bystander.token, bundleJson([simSession('SP-002', 4)]));
  });
  afterEach(async () => {
    await t.close();
  });

  async function participants(): Promise<Record<string, ParticipantItem>> {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/admin/participants', headers: ADMIN });
    return Object.fromEntries((res.json().items as ParticipantItem[]).map((p) => [p.code, p]));
  }

  async function sessionsOf(code: string): Promise<number> {
    const res = await t.app.inject({ method: 'GET', url: `/api/v1/sessions?participant=${code}`, headers: ADMIN });
    return res.json().total;
  }

  async function expectWithdrawn(): Promise<void> {
    // Sessions gone, every enrolment revoked, participant marked withdrawn with the profile cleared.
    expect(await sessionsOf('SP-001')).toBe(0);
    for (const token of [phone.token, tablet.token]) {
      const res = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(token) });
      expect(res.statusCode).toBe(401);
    }
    const { 'SP-001': p, 'SP-002': other } = await participants();
    expect(p).toMatchObject({
      code: 'SP-001',
      profile: { code: 'SP-001' },
      withdrawn: true,
      withdrawnAt: t.clock.now,
      sessionCount: 0,
      enrolmentCount: 2,
      activeEnrolmentCount: 0,
    });
    // Other participants are untouched.
    expect(other).toMatchObject({ withdrawn: false, sessionCount: 1, activeEnrolmentCount: 1 });
    expect(await sessionsOf('SP-002')).toBe(1);

    // The code is retired: no new enrolments or profile updates, and uploads are refused.
    const again = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/enrolments',
      headers: ADMIN,
      payload: { participantCode: 'SP-001' },
    });
    expect(again.statusCode).toBe(409);
    const update = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/participants',
      headers: ADMIN,
      payload: { code: 'SP-001', profile: { trainingLevel: 'consultant' } },
    });
    expect(update.statusCode).toBe(409);
    expect((await upload(t.app, phone.token, bundleJson([simSession('SP-001', 5)]))).statusCode).toBe(401);
  }

  it('participant-initiated: POST /me/withdraw deletes sessions, revokes tokens and marks withdrawn', async () => {
    expect((await participants())['SP-001']?.profile).toEqual({ code: 'SP-001', trainingLevel: 'fellow', birthYear: 1988 });
    t.clock.now += 5_000;
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/me/withdraw', headers: bearer(phone.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deletedSessions: 3 });
    await expectWithdrawn();

    const audit = await t.app.inject({ method: 'GET', url: '/api/v1/admin/audit', headers: ADMIN });
    expect(audit.json().items).toContainEqual(
      expect.objectContaining({
        actor: 'participant:SP-001',
        action: 'participant.withdraw',
        target: 'SP-001',
        detail: { deletedSessions: 3, revokedEnrolments: 2 },
      }),
    );
  });

  it('accepts a JSON content type with an empty body for /me/withdraw', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/me/withdraw',
      headers: { ...bearer(tablet.token), 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deletedSessions: 3 });
  });

  it('researcher-actioned: DELETE /admin/participants/:code has the same effect', async () => {
    t.clock.now += 5_000;
    const res = await t.app.inject({ method: 'DELETE', url: '/api/v1/admin/participants/SP-001', headers: ADMIN });
    expect(res.statusCode).toBe(204);
    await expectWithdrawn();

    const audit = await t.app.inject({ method: 'GET', url: '/api/v1/admin/audit', headers: ADMIN });
    expect(audit.json().items[0]).toMatchObject({
      actor: 'admin',
      action: 'participant.withdraw',
      target: 'SP-001',
      detail: { deletedSessions: 3, revokedEnrolments: 2 },
    });
    // Idempotent; unknown codes are 404.
    expect((await t.app.inject({ method: 'DELETE', url: '/api/v1/admin/participants/SP-001', headers: ADMIN })).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/v1/admin/participants/NOPE', headers: ADMIN })).statusCode).toBe(404);
  });
});
