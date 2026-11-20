import { describe, expect, it, vi } from 'vitest';
import { createExportBundle } from '@surgeonpulse/core';
import { makeSession } from '../test/fixtures';
import { ServerError, exportUrl, fetchExportBundle, isInsecureRemote, normaliseServerUrl } from './serverClient';

const TOKEN = 'admin-token-0123456789abcdef0123456789abcdef';

function bundleJson(): string {
  const bundle = createExportBundle({ sessions: [makeSession({ seed: 3 })], now: Date.UTC(2026, 1, 1), deidentify: true });
  return JSON.stringify(bundle);
}

function mockFetch(response: Response | Error) {
  return vi.fn<typeof fetch>(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
}

async function rejection(p: Promise<unknown>): Promise<ServerError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ServerError);
    return err as ServerError;
  }
  throw new Error('expected a rejection');
}

describe('normaliseServerUrl', () => {
  it('trims, strips trailing slashes, query and hash', () => {
    expect(normaliseServerUrl('  https://study.example.edu/sp/  ')).toBe('https://study.example.edu/sp');
    expect(normaliseServerUrl('https://study.example.edu/?x=1#y')).toBe('https://study.example.edu');
    expect(normaliseServerUrl('http://localhost:8787')).toBe('http://localhost:8787');
  });

  it('rejects empty, non-http and credential-bearing URLs', () => {
    for (const bad of ['', 'not a url', 'ftp://example.edu', 'https://user:pw@example.edu']) {
      expect(() => normaliseServerUrl(bad)).toThrow(ServerError);
    }
  });

  it('flags plain HTTP to non-local hosts', () => {
    expect(isInsecureRemote('http://study.example.edu')).toBe(true);
    expect(isInsecureRemote('http://localhost:8787')).toBe(false);
    expect(isInsecureRemote('http://127.0.0.1:8787')).toBe(false);
    expect(isInsecureRemote('https://study.example.edu')).toBe(false);
  });

  it('builds the export URL with optional filters', () => {
    expect(exportUrl('https://s.example.edu/')).toBe('https://s.example.edu/api/v1/export');
    expect(exportUrl('https://s.example.edu/base', { participant: 'SP-001', from: 10.7, to: 20 })).toBe(
      'https://s.example.edu/base/api/v1/export?participant=SP-001&from=10&to=20',
    );
  });
});

describe('fetchExportBundle', () => {
  it('sends the bearer token without cookies or referrer and parses the bundle', async () => {
    const fetchImpl = mockFetch(new Response(bundleJson(), { status: 200, headers: { 'content-type': 'application/json' } }));
    const { bundle, warnings } = await fetchExportBundle({ url: 'https://s.example.edu/', token: ` ${TOKEN} ` }, {}, { fetchImpl });
    expect(bundle.sessions).toHaveLength(1);
    expect(bundle.deidentified).toBe(true);
    expect(warnings).toEqual([]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://s.example.edu/api/v1/export');
    expect(init).toBeDefined();
    const req = init!;
    expect(req.method).toBe('GET');
    expect(req.credentials).toBe('omit');
    expect(req.referrerPolicy).toBe('no-referrer');
    expect(req.cache).toBe('no-store');
    expect((req.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('reports a rejected token without echoing it', async () => {
    const err = await rejection(
      fetchExportBundle({ url: 'https://s.example.edu', token: TOKEN }, {}, {
        fetchImpl: mockFetch(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })),
      }),
    );
    expect(err.kind).toBe('unauthorized');
    expect(err.status).toBe(401);
    expect(err.message).not.toContain(TOKEN);
  });

  it('explains network/CORS failures', async () => {
    const err = await rejection(
      fetchExportBundle({ url: 'https://s.example.edu', token: TOKEN }, {}, { fetchImpl: mockFetch(new TypeError('Failed to fetch')) }),
    );
    expect(err.kind).toBe('network');
    expect(err.message).toContain('CORS_ORIGINS');
    expect(err.message).not.toContain(TOKEN);
  });

  it('maps HTTP errors to readable messages', async () => {
    const err500 = await rejection(
      fetchExportBundle({ url: 'https://s.example.edu', token: TOKEN }, {}, { fetchImpl: mockFetch(new Response('', { status: 503 })) }),
    );
    expect(err500).toMatchObject({ kind: 'http', status: 503 });
    const err404 = await rejection(
      fetchExportBundle({ url: 'https://s.example.edu', token: TOKEN }, {}, { fetchImpl: mockFetch(new Response('', { status: 404 })) }),
    );
    expect(err404.message).toContain('404');
  });

  it('rejects responses that are not SurgeonPulse exports', async () => {
    const err = await rejection(
      fetchExportBundle({ url: 'https://s.example.edu', token: TOKEN }, {}, { fetchImpl: mockFetch(new Response('<html>login</html>', { status: 200 })) }),
    );
    expect(err.kind).toBe('parse');
  });

  it('validates inputs before making a request', async () => {
    const fetchImpl = mockFetch(new Response('{}'));
    expect((await rejection(fetchExportBundle({ url: '', token: TOKEN }, {}, { fetchImpl }))).kind).toBe('invalid-url');
    expect((await rejection(fetchExportBundle({ url: 'https://s.example.edu', token: '  ' }, {}, { fetchImpl }))).kind).toBe(
      'missing-token',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports cancellation', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const err = await rejection(
      fetchExportBundle({ url: 'https://s.example.edu', token: TOKEN }, {}, { fetchImpl: mockFetch(abort) }),
    );
    expect(err.kind).toBe('aborted');
  });
});
