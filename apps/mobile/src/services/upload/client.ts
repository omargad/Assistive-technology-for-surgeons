/**
 * HTTP client for the SurgeonPulse research ingest server
 * (see apps/server/SPEC.md). Pure and dependency-injected so it can be tested
 * with a mock `fetch`; `research.ts` wires it into the app.
 *
 * - `POST {url}/api/v1/sessions` with a **de-identified** `ExportBundle`
 *   (core `createExportBundle({ deidentify: true })`) and
 *   `Authorization: Bearer <enrolment token>`.
 * - `GET {url}/api/v1/me` to confirm enrolment.
 * - Every request has a timeout (AbortController).
 * - Failures become an {@link UploadError} with a plain-language message and a
 *   machine-readable `kind`. Tokens and health data never appear in messages.
 * - Demo and simulated sessions (`tags` `demo`/`simulated` or
 *   `sensor.source: 'simulated'`, e.g. a practice case with the live
 *   simulator), sessions still recording and sessions whose participant code
 *   is not a pseudonymous study code are never sent; they are reported as
 *   locally rejected, and the rest of the batch is still uploaded.
 * - Nothing is sent once the profile records withdrawn consent.
 * - `withdraw` calls `POST {url}/api/v1/me/withdraw` (participant-initiated
 *   withdrawal: the server deletes the participant's data and revokes the
 *   token).
 * - Large uploads are split into several requests below the server body limit.
 */
import { createExportBundle, isValidParticipantCode } from '@surgeonpulse/core';
import type { AppInfo, ParticipantProfile, SurgicalSession } from '@surgeonpulse/core';

export interface UploadResult {
  accepted: { id: string; status: 'created' | 'updated' | 'unchanged' }[];
  rejected: { index: number; id?: string; reason: string }[];
}

export interface UploadConfig {
  url: string;
  token: string;
  profile?: ParticipantProfile | null;
}

export type UploadErrorKind =
  | 'config'
  | 'withdrawn'
  | 'unauthorized'
  | 'too-large'
  | 'rate-limited'
  | 'bad-request'
  | 'server'
  | 'network'
  | 'timeout'
  | 'invalid-response';

export class UploadError extends Error {
  readonly kind: UploadErrorKind;
  readonly status: number | undefined;
  /** Seconds to wait before retrying (HTTP 429 `Retry-After`). */
  readonly retryAfterSec: number | undefined;

