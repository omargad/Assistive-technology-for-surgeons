/// <reference types="jest" />
import { createSession } from '@surgeonpulse/core';
import type { ExportBundle, SurgicalSession } from '@surgeonpulse/core';
import { UploadError, createUploader, normalizeServerUrl } from '../client';
import type { FetchLike } from '../client';

const T0 = Date.UTC(2026, 2, 2, 8, 0, 0);

function session(id: string, extra: Partial<SurgicalSession> = {}): SurgicalSession {
  const s = createSession({
    id,
    participantCode: 'SP-014',
    procedure: { name: 'Appendicectomy for Mrs Smith', catalogId: 'laparoscopic-appendicectomy', approach: 'laparoscopic' },
    sensor: { source: 'ble', name: 'Polar H10', id: 'AA:BB:CC' },
    app: { version: '0.1.0', platform: 'ios' },
    startedAt: T0,
  });
  return {
    ...s,
    status: 'completed',
    endedAt: T0 + 60_000,
    samples: [{ t: T0, bpm: 70 }],
    events: [{ id: 'e1', t: T0 + 1000, type: 'marker', marker: 'note', note: 'patient name here' }],
    postOp: { performance: 7, notes: 'free text' },
    ...extra,
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k] ?? headers[k.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

const CFG = { url: 'https://research.example.edu/', token: 'spk_secret-token', profile: { code: 'SP-014' } };

describe('normalizeServerUrl', () => {
  it('adds https, trims slashes and rejects insecure remote hosts', () => {
    expect(normalizeServerUrl(' research.example.edu/ ')).toBe('https://research.example.edu');
    expect(normalizeServerUrl('https://r.example.edu:8443/base//')).toBe('https://r.example.edu:8443/base');
    expect(normalizeServerUrl('http://localhost:8787')).toBe('http://localhost:8787');
    expect(normalizeServerUrl('http://192.168.1.20:8787')).toBe('http://192.168.1.20:8787');
    expect(normalizeServerUrl('http://10.0.2.2:8787')).toBe('http://10.0.2.2:8787');
    expect(() => normalizeServerUrl('http://research.example.edu')).toThrow(/https/);
    expect(() => normalizeServerUrl('')).toThrow(UploadError);
    expect(() => normalizeServerUrl('ftp://x')).toThrow(/valid/);
  });
});

describe('uploadSessions', () => {
  it('POSTs a de-identified export bundle with the bearer token', async () => {
    const fetch = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(async () =>
      jsonResponse(200, { accepted: [{ id: 'a', status: 'created' }], rejected: [] }),
    );
    const uploader = createUploader({ fetch, now: () => T0 + 1, app: () => ({ version: '0.1.0', platform: 'ios' }) });
    const result = await uploader.uploadSessions([session('a')], CFG);

    expect(result).toEqual({ accepted: [{ id: 'a', status: 'created' }], rejected: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://research.example.edu/api/v1/sessions');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: 'Bearer spk_secret-token',
    });
    expect(init?.signal).toBeDefined();

    const bundle = JSON.parse(String(init?.body)) as ExportBundle;
    expect(bundle.format).toBe('surgeonpulse-export');
    expect(bundle.deidentified).toBe(true);
    expect(bundle.exportedAt).toBe(T0 + 1);
    expect(bundle.participants.map((p) => p.code)).toEqual(['SP-014']);
    const sent = bundle.sessions[0]!;
    expect(sent.id).toBe('a');
    expect(sent.sensor.id).toBeUndefined();
    expect(sent.postOp?.notes).toBeUndefined();
    expect(sent.events[0]?.note).toBeUndefined();
    // Free-text name replaced by the catalogue name when the id resolves.
    expect(sent.procedure.name).toBe('Laparoscopic appendicectomy');
  });

  it('never sends demo data or sessions still recording', async () => {
    const fetch = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(async () =>
      jsonResponse(200, { accepted: [{ id: 'ok', status: 'updated' }], rejected: [] }),
    );
    const result = await createUploader({ fetch }).uploadSessions(
      [session('demo1', { tags: ['demo'] }), session('ok'), session('live', { status: 'recording' })],
      CFG,
    );
    expect(result.accepted).toEqual([{ id: 'ok', status: 'updated' }]);
    expect(result.rejected).toEqual([
      { index: 0, id: 'demo1', reason: expect.stringContaining('Demo') },
      { index: 2, id: 'live', reason: expect.stringContaining('recorded') },
    ]);
    const bundle = JSON.parse(String(fetch.mock.calls[0]![1]?.body)) as ExportBundle;
    expect(bundle.sessions.map((s) => s.id)).toEqual(['ok']);

    const none = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>();
    await createUploader({ fetch: none }).uploadSessions([session('d', { tags: ['demo'] })], CFG);
    expect(none).not.toHaveBeenCalled();
  });

  it('splits large uploads and maps server rejection indices back to the input', async () => {
    const fetch = jest
      .fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValueOnce(jsonResponse(200, { accepted: [{ id: 'a', status: 'created' }], rejected: [] }))
      .mockResolvedValueOnce(
        jsonResponse(200, { accepted: [], rejected: [{ index: 0, id: 'b', reason: 'participant mismatch' }] }),
      );
    const one = JSON.stringify(session('a')).length;
    const result = await createUploader({ fetch, maxRequestChars: one + 10 }).uploadSessions(
      [session('a'), session('b')],
      CFG,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      accepted: [{ id: 'a', status: 'created' }],
      rejected: [{ index: 1, id: 'b', reason: 'participant mismatch' }],
    });
  });

  it.each([
    [401, 'unauthorized', /enrolment token/],
    [403, 'unauthorized', /enrolment token/],
    [413, 'too-large', /fewer sessions/],
    [500, 'server', /HTTP 500/],
  ] as const)('maps HTTP %i to a clear %s error', async (status, kind, message) => {
    const fetch = jest.fn(async () => jsonResponse(status, { error: 'x' }));
    const err = await createUploader({ fetch })
      .uploadSessions([session('a')], CFG)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).kind).toBe(kind);
    expect((err as UploadError).status).toBe(status);
    expect((err as Error).message).toMatch(message);
    expect((err as Error).message).not.toContain('spk_secret-token');
  });

  it('reports rate limiting with Retry-After', async () => {
    const fetch = jest.fn(async () => jsonResponse(429, { error: 'rate_limited' }, { 'Retry-After': '42' }));
    const err = (await createUploader({ fetch })
      .uploadSessions([session('a')], CFG)
      .catch((e: unknown) => e)) as UploadError;
    expect(err.kind).toBe('rate-limited');
    expect(err.retryAfterSec).toBe(42);
    expect(err.message).toContain('42 s');
  });

  it('includes server details for 400 responses', async () => {
    const fetch = jest.fn(async () => jsonResponse(400, { error: 'invalid body', details: ['sessions.0.id: required'] }));
    await expect(createUploader({ fetch }).uploadSessions([session('a')], CFG)).rejects.toThrow(
      /invalid body \(sessions\.0\.id: required\)/,
    );
  });

  it('reports network failures and timeouts', async () => {
    const offline = jest.fn(async () => {
      throw new TypeError('Network request failed');
    });
    await expect(createUploader({ fetch: offline }).uploadSessions([session('a')], CFG)).rejects.toMatchObject({
      kind: 'network',
    });

    jest.useFakeTimers();
    try {
      const hanging: FetchLike = (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        });
      const pending = createUploader({ fetch: hanging, uploadTimeoutMs: 5_000 }).uploadSessions([session('a')], CFG);
      const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' });
      await jest.advanceTimersByTimeAsync(5_000);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects an unexpected response body', async () => {
    const fetch = jest.fn(async () => jsonResponse(200, { ok: true }));
    await expect(createUploader({ fetch }).uploadSessions([session('a')], CFG)).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });

  it('requires a server address and token before any request', async () => {
    const fetch = jest.fn();
    const uploader = createUploader({ fetch });
    await expect(uploader.uploadSessions([session('a')], { url: '', token: 't' })).rejects.toMatchObject({ kind: 'config' });
    await expect(uploader.uploadSessions([session('a')], { url: CFG.url, token: ' ' })).rejects.toMatchObject({
      kind: 'config',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('checkEnrolment', () => {
  it('GETs /api/v1/me with the token', async () => {
    const fetch = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(async () =>
      jsonResponse(200, { participantCode: 'SP-014', sessionCount: 3, lastUploadAt: null }),
    );
    await expect(createUploader({ fetch }).checkEnrolment(CFG)).resolves.toEqual({
      participantCode: 'SP-014',
      sessionCount: 3,
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://research.example.edu/api/v1/me');
    expect(init?.method).toBe('GET');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer spk_secret-token' });
  });

  it('maps a revoked token to an unauthorized error', async () => {
    const fetch = jest.fn(async () => jsonResponse(401, { error: 'unauthorized' }));
    await expect(createUploader({ fetch }).checkEnrolment(CFG)).rejects.toMatchObject({ kind: 'unauthorized' });
  });
});

// SEC-3: the host the validator checks must be the host that is contacted.
describe('normalizeServerUrl host parsing', () => {
  it('rejects backslashes, credentials and escapes that a URL parser would read differently', () => {
    for (const raw of [
      'http://evil.com\\.local',
      'http://evil.com\\@localhost',
      'https://evil.com\\.local/api',
      'http://localhost@evil.com',
      'http://evil.com%2f.local',
      'http://evil.com#.local',
      'https://good.example.edu/path\\..\\x',
    ]) {
      expect(() => normalizeServerUrl(raw)).toThrow(UploadError);
    }
    expect(normalizeServerUrl('https://study-server.uni.edu.au/sp')).toBe('https://study-server.uni.edu.au/sp');
    expect(normalizeServerUrl('http://surgeonpulse.local:8787')).toBe('http://surgeonpulse.local:8787');
  });
});

describe('upload eligibility', () => {
  // DATA-1: a practice case recorded with the live simulator has sensor.source 'simulated' but no tag.
  it('never sends simulator recordings, tagged or not', async () => {
    const fetch = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(async () =>
      jsonResponse(200, { accepted: [{ id: 'ok', status: 'created' }], rejected: [] }),
    );
    const result = await createUploader({ fetch }).uploadSessions(
      [
        session('live-sim', { sensor: { source: 'simulated', name: 'Simulator' } }),
        session('ok'),
        session('tagged', { tags: ['simulated'] }),
      ],
      CFG,
    );
    expect(result.rejected).toEqual([
      { index: 0, id: 'live-sim', reason: expect.stringContaining('simulator') },
      { index: 2, id: 'tagged', reason: expect.stringContaining('simulator') },
    ]);
    const bundle = JSON.parse(String(fetch.mock.calls[0]![1]?.body)) as ExportBundle;
    expect(bundle.sessions.map((s) => s.id)).toEqual(['ok']);
  });

  // ROB-1: one imported session with a non-pseudonymous code used to abort the whole batch.
  it('rejects a session with a non-pseudonymous code locally and still uploads the rest', async () => {
    const fetch = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(async () =>
      jsonResponse(200, { accepted: [{ id: 'ok', status: 'created' }], rejected: [] }),
    );
    const result = await createUploader({ fetch }).uploadSessions(
      [session('bad', { participantCode: 'jane.doe@hospital.org' }), session('ok')],
      CFG,
    );
    expect(result.accepted).toEqual([{ id: 'ok', status: 'created' }]);
    expect(result.rejected).toEqual([{ index: 0, id: 'bad', reason: expect.stringContaining('participant code') }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![1]?.body)).not.toContain('jane.doe');
  });

  // PRIV-3: withdrawn consent stops every upload path (manual, per-session, automatic).
  it('sends nothing once the profile records withdrawn consent, and maps a 409 refusal', async () => {
    const fetch = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>();
    const withdrawn = { ...CFG, profile: { code: 'SP-014', consent: { version: 'PICF-1.0', givenAt: T0, withdrawnAt: T0 + 1 } } };
    await expect(createUploader({ fetch }).uploadSessions([session('a')], withdrawn)).rejects.toMatchObject({ kind: 'withdrawn' });
    expect(fetch).not.toHaveBeenCalled();

    const refused = jest.fn(async () => jsonResponse(409, { error: 'consent withdrawn' }));
    await expect(createUploader({ fetch: refused }).uploadSessions([session('a')], CFG)).rejects.toMatchObject({
      kind: 'withdrawn',
      status: 409,
    });
  });
});

describe('withdraw', () => {
  it('POSTs /api/v1/me/withdraw with the token and returns the number of deleted sessions', async () => {
    const fetch = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(async () => jsonResponse(200, { deletedSessions: 4 }));
    await expect(createUploader({ fetch }).withdraw(CFG)).resolves.toEqual({ deletedSessions: 4 });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://research.example.edu/api/v1/me/withdraw');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer spk_secret-token' });
    expect(init?.body).toBeUndefined();

    const revoked = jest.fn(async () => jsonResponse(401, { error: 'unauthorized' }));
    await expect(createUploader({ fetch: revoked }).withdraw(CFG)).rejects.toMatchObject({ kind: 'unauthorized' });
  });
});
