/**
 * De-identification for research export.
 *
 * Sessions never contain patient identifiers by design, but free text
 * (notes, a typed procedure name) might, and device ids, exact dates and
 * birth years are quasi-identifiers for the participating surgeon. These
 * functions remove or coarsen them before data leaves the device or the
 * study server. They never mutate their input.
 */
import type {
  ExportBundle,
  ParticipantProfile,
  PostOpReport,
  ProcedureInfo,
  SensorInfo,
  SessionEvent,
  SurgicalSession,
  WorkloadResponse,
} from '../types';
import { PROCEDURE_CATALOG, findProcedure } from '../catalog/procedures';

/**
 * Machine-generated session tags kept by `dropNotes` (every other tag is free text and is removed):
 * `simulated` (set by the simulator) and `demo` (set by the app's demo mode). Both must survive export so that
 * synthetic data is never mistaken for real measurements.
 */
export const DEIDENTIFY_KEPT_TAGS: readonly string[] = Object.freeze(['simulated', 'demo']);

/** Procedure name used by `dropNotes` when a typed name cannot be matched to the catalogue. */
export const UNSPECIFIED_PROCEDURE_NAME = 'Unspecified procedure';

/** What to remove or shift. Defaults are shown in comments. */
export interface DeidentifyOptions {
  /**
   * Remove all free text: `postOp.notes`, every `event.note` and every tag not
   * in {@link DEIDENTIFY_KEPT_TAGS}; and replace `procedure.name` with the
   * catalogue name (from `catalogId`, or an exact case-insensitive match of the
   * typed name), else with {@link UNSPECIFIED_PROCEDURE_NAME}. Default `true`.
   */
  dropNotes?: boolean;
  /**
   * Remove `sensor.id` (the device's opaque identifier) and the serial number
   * that BLE straps append to their advertised name (`"Polar H10 A1B2C3D4"` →
   * `"Polar H10"`). Default `true`.
   */
  dropSensorId?: boolean;
  /**
   * Milliseconds added to **every** timestamp (session, baseline, samples, RR,
   * external HRV, events, workload completion, consent, export time), so all
   * intervals are preserved while calendar dates are hidden. Default `0`.
   */
  timeShiftMs?: number;
  /** Remove `tzOffsetMin` (local time of day). Default `false`. */
  dropTzOffset?: boolean;
  /** Remove `birthYear` from participant snapshots and profiles. Default `false`. */
  dropBirthYear?: boolean;
}

interface ResolvedOptions {
  dropNotes: boolean;
  dropSensorId: boolean;
  timeShiftMs: number;
  dropTzOffset: boolean;
  dropBirthYear: boolean;
}

function resolve(opts: DeidentifyOptions | undefined): ResolvedOptions {
  const timeShiftMs = opts?.timeShiftMs ?? 0;
  if (!Number.isFinite(timeShiftMs)) {
    throw new RangeError(`timeShiftMs must be a finite number of milliseconds, got ${String(timeShiftMs)}`);
  }
  return {
    dropNotes: opts?.dropNotes ?? true,
    dropSensorId: opts?.dropSensorId ?? true,
    timeShiftMs,
    dropTzOffset: opts?.dropTzOffset ?? false,
    dropBirthYear: opts?.dropBirthYear ?? false,
  };
}

/** Shallow copy without `key`. */
function omit<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

