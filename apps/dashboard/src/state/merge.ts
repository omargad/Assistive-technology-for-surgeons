/**
 * Pure helpers for combining data from several sources (files, demo, server).
 */
import type { ParticipantProfile } from '@surgeonpulse/core';

/**
 * Merge participant profiles by code. Fields from later profiles win, but a
 * later minimal `{ code }` profile (which `parseImport` synthesises for codes
 * without a profile) never erases richer earlier information. Order follows
 * first appearance.
 */
export function mergeParticipants(
  existing: readonly ParticipantProfile[],
  incoming: readonly ParticipantProfile[],
): ParticipantProfile[] {
  const byCode = new Map<string, ParticipantProfile>();
  for (const p of existing) byCode.set(p.code, { ...p });
  for (const p of incoming) {
    const prev = byCode.get(p.code);
    byCode.set(p.code, prev === undefined ? { ...p } : { ...prev, ...definedFields(p) });
  }
  return [...byCode.values()];
}

/** Copy only the keys whose value is not `undefined`. */
function definedFields<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}
