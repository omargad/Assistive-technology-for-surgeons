/**
 * Export bundles: the single JSON file format written by every export path
 * (mobile share sheet, dashboard download, server export) and read by every
 * import path.
 */
import { z } from 'zod';
import type { AppInfo, EpochMs, ExportBundle, ParticipantProfile, SurgicalSession } from '../types';
import { deidentifyBundle } from './deidentify';
import type { DeidentifyOptions } from './deidentify';
import {
  AppInfoSchema,
  ParticipantProfileSchema,
  SessionParseError,
  formatZodIssues,
  safeParseSession,
} from './schema';

/** Input for {@link createExportBundle}. */
export interface CreateExportBundleInput {
  sessions: SurgicalSession[];
  /** Profiles to include. A minimal `{ code }` profile is added for any session code without one. */
  participants?: ParticipantProfile[];
  app?: AppInfo;
  /** `true` for the default {@link DeidentifyOptions}, or explicit options. */
  deidentify?: boolean | DeidentifyOptions;
  /** Export time (injected; the library never reads the clock). */
  now: EpochMs;
}

/** Profiles for every participant code used by `sessions`, keeping given profiles first. */
function completeParticipants(
  participants: readonly ParticipantProfile[],
  sessions: readonly SurgicalSession[],
): ParticipantProfile[] {
  const out = participants.map((p) => ({ ...p }));
  const known = new Set(out.map((p) => p.code));
  for (const s of sessions) {
    if (!known.has(s.participantCode)) {
      known.add(s.participantCode);
      out.push({ code: s.participantCode });
    }
  }
  return out;
}

/**
 * Build an {@link ExportBundle} (SPEC.md › io/bundle.ts). Inputs are never
 * mutated; participants are completed with a `{ code }` profile for each
 * session code that has none. With `deidentify`, {@link deidentifyBundle} is
 * applied (new session objects, sharing nothing with the input) and
 * `deidentified` is `true`. Without it, `deidentified` is `false` and the
 * bundle's `sessions` array is new but holds the caller's session objects
 * (no deep copy, to keep large exports cheap): treat them as immutable.
 *
 * @throws RangeError when de-identifying and a participant code is not a
 *   pseudonymous code (see `deidentifyBundle`).
 */
export function createExportBundle(input: CreateExportBundleInput): ExportBundle {
  const bundle: ExportBundle = {
    format: 'surgeonpulse-export',
    version: 1,
    exportedAt: input.now,
    deidentified: false,
    participants: completeParticipants(input.participants ?? [], input.sessions),
    sessions: input.sessions.slice(),
  };
  if (input.app !== undefined) bundle.app = { ...input.app };
  const d = input.deidentify;
  if (d === undefined || d === false) return bundle;
  return deidentifyBundle(bundle, d === true ? {} : d);
}

/** Envelope fields of a bundle; sessions and participants are validated one by one. */
const BundleEnvelopeSchema = z.object({
  format: z.literal('surgeonpulse-export'),
  version: z.literal(1),
  exportedAt: z.number(),
  app: z.unknown().optional(),
  deidentified: z.boolean(),
  participants: z.array(z.unknown()),
  sessions: z.array(z.unknown()),
});

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Validate sessions one by one, skipping invalid ones and duplicate ids with a warning. */
function collectSessions(raw: readonly unknown[], warnings: string[]): SurgicalSession[] {
  const sessions: SurgicalSession[] = [];
  const seen = new Set<string>();
  raw.forEach((item, i) => {
    const r = safeParseSession(item);
    if (!r.ok) {
      warnings.push(`Skipped sessions[${i}]: ${r.error.issues.join('; ')}`);
      return;
    }
    if (seen.has(r.session.id)) {
      warnings.push(`Skipped sessions[${i}]: duplicate session id "${r.session.id}"`);
      return;
    }
    seen.add(r.session.id);
    sessions.push(r.session);
  });
  return sessions;
}

/** Latest timestamp in the sessions, used as `exportedAt` when wrapping bare sessions. */
function latestTime(sessions: readonly SurgicalSession[]): EpochMs {
  let latest: EpochMs | undefined;
  for (const s of sessions) {
    const t = s.endedAt ?? s.startedAt;
    if (latest === undefined || t > latest) latest = t;
  }
  return latest ?? 0;
}

/**
 * Parse an imported file (SPEC.md › io/bundle.ts). Accepts
 * - an {@link ExportBundle} JSON document,
 * - a single session object, or
 * - an array of session objects (wrapped in a bundle with
 *   `deidentified: false` and `exportedAt` = the latest session end, as the
 *   real export time is unknown).
 *
 * Sessions are migrated, validated and sorted ({@link parseSession}).
 * Invalid sessions, sessions with a duplicate id, and invalid participant
 * profiles are skipped with a warning naming the index and the issues. A
 * `{ code }` participant is synthesised for each session code without a
 * profile. A leading byte-order mark is ignored.
 *
 * @throws SessionParseError if the text is not JSON, is not one of the shapes
 * above, the bundle envelope is invalid (including a newer bundle version),
 * or a lone session object is invalid.
 */
export function parseImport(text: string): { bundle: ExportBundle; warnings: string[] } {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new SessionParseError([`(root): Not valid JSON (${reason})`]);
  }

  const warnings: string[] = [];

  if (Array.isArray(data)) {
    const sessions = collectSessions(data, warnings);
    return {
      bundle: {
        format: 'surgeonpulse-export',
        version: 1,
        exportedAt: latestTime(sessions),
        deidentified: false,
        participants: completeParticipants([], sessions),
        sessions,
      },
      warnings,
    };
  }

  if (!isPlainObject(data)) {
    throw new SessionParseError(['(root): Expected an export bundle, a session object or an array of sessions']);
  }

  if ('format' in data) {
    // Check the version first: a newer bundle should be reported as such, not as a list of shape errors.
    const version = data.version;
    if (data.format === 'surgeonpulse-export' && typeof version === 'number' && version !== 1) {
      throw new SessionParseError([
        `version: Unsupported export bundle version ${version}${version > 1 ? '; update SurgeonPulse to read it' : ''}`,
      ]);
    }
    const env = BundleEnvelopeSchema.safeParse(data);
    if (!env.success) throw new SessionParseError(formatZodIssues(env.error.issues));
    const e = env.data;
    const participants: ParticipantProfile[] = [];
    e.participants.forEach((p, i) => {
      const r = ParticipantProfileSchema.safeParse(p);
      if (r.success) participants.push(r.data);
      else warnings.push(`Skipped participants[${i}]: ${formatZodIssues(r.error.issues).join('; ')}`);
    });
    const sessions = collectSessions(e.sessions, warnings);
    const bundle: ExportBundle = {
      format: 'surgeonpulse-export',
      version: 1,
      exportedAt: e.exportedAt,
      deidentified: e.deidentified,
      participants: completeParticipants(participants, sessions),
      sessions,
    };
    if (e.app !== undefined) {
      const app = AppInfoSchema.safeParse(e.app);
      if (app.success) bundle.app = app.data;
      else warnings.push(`Ignored app: ${formatZodIssues(app.error.issues).join('; ')}`);
    }
    return { bundle, warnings };
  }

  const single = safeParseSession(data);
  if (!single.ok) throw single.error;
  return {
    bundle: {
      format: 'surgeonpulse-export',
      version: 1,
      exportedAt: latestTime([single.session]),
      deidentified: false,
      participants: completeParticipants([], [single.session]),
      sessions: [single.session],
    },
    warnings,
  };
}