/** A whitespace-separated token that is a device serial / address: hex digits plus `:`/`-`/`_`, ≥ 4 chars. */
function isSerialToken(token: string): boolean {
  const core = token.replace(/^[#(\[]+|[)\]]+$/g, '');
  return /^[0-9A-Fa-f][0-9A-Fa-f:_-]{3,}$/.test(core) && /[0-9:]/.test(core);
}

/**
 * The device model from an advertised BLE name: trailing serial-number tokens (`"Polar H10 A1B2C3D4"`,
 * `"TICKR 1A2B"`, `"Movesense 174630000192"`) and a `:`/`#`-joined hex suffix (`"HRM-Dual:123456"`) are removed.
 * Returns `undefined` when nothing but the serial remains.
 */
export function sensorModelName(name: string): string | undefined {
  const tokens = name.trim().split(/\s+/).filter((t) => t !== '');
  while (tokens.length > 0 && isSerialToken(tokens[tokens.length - 1]!)) tokens.pop();
  if (tokens.length > 0) {
    const last = tokens[tokens.length - 1]!;
    const stripped = last.replace(/[:#][0-9A-Fa-f]{4,}$/, '');
    if (stripped !== last && /[0-9]/.test(last.slice(stripped.length))) {
      if (stripped === '') tokens.pop();
      else tokens[tokens.length - 1] = stripped;
    }
  }
  const out = tokens.join(' ');
  return out === '' ? undefined : out;
}

function deidentifySensor(sensor: SensorInfo, o: ResolvedOptions): SensorInfo {
  if (!o.dropSensorId) return { ...sensor };
  const out: SensorInfo = omit(sensor, 'id');
  if (sensor.name !== undefined) {
    const model = sensorModelName(sensor.name);
    if (model === undefined) delete out.name;
    else out.name = model;
  }
  return out;
}

/** The catalogue name for a procedure, or {@link UNSPECIFIED_PROCEDURE_NAME} for free text that cannot be matched. */
function deidentifyProcedure(p: ProcedureInfo): ProcedureInfo {
  const out: ProcedureInfo = { ...p };
  const byId = p.catalogId !== undefined ? findProcedure(p.catalogId) : undefined;
  if (byId !== undefined) {
    out.name = byId.name;
    return out;
  }
  // An unresolvable catalogId is itself unvetted text.
  delete out.catalogId;
  const typed = p.name.trim().toLowerCase();
  const byName = PROCEDURE_CATALOG.find((e) => e.name.toLowerCase() === typed);
  out.name = byName !== undefined ? byName.name : UNSPECIFIED_PROCEDURE_NAME;
  if (byName !== undefined) out.catalogId = byName.id;
  return out;
}

function copyWorkload(w: WorkloadResponse, shift: number): WorkloadResponse {
  // Copy the nested records too, so the result never shares objects with the input.
  const out = { ...w, ratings: { ...w.ratings }, completedAt: w.completedAt + shift } as WorkloadResponse;
  if (w.weights !== undefined) (out as { weights?: Record<string, number> }).weights = { ...w.weights };
  return out;
}

function assertPseudonymousCode(code: string, where: string): void {
  if (!isValidParticipantCode(code)) {
    throw new RangeError(
      `${where}: participant code ${JSON.stringify(code)} is not a pseudonymous study code ` +
        '(2–32 characters from A–Z, a–z, 0–9, "_" and "-", not e-mail-like); de-identification cannot repair it',
    );
  }
}

function deidentifyEvent(e: SessionEvent, o: ResolvedOptions): SessionEvent {
  const shifted = { ...e, t: e.t + o.timeShiftMs };
  return o.dropNotes ? (omit(shifted, 'note') as SessionEvent) : shifted;
}

function deidentifyPostOp(p: PostOpReport, o: ResolvedOptions): PostOpReport {
  const out: PostOpReport = o.dropNotes ? omit(p, 'notes') : { ...p };
  if (p.workload !== undefined) out.workload = copyWorkload(p.workload, o.timeShiftMs);
  return out;
}

function deidentifySessionResolved(s: SurgicalSession, o: ResolvedOptions): SurgicalSession {
  assertPseudonymousCode(s.participantCode, `session ${JSON.stringify(s.id)}`);
  const shift = o.timeShiftMs;
  const out: SurgicalSession = {
    ...s,
    procedure: o.dropNotes ? deidentifyProcedure(s.procedure) : { ...s.procedure },
    startedAt: s.startedAt + shift,
    sensor: deidentifySensor(s.sensor, o),
    app: { ...s.app },
    samples: s.samples.map((x) => ({ ...x, t: x.t + shift })),
    rr: s.rr.map((x) => ({ ...x, t: x.t + shift })),
    events: s.events.map((e) => deidentifyEvent(e, o)),
  };
  if (s.endedAt !== undefined) out.endedAt = s.endedAt + shift;
  if (s.baseline !== undefined) {
    out.baseline = { ...s.baseline, startedAt: s.baseline.startedAt + shift, endedAt: s.baseline.endedAt + shift };
  }
  if (s.externalHrv !== undefined) out.externalHrv = s.externalHrv.map((x) => ({ ...x, t: x.t + shift }));
  if (s.postOp !== undefined) out.postOp = deidentifyPostOp(s.postOp, o);
  if (s.tags !== undefined) {
    const tags = o.dropNotes ? s.tags.filter((t) => DEIDENTIFY_KEPT_TAGS.includes(t)) : s.tags.slice();
    if (tags.length > 0) out.tags = tags;
    else delete out.tags;
  }
  if (s.participantSnapshot !== undefined) {
    out.participantSnapshot = o.dropBirthYear
      ? omit(s.participantSnapshot, 'birthYear')
      : { ...s.participantSnapshot };
  }
  if (o.dropTzOffset) delete out.tzOffsetMin;
  return out;
}

function deidentifyParticipant(p: ParticipantProfile, o: ResolvedOptions): ParticipantProfile {
  assertPseudonymousCode(p.code, 'participant');
  const out: ParticipantProfile = o.dropBirthYear ? omit(p, 'birthYear') : { ...p };
  if (p.consent !== undefined) {
    out.consent = { version: p.consent.version, givenAt: p.consent.givenAt + o.timeShiftMs };
    if (p.consent.withdrawnAt !== undefined) out.consent.withdrawnAt = p.consent.withdrawnAt + o.timeShiftMs;
  }
  return out;
}

/**
 * Return a de-identified copy of a session (SPEC.md › io/deidentify.ts). The
 * result shares no objects with the input.
 *
 * - `dropNotes` (default on): removes `postOp.notes`, every `event.note` and
 *   every tag except {@link DEIDENTIFY_KEPT_TAGS}; replaces `procedure.name`
 *   with the catalogue name when `catalogId` resolves or the typed name exactly
 *   matches a catalogue name (case-insensitive), and otherwise with
 *   {@link UNSPECIFIED_PROCEDURE_NAME} (free text such as "Lap chole for Mrs
 *   Jones" could identify a patient); an unresolvable `catalogId` is removed.
 * - `dropSensorId` (default on): removes `sensor.id` and the serial number in
 *   `sensor.name` ({@link sensorModelName}).
 * - `timeShiftMs`: added consistently to `startedAt`, `endedAt`, the baseline
 *   window, every sample/RR/external-HRV/event `t` and
 *   `postOp.workload.completedAt`, so all durations and offsets are unchanged.
 * - `dropTzOffset`, `dropBirthYear`: remove those fields.
 *
 * With the defaults, calendar dates and local times are kept (`timeShiftMs: 0`,
 * `tzOffsetMin` kept): a study that must hide operating dates chooses a secret
 * shift and sets `dropTzOffset`.
 *
 * The participant code is kept: it must already be a pseudonym.
 *
 * @throws RangeError if `timeShiftMs` is not finite, or if the participant
 *   code fails {@link isValidParticipantCode} (e.g. an e-mail address), which
 *   de-identification cannot repair.
 */
export function deidentifySession(s: SurgicalSession, opts?: DeidentifyOptions): SurgicalSession {
  return deidentifySessionResolved(s, resolve(opts));
}

/**
 * Return a de-identified copy of an export bundle: the same options are
 * applied to every session and participant; `consent.version` is kept and
 * `consent.givenAt`/`withdrawnAt` are shifted; `exportedAt` is shifted too (an
 * unshifted export time would reveal the offset); `deidentified` is set to
 * `true` (meaning "{@link deidentifySession} was applied to every session",
 * whatever the options).
 *
 * @throws RangeError if `timeShiftMs` is not finite, or if any session's or
 *   participant's code fails {@link isValidParticipantCode}.
 */
export function deidentifyBundle(b: ExportBundle, opts?: DeidentifyOptions): ExportBundle {
  const o = resolve(opts);
  const out: ExportBundle = {
    ...b,
    exportedAt: b.exportedAt + o.timeShiftMs,
    deidentified: true,
    participants: b.participants.map((p) => deidentifyParticipant(p, o)),
    sessions: b.sessions.map((s) => deidentifySessionResolved(s, o)),
  };
  if (b.app !== undefined) out.app = { ...b.app };
  return out;
}

const PARTICIPANT_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/;
/** Catches e-mail addresses with the `@`/`.` replaced to fit the code alphabet, e.g. `jane_doe-at-hospital-org`. */
const EMAIL_LIKE_RE = /[@]|[_-]at[_-][A-Za-z0-9-]+[_-](com|org|net|edu|gov|nhs|ac|co|uk|au|nz|ca|de|fr|io)$/i;

/**
 * Whether `code` is acceptable as a pseudonymous participant code: 2–32
 * characters from `[A-Za-z0-9_-]` starting with a letter or digit
 * (`/^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/`), and not an e-mail-like string.
 * Examples: `"SP-014"` ✓, `"P07"` ✓, `"jane@hospital.org"` ✗, `"jane-at-hospital-org"` ✗.
 */
export function isValidParticipantCode(code: string): boolean {
  if (typeof code !== 'string') return false;
  return PARTICIPANT_CODE_RE.test(code) && !EMAIL_LIKE_RE.test(code);
}
