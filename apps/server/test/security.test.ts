import { afterEach, describe, expect, it } from 'vitest';
import { SECURITY_HEADERS } from '../src/http';
import { VERSION } from '../src/version';
import { ADMIN, ADMIN_TOKEN, bearer, bundleJson, createTestApp, enrol, simSession, upload } from './helpers';
import type { TestContext } from './helpers';

const DASHBOARD = 'https://dashboard.example.org';

describe('HTTP hardening', () => {
  const contexts: TestContext[] = [];
  async function app(env: Record<string, string> = {}, options = {}): Promise<TestContext> {
    const t = await createTestApp(env, options);
    contexts.push(t);
    return t;
  }
  afterEach(async () => {
    for (const t of contexts.splice(0)) await t.close();
  });

  function expectSecurityHeaders(headers: Record<string, unknown>): void {
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(headers[name.toLowerCase()]).toBe(value);
  }

  it('serves /health without authentication', async () => {
    const { app: a } = await app();
    const res = await a.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', version: VERSION });
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('adds security headers to success, error, 404 and attachment responses', async () => {
    const t = await app({ MAX_UPLOAD_MB: '0.001' });
    const { token } = await enrol(t.app, 'SP-001');
    const responses = await Promise.all([
      t.app.inject({ method: 'GET', url: '/health' }),
      t.app.inject({ method: 'GET', url: '/api/v1/admin/participants' }),
      t.app.inject({ method: 'GET', url: '/api/v1/nothing-here' }),
      t.app.inject({ method: 'GET', url: '/api/v1/export/summaries.csv', headers: ADMIN }),
      upload(t.app, token, 'x'.repeat(5000)),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 401, 404, 200, 413]);
    for (const res of responses) expectSecurityHeaders(res.headers);
  });

  it('returns JSON 404s for unknown routes and methods', async () => {
    const { app: a } = await app();
    for (const [method, url] of [
      ['GET', '/'],
      ['GET', '/api/v2/sessions'],
      ['PUT', '/api/v1/sessions'],
      ['POST', '/health'],
    ] as const) {
      const res = await a.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.json()).toEqual({ error: 'not found' });
    }
  });

  it('sends no CORS headers unless origins are configured', async () => {
    const { app: a } = await app();
    const res = await a.inject({ method: 'GET', url: '/health', headers: { origin: DASHBOARD } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await a.inject({
      method: 'OPTIONS',
      url: '/api/v1/export',
      headers: { origin: DASHBOARD, 'access-control-request-method': 'GET' },
    });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows only the configured CORS origins (for the dashboard and the app web build)', async () => {
    const { app: a } = await app({ CORS_ORIGINS: `${DASHBOARD}, http://localhost:8081` });
    const preflight = await a.inject({
      method: 'OPTIONS',
      url: '/api/v1/admin/enrolments/abc',
      headers: {
        origin: DASHBOARD,
        'access-control-request-method': 'DELETE',
        'access-control-request-headers': 'authorization, content-type',
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(DASHBOARD);
    expect(String(preflight.headers['access-control-allow-methods'])).toContain('DELETE');
    expect(String(preflight.headers['access-control-allow-headers']).toLowerCase()).toContain('authorization');
    expectSecurityHeaders(preflight.headers);

    const res = await a.inject({ method: 'GET', url: '/api/v1/export', headers: { ...ADMIN, origin: 'http://localhost:8081' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:8081');
    expect(String(res.headers['access-control-expose-headers'])).toContain('Content-Disposition');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();

    const evil = await a.inject({ method: 'GET', url: '/health', headers: { origin: 'https://evil.example.com' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('lets allowed browser origins read 401 and 429 responses (and Retry-After)', async () => {
    const { app: a } = await app({ CORS_ORIGINS: DASHBOARD });
    const headers = { ...bearer('wrong-token'), origin: DASHBOARD };
    let res = await a.inject({ method: 'GET', url: '/api/v1/admin/participants', headers });
    expect(res.statusCode).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBe(DASHBOARD);
    for (let i = 0; i < 10; i++) res = await a.inject({ method: 'GET', url: '/api/v1/admin/participants', headers });
    expect(res.statusCode).toBe(429);
    expect(res.headers['access-control-allow-origin']).toBe(DASHBOARD);
    expect(String(res.headers['access-control-expose-headers'])).toContain('Retry-After');
    expectSecurityHeaders(res.headers);
  });

  it('never logs Authorization headers, tokens or request bodies', async () => {
    const lines: string[] = [];
    const t = await app({ LOG_LEVEL: 'trace' }, { logStream: { write: (line: string) => lines.push(line) } });
    const { token } = await enrol(t.app, 'SP-001');
    const session = simSession('SP-001', 1);
    const marked = { ...session, postOp: { ...session.postOp, notes: 'SECRET-MARKER-NOTE' } };
    await upload(t.app, token, JSON.stringify(marked));
    await upload(t.app, token, '{"broken": "SECRET-MARKER-BROKEN"');
    await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/participants',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      payload: '{"code": "SECRET-MARKER-JSON"',
    });
    await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: 'Bearer spk_SECRET-MARKER-BAD' } });
    await upload(t.app, token, bundleJson([session]));

    expect(lines.length).toBeGreaterThan(5); // request logging is on
    const log = lines.join('\n');
    for (const secret of [ADMIN_TOKEN, token, token.slice(4), 'SECRET-MARKER', '"samples"', '"bpm"']) {
      expect(log).not.toContain(secret);
    }
    expect(log).not.toMatch(/authorization/i);
  });

  it('uses the client IP from X-Forwarded-For only when TRUST_PROXY is on', async () => {
    const direct = await app();
    const proxied = await app({ TRUST_PROXY: 'true' });
    const flood = async (t: TestContext) => {
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        const res = await t.app.inject({
          method: 'GET',
          url: '/api/v1/me',
          headers: { ...bearer('spk_x'), 'x-forwarded-for': `203.0.113.${i}` },
        });
        statuses.push(res.statusCode);
      }
      return statuses;
    };
    // Behind a trusted proxy each forwarded client has its own bucket; otherwise they share the proxy's.
    expect((await flood(proxied)).every((s) => s === 401)).toBe(true);
    expect((await flood(direct)).at(-1)).toBe(429);
  });
});
