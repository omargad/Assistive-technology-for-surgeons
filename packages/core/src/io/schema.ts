/**
 * Runtime validation of persisted data (zod v4).
 *
 * The schemas mirror `types.ts` exactly; compile-time checks at the bottom of
 * this file fail the type-check if the two drift apart. Unknown keys are
 * stripped (forward-compatible with additive fields), never rejected.
 *
 * Numeric ranges (SPEC.md › io/schema.ts): bpm 0–300, RR 0–5000 ms, ratings
 * 0–100, performance and perceived stress 0–10, complexity 1–5. All numbers
 * must be finite (zod v4 rejects NaN and ±Infinity by default). Time windows
 * must not run backwards: a session's `endedAt` (when present) and a
 * baseline's `endedAt` must be ≥ their `startedAt`.
 */
import { z } from 'zod';
import { SCHEMA_VERSION } from '../types';
import type {
  AppInfo,
  Baseline,
  ConsentRecord,
  ExportBundle,
  ExternalHrvReading,
  HeartRateSample,
  ParticipantProfile,
  ParticipantSnapshot,
  PostOpReport,
  ProcedureInfo,
  RRInterval,
  SensorInfo,
  SessionEvent,
  SurgicalSession,
  WorkloadResponse,
} from '../types';
import { sortSession } from '../util/session';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const epochMs = z.number();
const bpm = z.number().min(0).max(300);
const rrMs = z.number().min(0).max(5000);
const rating = z.number().min(0).max(100);
const zeroToTen = z.number().min(0).max(10);
const nonNegative = z.number().min(0);
const nonEmpty = z.string().min(1);

const sensorSource = z.enum(['ble', 'web-bluetooth', 'healthkit', 'health-connect', 'simulated', 'import']);
const phaseKind = z.enum(['pre-op', 'incision', 'dissection', 'critical', 'closure', 'post-op']);
const markerKind = z.enum(['complication', 'interruption', 'equipment', 'teaching', 'takeover', 'note']);
const eventLogger = z.enum(['self', 'team', 'retrospective']);
const approach = z.enum(['open', 'laparoscopic', 'robotic', 'endoscopic', 'percutaneous', 'microsurgical', 'other']);
const role = z.enum(['primary', 'assistant', 'supervising', 'observing']);
const urgency = z.enum(['elective', 'urgent', 'emergency']);
const trainingLevel = z.enum(['consultant', 'fellow', 'registrar', 'resident', 'intern', 'student', 'other']);
const platform = z.enum(['ios', 'android', 'web', 'unknown']);

// ---------------------------------------------------------------------------
// Sensors & signals
// ---------------------------------------------------------------------------

export const SensorInfoSchema = z.object({
  source: sensorSource,
  name: z.string().optional(),
  id: z.string().optional(),
  location: z.string().optional(),
});

export const AppInfoSchema = z.object({
  version: z.string(),
  platform,
});

export const HeartRateSampleSchema = z.object({
  t: epochMs,
  bpm,
  contact: z.boolean().optional(),
});

export const RRIntervalSchema = z.object({
  t: epochMs,
  ms: rrMs,
});

