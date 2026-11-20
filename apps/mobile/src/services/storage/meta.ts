/**
 * Helpers shared by the storage implementations for splitting a session into
 * its metadata and signal parts and for applying metadata patches safely.
 */
import type { SurgicalSession } from '@surgeonpulse/core';
import type { SessionMeta } from './types';

/** Session without the bulky `samples` / `rr` arrays. */
export function toMeta(session: SurgicalSession): SessionMeta {
  const { samples: _samples, rr: _rr, ...meta } = session;
  return meta;
}

/**
 * Merge a metadata patch into existing metadata. Signal arrays and the
 * immutable `id` are never taken from the patch, and keys explicitly set to
 * `undefined` are removed (e.g. `{ endedAt: undefined }`).
 */
export function applyMetaPatch(meta: SessionMeta, patch: Partial<SessionMeta>): SessionMeta {
  const merged: Record<string, unknown> = { ...meta };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'id' || key === 'samples' || key === 'rr') continue;
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged as unknown as SessionMeta;
}

/** Defensive JSON parse that returns `null` instead of throwing. */
export function safeJsonParse(text: string | null | undefined): unknown {
  if (typeof text !== 'string' || text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
