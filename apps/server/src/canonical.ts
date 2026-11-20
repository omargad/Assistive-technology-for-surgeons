/**
 * Canonical JSON and digests, used to detect unchanged re-uploads.
 *
 * Canonical form = `JSON.stringify` with the keys of every plain object
 * sorted (arrays keep their order), so two semantically identical sessions
 * produce the same text whatever order their keys arrived in.
 */
import { createHash } from 'node:crypto';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Deterministic JSON text of `value` (sorted object keys; otherwise identical to `JSON.stringify`). */
export function canonicalJson(value: unknown): string {
  const text = JSON.stringify(value, (_key, v: unknown) => {
    if (!isPlainObject(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) sorted[k] = v[k];
    return sorted;
  });
  return text ?? 'null';
}

/** Lower-case hex SHA-256 of a UTF-8 string. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