export const ExternalHrvReadingSchema = z.object({
  t: epochMs,
  metric: z.enum(['sdnn', 'rmssd']),
  ms: nonNegative,
  source: sensorSource,
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const eventBase = {
  id: nonEmpty,
  t: epochMs,
  note: z.string().optional(),
  loggedBy: eventLogger.optional(),
};

export const PhaseEventSchema = z.object({ ...eventBase, type: z.literal('phase'), phase: phaseKind });
export const MarkerEventSchema = z.object({ ...eventBase, type: z.literal('marker'), marker: markerKind });
export const SessionEventSchema = z.discriminatedUnion('type', [PhaseEventSchema, MarkerEventSchema]);

// ---------------------------------------------------------------------------
// Procedure, participant, self-report
// ---------------------------------------------------------------------------

export const ProcedureInfoSchema = z.object({
  name: z.string(),
  catalogId: z.string().optional(),
  specialty: z.string().optional(),
  approach: approach.optional(),
  role: role.optional(),
  complexity: z.literal([1, 2, 3, 4, 5]).optional(),
  urgency: urgency.optional(),
});

export const ConsentRecordSchema = z.object({
  version: z.string(),
  givenAt: epochMs,
  withdrawnAt: epochMs.optional(),
});

const profileFields = {
  trainingLevel: trainingLevel.optional(),
  specialty: z.string().optional(),
  yearsExperience: nonNegative.optional(),
  birthYear: z.number().int().min(1900).max(2100).optional(),
  maxHr: bpm.optional(),
  restingHr: bpm.optional(),
};

export const ParticipantSnapshotSchema = z.object(profileFields);

export const ParticipantProfileSchema = z.object({
  code: nonEmpty,
  ...profileFields,
  consent: ConsentRecordSchema.optional(),
});

/** Pairwise-comparison tallies. Not range-checked here: `scoreWorkload` ignores invalid weights. */
const weight = z.number();

export const SurgTlxResponseSchema = z.object({
  instrument: z.literal('surg-tlx'),
  ratings: z.object({
    mental: rating,
    physical: rating,
    temporal: rating,
    complexity: rating,
    stress: rating,
    distraction: rating,
  }),
  weights: z
    .object({
      mental: weight,
      physical: weight,
      temporal: weight,
      complexity: weight,
      stress: weight,
      distraction: weight,
    })
    .optional(),
  completedAt: epochMs,
});

export const NasaTlxResponseSchema = z.object({
  instrument: z.literal('nasa-tlx'),
  ratings: z.object({
    mental: rating,
    physical: rating,
    temporal: rating,
    performance: rating,
    effort: rating,
    frustration: rating,
  }),
  weights: z
    .object({
      mental: weight,
      physical: weight,
      temporal: weight,
      performance: weight,
      effort: weight,
      frustration: weight,
    })
    .optional(),
  completedAt: epochMs,
});

export const WorkloadResponseSchema = z.discriminatedUnion('instrument', [
  SurgTlxResponseSchema,
  NasaTlxResponseSchema,
]);

export const PostOpReportSchema = z.object({
  workload: WorkloadResponseSchema.optional(),
  performance: zeroToTen.optional(),
  perceivedStress: zeroToTen.optional(),
  sleepHours: z.number().min(0).max(24).optional(),
  caffeine: z.boolean().optional(),
  outcome: z.enum(['as-planned', 'minor-deviation', 'major-deviation']).optional(),
  notes: z.string().optional(),
});

export const BaselineSchema = z
  .object({
    startedAt: epochMs,
    endedAt: epochMs,
    restingHr: bpm,
    rmssd: nonNegative.optional(),
    sdnn: nonNegative.optional(),
    source: z.enum(['measured', 'manual', 'profile']),
  })
  .refine((b) => b.endedAt >= b.startedAt, { message: 'endedAt must not be before startedAt', path: ['endedAt'] });

// ---------------------------------------------------------------------------
// Session & bundle
// ---------------------------------------------------------------------------

export const SurgicalSessionSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: nonEmpty,
  participantCode: nonEmpty,
  procedure: ProcedureInfoSchema,
  startedAt: epochMs,
  endedAt: epochMs.optional(),
  status: z.enum(['recording', 'completed', 'aborted']),
  sensor: SensorInfoSchema,
  app: AppInfoSchema,
  tzOffsetMin: z.number().min(-1440).max(1440).optional(),
  participantSnapshot: ParticipantSnapshotSchema.optional(),
  baseline: BaselineSchema.optional(),
  samples: z.array(HeartRateSampleSchema),
  rr: z.array(RRIntervalSchema),
  externalHrv: z.array(ExternalHrvReadingSchema).optional(),
  events: z.array(SessionEventSchema),
  postOp: PostOpReportSchema.optional(),
  tags: z.array(z.string()).optional(),
})
  // finishSession enforces this for sessions recorded in the app; imports must not bypass it (a backwards window
  // would give a negative duration and phase segments that start before the session).
  .refine((s) => s.endedAt === undefined || s.endedAt >= s.startedAt, {
    message: 'endedAt must not be before startedAt',
    path: ['endedAt'],
  });

