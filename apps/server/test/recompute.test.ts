/**
 * RV-13: summaries computed by older analytics definitions must not stay in the
 * research exports next to current ones. They are refreshed at start-up and
 * when the same session is uploaded again.
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ANALYTICS_VERSION, parseCsv } from '@surgeonpulse/core';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { databasePath } from '../src/db';
import { ADMIN, bundleJson, createTestApp, enrol, simSession, upload } from './helpers';
import type { TestContext, UploadResponse } from './helpers';

let t: TestContext;
let reopened: FastifyInstance | null = null;

afterEach(async () => {
  if (reopened !== null) await reopened.close();
  reopened = null;
  await t.close();
});

/** Make the stored summary of `id` look like one written before analytics versions existed. */
function ageSummary(dataDir: string, id: string): void {
  const db = new DatabaseSync(databasePath(dataDir));
  try {
    const row = db.prepare('SELECT summary FROM sessions WHERE id = ?').get(id) as { summary: string };
    const summary = JSON.parse(row.summary) as Record<string, unknown>;
    delete summary.analyticsVersion;
    summary.stressIndex = 1;
    db.prepare('UPDATE sessions SET summary = ? WHERE id = ?').run(JSON.stringify(summary), id);
  } finally {
    db.close();
  }
}

async function csvRow(app: FastifyInstance): Promise<Record<string, string>> {
  const res = await app.inject({ method: 'GET', url: '/api/v1/export/summaries.csv', headers: ADMIN });
  const [header, row] = parseCsv(res.body);
  return Object.fromEntries(header!.map((h, i) => [h, row![i]!]));
}

describe('analytics version of stored summaries', () => {
  it('exports the analytics version with every summary', async () => {
    t = await createTestApp();
    const { token } = await enrol(t.app, 'SP-001');
    expect((await upload(t.app, token, bundleJson([simSession('SP-001', 1)]))).statusCode).toBe(200);
    expect((await csvRow(t.app)).analytics_version).toBe(ANALYTICS_VERSION);
  });

  it('recomputes summaries from an older version when the server starts', async () => {
    t = await createTestApp();
    const { token } = await enrol(t.app, 'SP-001');
    const session = simSession('SP-001', 2);
    await upload(t.app, token, bundleJson([session]));
    const fresh = await csvRow(t.app);
    await t.app.close();
    ageSummary(t.dataDir, session.id);

    reopened = buildApp(t.config, { now: () => t.clock.now });
    await reopened.ready();
    const row = await csvRow(reopened);
    expect(row.analytics_version).toBe(ANALYTICS_VERSION);
    expect(row.stress_index).toBe(fresh.stress_index);
    const audit = await reopened.inject({ method: 'GET', url: '/api/v1/admin/audit', headers: ADMIN });
    expect(JSON.stringify(audit.json())).toContain('summaries.recompute');
    // t.close() must not close the original (already closed) app twice
    t.app = reopened;
    reopened = null;
  });

  it('refreshes an old summary when the unchanged session is uploaded again', async () => {
    t = await createTestApp();
    const { token } = await enrol(t.app, 'SP-001');
    const session = simSession('SP-001', 3);
    const body = bundleJson([session]);
    await upload(t.app, token, body);
    const fresh = await csvRow(t.app);
    ageSummary(t.dataDir, session.id);
    expect((await csvRow(t.app)).analytics_version).toBe('');

    const res = await upload(t.app, token, body);
    expect((res.json() as UploadResponse).accepted).toEqual([{ id: session.id, status: 'unchanged' }]);
    const row = await csvRow(t.app);
    expect(row.analytics_version).toBe(ANALYTICS_VERSION);
    expect(row.stress_index).toBe(fresh.stress_index);
  });
});

