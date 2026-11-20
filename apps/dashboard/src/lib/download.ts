/**
 * Browser download helpers.
 *
 * Files are generated in memory and saved with an object URL and a temporary
 * `<a download>` element, which works in Chrome/Edge/Firefox on every desktop
 * OS, in Safari on macOS and iPadOS (13+), and in Chrome on Android. The
 * anchor is attached to the document before clicking (Firefox requires it)
 * and the object URL is revoked after a delay (Safari aborts downloads whose
 * URL is revoked synchronously).
 */

/** Platform hooks, injectable for tests. */
export interface DownloadEnv {
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  document: Document;
  schedule: (fn: () => void, ms: number) => unknown;
}

function defaultEnv(): DownloadEnv {
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    document,
    schedule: (fn, ms) => setTimeout(fn, ms),
  };
}

/** How long object URLs stay alive after the click (Safari needs them briefly). */
export const REVOKE_DELAY_MS = 30_000;

/** UTF-8 byte-order mark. Lets Excel on Windows detect UTF-8 when a CSV is double-clicked. */
export const UTF8_BOM = '﻿';

/** Trigger a download of `blob` as `filename`. */
export function downloadBlob(blob: Blob, filename: string, env: DownloadEnv = defaultEnv()): void {
  const url = env.createObjectURL(blob);
  const a = env.document.createElement('a');
  a.href = url;
  a.download = safeFilename(filename);
  a.rel = 'noopener';
  a.style.display = 'none';
  env.document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    env.schedule(() => env.revokeObjectURL(url), REVOKE_DELAY_MS);
  }
}

/** Options for {@link downloadText}. */
export interface TextDownloadOptions {
  /** Prepend a UTF-8 BOM (Excel-friendly CSV). Off by default: R and pandas read the BOM into the first column name. */
  bom?: boolean;
}

/** Build a text blob (UTF-8). */
export function textBlob(text: string, mimeType: string, opts: TextDownloadOptions = {}): Blob {
  const body = opts.bom === true ? UTF8_BOM + text : text;
  return new Blob([body], { type: `${mimeType};charset=utf-8` });
}

/** Download a string as a UTF-8 file. */
export function downloadText(
  text: string,
  filename: string,
  mimeType: string,
  opts: TextDownloadOptions = {},
  env?: DownloadEnv,
): void {
  downloadBlob(textBlob(text, mimeType, opts), filename, env);
}

/** Download CSV text (RFC 4180, as produced by core). */
export function downloadCsv(csv: string, filename: string, opts: TextDownloadOptions = {}, env?: DownloadEnv): void {
  downloadText(csv, filename, 'text/csv', opts, env);
}

/** Download a value as pretty-printed JSON. */
export function downloadJson(value: unknown, filename: string, env?: DownloadEnv): void {
  downloadText(`${JSON.stringify(value, null, 2)}\n`, filename, 'application/json', {}, env);
}

/**
 * Concatenate CSV documents that share a header (e.g. one per session) into
 * one long-format CSV: the first non-empty part's header is kept, the header
 * line of every later part is dropped. Line endings are preserved, and the
 * result always ends with a line break when non-empty.
 */
export function concatCsv(parts: readonly string[]): string {
  let out = '';
  let header: string | null = null;
  for (const part of parts) {
    if (part === '') continue;
    const nl = part.search(/\r?\n/);
    const firstLine = nl === -1 ? part : part.slice(0, nl);
    const lineBreak = nl === -1 ? '\r\n' : part[nl] === '\r' ? '\r\n' : '\n';
    if (header === null) {
      header = firstLine;
      out = nl === -1 ? part + lineBreak : part;
      if (!/\r?\n$/.test(out)) out += lineBreak;
      continue;
    }
    if (nl === -1) continue; // header-only part without rows
    let body = part.slice(nl + lineBreak.length);
    if (body === '') continue;
    if (!/\r?\n$/.test(body)) body += lineBreak;
    out += body;
  }
  return out;
}

/**
 * Make a filename safe on Windows, macOS, Linux, iOS and Android: only
 * letters, digits, `.`, `_` and `-`; no leading dots; at most 120 characters.
 */
export function safeFilename(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // drop combining accents: é → e
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[-.]+$/, '');
  const trimmed = cleaned.slice(0, 120);
  return trimmed === '' ? 'download' : trimmed;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Compact UTC timestamp for filenames: `20261120-0815`. */
export function fileStamp(date: Date): string {
  return (
    `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}` +
    `-${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}`
  );
}

/** `surgeonpulse-<what>-<stamp>.<ext>` */
export function exportFilename(what: string, ext: string, now: Date): string {
  return safeFilename(`surgeonpulse-${what}-${fileStamp(now)}.${ext}`);
}
