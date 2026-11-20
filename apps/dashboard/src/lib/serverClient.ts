/**
 * Client for the SurgeonPulse research ingest server (apps/server).
 *
 * The dashboard only reads: `GET {url}/api/v1/export` with the researcher's
 * admin bearer token returns a de-identified `ExportBundle`. The token is
 * sent only in the `Authorization` header, is never logged, and never appears
 * in error messages. Requests omit cookies and the referrer.
 */
import { parseImport, SessionParseError } from '@surgeonpulse/core';
import type { ExportBundle } from '@surgeonpulse/core';

/** Why a server request failed (drives the help text shown to the user). */
export type ServerErrorKind = 'invalid-url' | 'missing-token' | 'network' | 'unauthorized' | 'http' | 'parse' | 'aborted';

/** A failed server request, with a user-facing message. */
export class ServerError extends Error {
  readonly kind: ServerErrorKind;
  readonly status: number | undefined;

  constructor(kind: ServerErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ServerError';
    this.kind = kind;
    this.status = status;
  }
}

/** Connection settings entered on the Data page. */
export interface ServerConnection {
  url: string;
  token: string;
}

/** Optional export filters (mirrors the server's list/export query parameters). */
export interface ExportQuery {
  participant?: string;
  specialty?: string;
  /** Epoch ms on started_at. */
  from?: number;
  to?: number;
}

/** Hosts for which plain HTTP is acceptable (local development). */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Validate and normalise a server base URL: trims whitespace, requires
 * `http:`/`https:`, drops query/hash, and removes trailing slashes, so
 * `https://study.example.edu/sp/` → `https://study.example.edu/sp`.
 *
 * @throws ServerError(`invalid-url`)
 */
export function normaliseServerUrl(input: string): string {
  const raw = input.trim();
  if (raw === '') throw new ServerError('invalid-url', 'Enter the research server address.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ServerError('invalid-url', 'The server address is not a valid URL (for example https://study.example.edu).');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ServerError('invalid-url', 'The server address must start with https:// (or http:// for a local server).');
  }
  if (url.username !== '' || url.password !== '') {
    throw new ServerError('invalid-url', 'Do not put credentials in the server address; use the token field.');
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

/** Whether the connection would send the token over unencrypted HTTP to a non-local host. */
export function isInsecureRemote(normalisedUrl: string): boolean {
  try {
    const u = new URL(normalisedUrl);
    return u.protocol === 'http:' && !LOCAL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** Build the export URL with optional filters. */
export function exportUrl(baseUrl: string, query: ExportQuery = {}): string {
  const u = new URL(`${normaliseServerUrl(baseUrl)}/api/v1/export`);
  if (query.participant) u.searchParams.set('participant', query.participant);
  if (query.specialty) u.searchParams.set('specialty', query.specialty);
  if (query.from !== undefined) u.searchParams.set('from', String(Math.trunc(query.from)));
  if (query.to !== undefined) u.searchParams.set('to', String(Math.trunc(query.to)));
  return u.toString();
}

/** Injectable dependencies for {@link fetchExportBundle}. */
export interface FetchDeps {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

function httpMessage(status: number): string {
  if (status === 404) return 'The server answered 404: check the address points at a SurgeonPulse server (…/api/v1/export).';
  if (status === 413) return 'The export is too large for the server to send (413).';
  if (status === 429) return 'The server is rate-limiting requests (429). Wait a minute and try again.';
  if (status >= 500) return `The server reported an internal error (${status}). Check the server logs.`;
  return `The server answered with HTTP ${status}.`;
}

/**
 * Download the de-identified export bundle from the research server and
 * parse it with core `parseImport` (so invalid sessions are skipped with
 * warnings, exactly as for file imports).
 *
 * @throws ServerError with a user-facing message.
 */
export async function fetchExportBundle(
  conn: ServerConnection,
  query: ExportQuery = {},
  deps: FetchDeps = {},
): Promise<{ bundle: ExportBundle; warnings: string[] }> {
  const url = exportUrl(conn.url, query);
  const token = conn.token.trim();
  if (token === '') throw new ServerError('missing-token', 'Enter the admin token issued for this server.');
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);

  let response: Response;
  try {
    const init: RequestInit = {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    };
    if (deps.signal !== undefined) init.signal = deps.signal;
    response = await fetchImpl(url, init);
  } catch (err) {
    // Not `instanceof DOMException`: some engines reject with a plain Error named AbortError.
    if (typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError') {
      throw new ServerError('aborted', 'The request was cancelled.');
    }
    throw new ServerError(
      'network',
      'Could not reach the server. Check the address, that the server is running, and that its CORS_ORIGINS ' +
        `setting includes this dashboard's origin (${originHint()}).`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new ServerError('unauthorized', 'The server rejected the token. Check the admin token and try again.', response.status);
  }
  if (!response.ok) throw new ServerError('http', httpMessage(response.status), response.status);

  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new ServerError('network', 'The connection dropped while downloading the export.');
  }
  try {
    return parseImport(text);
  } catch (err) {
    const detail = err instanceof SessionParseError ? err.issues.slice(0, 3).join('; ') : 'unexpected response';
    throw new ServerError('parse', `The server response is not a SurgeonPulse export (${detail}).`);
  }
}

function originHint(): string {
  try {
    return typeof location !== 'undefined' && location.origin !== 'null' ? location.origin : 'this page';
  } catch {
    return 'this page';
  }
}