export const ExportBundleSchema = z.object({
  format: z.literal('surgeonpulse-export'),
  version: z.literal(1),
  exportedAt: epochMs,
  app: AppInfoSchema.optional(),
  deidentified: z.boolean(),
  participants: z.array(ParticipantProfileSchema),
  sessions: z.array(SurgicalSessionSchema),
});

// ---------------------------------------------------------------------------
// Compile-time contract checks: zod output ⇄ types.ts (both directions).
// A mismatch makes `Check<…>` fail with "Type 'false' does not satisfy the constraint 'true'".
// ---------------------------------------------------------------------------

type Check<T extends true> = T;
type Assignable<From, To> = [From] extends [To] ? true : false;
type Mutual<A, B> = Assignable<A, B> extends true ? Assignable<B, A> : false;

/**
 * @internal Exported only so that consumers compiling core from source with `noUnusedLocals` do not trip on it.
 * It has no runtime value; it exists to fail compilation when the zod schemas and types.ts drift apart.
 */
export type SchemaContractChecks = [
  Check<Mutual<z.infer<typeof SensorInfoSchema>, SensorInfo>>,
  Check<Mutual<z.infer<typeof AppInfoSchema>, AppInfo>>,
  Check<Mutual<z.infer<typeof HeartRateSampleSchema>, HeartRateSample>>,
  Check<Mutual<z.infer<typeof RRIntervalSchema>, RRInterval>>,
  Check<Mutual<z.infer<typeof ExternalHrvReadingSchema>, ExternalHrvReading>>,
  Check<Mutual<z.infer<typeof SessionEventSchema>, SessionEvent>>,
  Check<Mutual<z.infer<typeof ProcedureInfoSchema>, ProcedureInfo>>,
  Check<Mutual<z.infer<typeof ConsentRecordSchema>, ConsentRecord>>,
  Check<Mutual<z.infer<typeof ParticipantSnapshotSchema>, ParticipantSnapshot>>,
  Check<Mutual<z.infer<typeof ParticipantProfileSchema>, ParticipantProfile>>,
  Check<Mutual<z.infer<typeof WorkloadResponseSchema>, WorkloadResponse>>,
  Check<Mutual<z.infer<typeof PostOpReportSchema>, PostOpReport>>,
  Check<Mutual<z.infer<typeof BaselineSchema>, Baseline>>,
  Check<Mutual<z.infer<typeof SurgicalSessionSchema>, SurgicalSession>>,
  Check<Mutual<z.infer<typeof ExportBundleSchema>, ExportBundle>>,
];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A session (or bundle) failed validation or migration. `issues` holds one
 * human-readable `"path: message"` line per problem, e.g.
 * `"samples[3].bpm: Too big: expected number to be <=300"`.
 */
export class SessionParseError extends Error {
  readonly issues: string[];

  constructor(issues: readonly string[], message?: string) {
    const list = issues.length > 0 ? issues.slice() : ['(root): Invalid session'];
    const shown = list.slice(0, 5).join('; ');
    const more = list.length > 5 ? ` (+${list.length - 5} more)` : '';
    super(message ?? `Invalid session data: ${shown}${more}`);
    // Keep `instanceof` working when the class is down-levelled to ES5 (Babel / Metro).
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'SessionParseError';
    this.issues = list;
  }
}

