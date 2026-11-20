/** Small input-parsing helpers shared by the onboarding and settings forms. */

export type ParsedNumber = { ok: true; value: number | undefined } | { ok: false; error: string };

/**
 * Parse an optional whole number typed by the user. Empty → `undefined`.
 * Out-of-range or non-numeric input → an error message for the field.
 */
export function parseOptionalInt(text: string, min: number, max: number, what: string): ParsedNumber {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: undefined };
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: `${what} should be a whole number.` };
  const n = Number(trimmed);
  if (n < min || n > max) return { ok: false, error: `${what} should be between ${min} and ${max}.` };
  return { ok: true, value: n };
}

/** Text for an optional number field. */
export function numberText(n: number | undefined | null): string {
  return typeof n === 'number' && Number.isFinite(n) ? String(n) : '';
}

/** Normalise a participant code as typed (trim, upper-case). Validation uses core `isValidParticipantCode`. */
export function normaliseCode(text: string): string {
  return text.trim().toUpperCase();
}
