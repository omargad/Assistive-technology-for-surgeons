/**
 * zod schemas for request bodies, params and query strings. Domain objects
 * (sessions, profiles) are validated with the schemas from
 * `@surgeonpulse/core`; these only cover the API envelope.
 */
import { isValidParticipantCode } from '@surgeonpulse/core';
import { z } from 'zod';

/**
 * Pseudonymous participant code, checked with core's `isValidParticipantCode` and stored in upper
 * case (the app upper-cases codes too), so `sp-014` and `SP-014` are the same participant.
 */
export const ParticipantCodeSchema = z
  .string()
  .trim()
  .refine(
    isValidParticipantCode,
    'must be a pseudonymous study code: 2–32 letters, digits, "-" or "_", starting with a letter or digit, and not an e-mail address',
  )
  .transform((code) => code.toUpperCase());

export const CreateParticipantBodySchema = z.object({
  code: ParticipantCodeSchema,
  /** Profile fields (validated against core's ParticipantProfileSchema with `code` forced). */
  profile: z.record(z.string(), z.unknown()).optional(),
});

export const CreateEnrolmentBodySchema = z.object({
  participantCode: ParticipantCodeSchema,
  /** Researcher's note for the device, e.g. "iPad 2". Never a person's name. */
  label: z.string().trim().min(1).max(64).optional(),
});

export const IdParamsSchema = z.object({ id: z.string().min(1).max(128) });
export const CodeParamsSchema = z.object({ code: z.string().min(1).max(64).transform((code) => code.toUpperCase()) });

/** Drop blank query values (`?specialty=`) so they behave as "not given". */
function dropBlankValues(v: unknown): unknown {
  if (typeof v !== 'object' || v === null) return v;
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).filter(([, value]) => !(typeof value === 'string' && value.trim() === '')),
  );
}

function integerString(min: number, max: number) {
  return z
    .string()
    .trim()
    .regex(/^-?\d+$/, 'must be a whole number')
    .transform(Number)
    .pipe(z.number().int().min(min, `must be at least ${min}`).max(max, `must be at most ${max}`));
}

/** Largest epoch-ms value accepted by `Date` (±8.64e15). */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

export const LIST_DEFAULT_LIMIT = 200;
export const LIST_MAX_LIMIT = 1000;
export const EXPORT_MAX_LIMIT = 100_000;

/**
 * Session filters shared by the list and the exports: `participant`,
 * `from`/`to` (epoch ms on `startedAt`; `from` inclusive, `to` exclusive),
 * `specialty`, `limit`, `offset`.
 */
export function sessionQuerySchema(maxLimit: number) {
  return z.preprocess(
    dropBlankValues,
    z
      .object({
        participant: z
          .string()
          .max(64)
          .transform((code) => code.trim().toUpperCase())
          .optional(),
        from: integerString(-MAX_EPOCH_MS, MAX_EPOCH_MS).optional(),
        to: integerString(-MAX_EPOCH_MS, MAX_EPOCH_MS).optional(),
        specialty: z.string().max(200).optional(),
        limit: integerString(1, maxLimit).optional(),
        offset: integerString(0, Number.MAX_SAFE_INTEGER).optional(),
      })
      .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
        message: 'must not be after "to"',
        path: ['from'],
      }),
  );
}

export const ListSessionsQuerySchema = sessionQuerySchema(LIST_MAX_LIMIT);
export const ExportQuerySchema = sessionQuerySchema(EXPORT_MAX_LIMIT);

/**
 * Export-only option `shiftDates` (`true`/`false`, default false): move each participant's
 * timestamps by their secret whole-week shift (see `dateShift.ts`), for exports that will be
 * shared beyond the study's data custodians.
 */
export const ExportOptionsSchema = z.object({
  shiftDates: z
    .enum(['true', 'false', '1', '0'], { error: 'must be true or false' })
    .optional()
    .transform((v) => v === 'true' || v === '1'),
});