/** Format a zod issue path as `samples[3].bpm` (`(root)` for the top level). */
function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const key of path) {
    if (typeof key === 'number') out += `[${key}]`;
    else out += out === '' ? String(key) : `.${String(key)}`;
  }
  return out === '' ? '(root)' : out;
}

/**
 * Convert zod issues to `"path: message"` lines, optionally under a path
 * prefix (e.g. `sessions[2]`). Exported for the bundle importer.
 */
export function formatZodIssues(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
  prefix?: string,
): string[] {
  return issues.map((issue) => {
    const p = formatPath(issue.path);
    const full = prefix === undefined ? p : p === '(root)' ? prefix : p.startsWith('[') ? `${prefix}${p}` : `${prefix}.${p}`;
    return `${full}: ${issue.message}`;
  });
}

// ---------------------------------------------------------------------------
// Migration & parsing
// ---------------------------------------------------------------------------

/**
 * Upgraders from version `v` to `v + 1`, keyed by `v`. None exist yet:
 * `SCHEMA_VERSION` is 1. When `types.ts` bumps the version, add an entry here.
 */
const MIGRATIONS: Readonly<Record<number, (raw: Record<string, unknown>) => Record<string, unknown>>> = {};

function describeValue(x: unknown): string {
  if (typeof x === 'string') return x.length <= 40 ? JSON.stringify(x) : 'string';
  if (x === null) return 'null';
  if (typeof x === 'object') return Array.isArray(x) ? 'array' : 'object';
  return String(x);
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Upgrade a persisted session object to the current {@link SCHEMA_VERSION}.
 * Version 1 is returned unchanged (identity). Does not validate the shape
 * beyond `schemaVersion`; {@link parseSession} does that afterwards.
 *
 * @throws SessionParseError if `raw` is not an object, `schemaVersion` is
 * missing or not a positive integer, or the version is newer than this
 * library supports (the app needs updating) or has no migration path.
 */
export function migrateSession(raw: unknown): unknown {
  if (!isPlainObject(raw)) {
    throw new SessionParseError([`(root): Expected a session object, received ${describeValue(raw)}`]);
  }
  const version = raw.schemaVersion;
  if (version === undefined) {
    throw new SessionParseError(['schemaVersion: Missing schemaVersion; cannot tell which format this session uses']);
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new SessionParseError([`schemaVersion: Unsupported schemaVersion ${describeValue(version)}`]);
  }
  if (version > SCHEMA_VERSION) {
    throw new SessionParseError([
      `schemaVersion: Session uses schemaVersion ${version}, newer than the supported ${SCHEMA_VERSION}; update SurgeonPulse to read it`,
    ]);
  }
  let current: Record<string, unknown> = raw;
  for (let v = version; v < SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (step === undefined) {
      throw new SessionParseError([`schemaVersion: No migration from schemaVersion ${v} to ${v + 1}`]);
    }
    current = { ...step(current), schemaVersion: v + 1 };
  }
  return current;
}

/**
 * Parse untrusted input into a {@link SurgicalSession}: migrate → validate
 * (unknown keys stripped) → stably sort `samples`, `rr`, `events` and
 * `externalHrv` by `t`. Always returns a new object; the input is untouched.
 *
 * @throws SessionParseError with one `"path: message"` line per issue.
 */
export function parseSession(raw: unknown): SurgicalSession {
  const migrated = migrateSession(raw);
  const result = SurgicalSessionSchema.safeParse(migrated);
  if (!result.success) throw new SessionParseError(formatZodIssues(result.error.issues));
  return sortSession(result.data);
}

/** Non-throwing variant of {@link parseSession}. */
export function safeParseSession(
  raw: unknown,
): { ok: true; session: SurgicalSession } | { ok: false; error: SessionParseError } {
  try {
    return { ok: true, session: parseSession(raw) };
  } catch (err) {
    if (err instanceof SessionParseError) return { ok: false, error: err };
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: new SessionParseError([`(root): ${message}`]) };
  }
}