  constructor(kind: UploadErrorKind, message: string, extra: { status?: number; retryAfterSec?: number } = {}) {
    super(message);
    // Keep `instanceof` working when classes are down-compiled.
    Object.setPrototypeOf(this, UploadError.prototype);
    this.name = 'UploadError';
    this.kind = kind;
    this.status = extra.status;
    this.retryAfterSec = extra.retryAfterSec;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface UploaderDeps {
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
  now?: () => number;
  app?: () => AppInfo;
  /** Request timeout for uploads (ms). Default 60 000. */
  uploadTimeoutMs?: number;
  /** Request timeout for `checkEnrolment` (ms). Default 15 000. */
  checkTimeoutMs?: number;
  /** Max JSON characters per upload request. Default 8 000 000 (server default limit is 25 MB). */
  maxRequestChars?: number;
}

const DEMO_TAG = 'demo';
const SIMULATED_TAG = 'simulated';
const DEFAULT_UPLOAD_TIMEOUT_MS = 60_000;
const DEFAULT_CHECK_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REQUEST_CHARS = 8_000_000;
const ACCEPTED_STATUSES = new Set(['created', 'updated', 'unchanged']);

// ---------------------------------------------------------------------------
// URL handling (no `URL` class: React Native's implementation is incomplete)
// ---------------------------------------------------------------------------

// Host: DNS name or IPv4 only. `\`, `@`, `%` and other characters that a WHATWG/OkHttp parser
// would read as a path separator, credentials or an escape are rejected, so the host checked
// here is the host that will be contacted.
const URL_RE = /^(https?):\/\/([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(:\d{1,5})?(\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*)?$/i;

function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h === '10.0.2.2') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * Normalise the research server address: trims, adds `https://` when no
 * scheme is given and removes trailing slashes. Plain `http://` is only
 * allowed for local/development hosts, because the enrolment token would
 * otherwise travel unencrypted.
 */
export function normalizeServerUrl(raw: string): string {
  let url = raw.trim();
  if (url === '') throw new UploadError('config', 'Enter the research server address in Settings.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, '');
  const m = URL_RE.exec(url);
  if (!m) throw new UploadError('config', 'The research server address is not a valid web address.');
  const scheme = (m[1] as string).toLowerCase();
  const host = m[2] as string;
  if (scheme === 'http' && !isLocalHost(host)) {
    throw new UploadError('config', 'The research server address must start with https:// to keep your data secure.');
  }
  return url;
}

function requireToken(token: string): string {
  const t = token.trim();
  if (t === '') throw new UploadError('config', 'Enter the enrolment token from your research team in Settings.');
  return t;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function retryAfterSeconds(res: Response): number | undefined {
  const raw = res.headers?.get?.('Retry-After');
  if (!raw) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : undefined;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/** Map a non-2xx response to an {@link UploadError}. */
async function errorFromResponse(res: Response): Promise<UploadError> {
  const status = res.status;
  if (status === 409) {
    return new UploadError(
      'withdrawn',
      'The research server refused the upload because consent has been withdrawn for this participant.',
      { status },
    );
  }
  if (status === 401 || status === 403) {
    return new UploadError(
      'unauthorized',
      'The research server did not accept your enrolment token. Check it with your research team — it may have been revoked.',
      { status },
    );
  }
  if (status === 413) {
    return new UploadError(
      'too-large',
      'The upload is too large for the research server. Try uploading fewer sessions at a time.',
      { status },
    );
  }
  if (status === 429) {
    const retryAfterSec = retryAfterSeconds(res);
    const wait = retryAfterSec !== undefined ? ` Try again in ${retryAfterSec} s.` : ' Try again in a minute.';
    const extra: { status: number; retryAfterSec?: number } = { status };
    if (retryAfterSec !== undefined) extra.retryAfterSec = retryAfterSec;
    return new UploadError('rate-limited', `Too many requests to the research server.${wait}`, extra);
  }
  if (status === 400) {
    const body = (await readJson(res)) as { error?: unknown; details?: unknown } | null;
    const details = Array.isArray(body?.details) ? body.details.filter((d) => typeof d === 'string').slice(0, 3) : [];
    const reason = typeof body?.error === 'string' ? body.error : 'invalid request';
    const suffix = details.length > 0 ? ` (${details.join('; ')})` : '';
    return new UploadError('bad-request', `The research server rejected the upload: ${reason}${suffix}.`, { status });
  }
  if (status === 404) {
    return new UploadError('server', 'The research server address looks wrong (not found). Check it in Settings.', {
      status,
    });
  }
  return new UploadError('server', `The research server had a problem (HTTP ${status}). Try again later.`, { status });
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

// ---------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------

function parseUploadResponse(body: unknown, indexMap: readonly number[]): UploadResult {
  if (typeof body !== 'object' || body === null) {
    throw new UploadError('invalid-response', 'The research server sent an unexpected response.');
  }
  const b = body as { accepted?: unknown; rejected?: unknown };
  if (!Array.isArray(b.accepted) || !Array.isArray(b.rejected)) {
    throw new UploadError('invalid-response', 'The research server sent an unexpected response.');
  }
  const accepted: UploadResult['accepted'] = [];
  for (const a of b.accepted as unknown[]) {
    const item = a as { id?: unknown; status?: unknown };
    if (typeof item?.id === 'string' && typeof item.status === 'string' && ACCEPTED_STATUSES.has(item.status)) {
      accepted.push({ id: item.id, status: item.status as UploadResult['accepted'][number]['status'] });
    }
  }
  const rejected: UploadResult['rejected'] = [];
  for (const r of b.rejected as unknown[]) {
    const item = r as { index?: unknown; id?: unknown; reason?: unknown };
    const local = typeof item?.index === 'number' ? item.index : -1;
    const entry: UploadResult['rejected'][number] = {
      index: indexMap[local] ?? local,
      reason: typeof item?.reason === 'string' ? item.reason : 'Rejected by the server',
    };
    if (typeof item?.id === 'string') entry.id = item.id;
    rejected.push(entry);
  }
  return { accepted, rejected };
}

// ---------------------------------------------------------------------------
// Uploader
// ---------------------------------------------------------------------------

export interface Uploader {
  uploadSessions(sessions: SurgicalSession[], cfg: UploadConfig): Promise<UploadResult>;
  checkEnrolment(cfg: { url: string; token: string }): Promise<{ participantCode: string; sessionCount: number }>;
  /** Withdraw from the study on the server (deletes the participant's server data, revokes every token). */
  withdraw(cfg: { url: string; token: string }): Promise<{ deletedSessions: number }>;
}

/** Why a session must not be uploaded, or null when it may be. */
function localRejection(session: SurgicalSession): string | null {
  if (session.tags?.includes(DEMO_TAG)) return 'Demo data is never uploaded.';
  if (session.sensor?.source === 'simulated' || session.tags?.includes(SIMULATED_TAG)) {
    return 'Sessions recorded with the simulator are never uploaded.';
  }
  if (session.status === 'recording') return 'The session is still being recorded.';
  if (!isValidParticipantCode(session.participantCode)) {
    return 'The session’s participant code is not a study code, so it cannot be de-identified.';
  }
  return null;
}

/** Group indices so that each request stays below `maxChars` (a single oversized session goes alone). */
function chunkBySize(sizes: readonly number[], maxChars: number): number[][] {
  const chunks: number[][] = [];
  let current: number[] = [];
  let total = 0;
  sizes.forEach((size, index) => {
    if (current.length > 0 && total + size > maxChars) {
      chunks.push(current);
      current = [];
      total = 0;
    }
    current.push(index);
    total += size;
  });
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function createUploader(deps: UploaderDeps = {}): Uploader {
  const doFetch: FetchLike = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? Date.now;
  const uploadTimeoutMs = deps.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  const checkTimeoutMs = deps.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const maxRequestChars = deps.maxRequestChars ?? DEFAULT_MAX_REQUEST_CHARS;

  async function request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      return await doFetch(url, controller ? { ...init, signal: controller.signal } : init);
    } catch (error) {
      if (isAbortError(error)) {
        throw new UploadError('timeout', 'The research server did not respond in time. Check your connection and try again.');
      }
      throw new UploadError(
        'network',
        'Could not reach the research server. Check the address in Settings and your internet connection.',
      );
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  return {
    async uploadSessions(sessions, cfg) {
      const base = normalizeServerUrl(cfg.url);
      const token = requireToken(cfg.token);
      if (cfg.profile?.consent?.withdrawnAt !== undefined) {
        throw new UploadError('withdrawn', 'You have withdrawn consent, so nothing is uploaded to the study server.');
      }
      const result: UploadResult = { accepted: [], rejected: [] };

      // Local filtering: never send synthetic data, unfinished recordings or non-pseudonymous codes.
      const eligible: { session: SurgicalSession; index: number }[] = [];
      sessions.forEach((session, index) => {
        const reason = localRejection(session);
        if (reason !== null) result.rejected.push({ index, id: session.id, reason });
        else eligible.push({ session, index });
      });
      if (eligible.length === 0) return result;

      const sizes = eligible.map((e) => JSON.stringify(e.session).length);
      const app = deps.app?.();
      for (const chunk of chunkBySize(sizes, maxRequestChars)) {
        const items = chunk.map((i) => eligible[i] as { session: SurgicalSession; index: number });
        const bundle = createExportBundle({
          sessions: items.map((e) => e.session),
          participants: cfg.profile ? [cfg.profile] : [],
          ...(app ? { app } : {}),
          deidentify: true,
          now: now(),
        });
        const res = await request(
          `${base}/api/v1/sessions`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(bundle),
          },
          uploadTimeoutMs,
        );
        if (!res.ok) throw await errorFromResponse(res);
        const part = parseUploadResponse(
          await readJson(res),
          items.map((e) => e.index),
        );
        result.accepted.push(...part.accepted);
        result.rejected.push(...part.rejected);
      }
      result.rejected.sort((a, b) => a.index - b.index);
      return result;
    },

    async checkEnrolment(cfg) {
      const base = normalizeServerUrl(cfg.url);
      const token = requireToken(cfg.token);
      const res = await request(
        `${base}/api/v1/me`,
        { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } },
        checkTimeoutMs,
      );
      if (!res.ok) throw await errorFromResponse(res);
      const body = (await readJson(res)) as { participantCode?: unknown; sessionCount?: unknown } | null;
      if (typeof body?.participantCode !== 'string') {
        throw new UploadError('invalid-response', 'The research server sent an unexpected response.');
      }
      return {
        participantCode: body.participantCode,
        sessionCount: typeof body.sessionCount === 'number' ? body.sessionCount : 0,
      };
    },

    async withdraw(cfg) {
      const base = normalizeServerUrl(cfg.url);
      const token = requireToken(cfg.token);
      const res = await request(
        `${base}/api/v1/me/withdraw`,
        { method: 'POST', headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } },
        checkTimeoutMs,
      );
      if (!res.ok) throw await errorFromResponse(res);
      const body = (await readJson(res)) as { deletedSessions?: unknown } | null;
      if (typeof body?.deletedSessions !== 'number') {
        throw new UploadError('invalid-response', 'The research server sent an unexpected response.');
      }
      return { deletedSessions: body.deletedSessions };
    },
  };
}
