/**
 * Immutable helpers for building and editing a {@link SurgicalSession} while
 * it is being recorded (mobile app) or curated (dashboard / server).
 *
 * Every function returns a new object and never mutates its arguments, so the
 * results can be used directly as React state. Time-ordered arrays
 * (`samples`, `rr`, `events`, `externalHrv`) are kept sorted ascending by `t`
 * with a *stable* order: items with equal `t` keep their relative order, and
 * newly inserted items go after existing items with the same `t`. For `rr`
 * this preserves beat order when several intervals share one BLE notification
 * timestamp.
 */
import { SCHEMA_VERSION } from '../types';
import type {
  AppInfo,
  Baseline,
  EpochMs,
  EventLogger,
  ExternalHrvReading,
  HeartRateSample,
  MarkerEvent,
  MarkerKind,
  ParticipantSnapshot,
  PhaseEvent,
  PhaseKind,
  ProcedureInfo,
  RRInterval,
  SensorInfo,
  SessionEvent,
  SessionStatus,
  SurgicalSession,
} from '../types';
import { createId } from './id';

/** Anything with a timestamp. */
interface Timed {
  t: EpochMs;
}

/**
 * Stable sort by `t`, independent of the JS engine's `Array.prototype.sort`
 * stability (older Hermes releases used an unstable sort). Non-finite `t`
 * values sort last, in original order. Returns a new array.
 */
function stableSortByT<T extends Timed>(xs: readonly T[]): T[] {
  if (isSortedByT(xs)) return xs.slice();
  const keyed = xs.map((item, index) => ({ item, index }));
  keyed.sort((a, b) => {
    const at = a.item.t;
    const bt = b.item.t;
    const aBad = !Number.isFinite(at);
    const bBad = !Number.isFinite(bt);
    if (aBad || bBad) {
      if (aBad && bBad) return a.index - b.index;
      return aBad ? 1 : -1;
    }
    return at - bt || a.index - b.index;
  });
  return keyed.map((k) => k.item);
}

function isSortedByT(xs: readonly Timed[]): boolean {
  for (let i = 1; i < xs.length; i++) {
    const prev = xs[i - 1] as Timed;
    const cur = xs[i] as Timed;
    if (!(cur.t >= prev.t)) return false; // also false for NaN
  }
  return true;
}

/**
 * Merge `incoming` into the already-sorted `existing`, keeping stable
 * t-order (existing items first on ties). Fast path for the common case of
 * appending in time order during live recording.
 */
function mergeSorted<T extends Timed>(existing: readonly T[], incoming: readonly T[]): T[] {
  if (incoming.length === 0) return existing.slice();
  const add = stableSortByT(incoming);
  const lastExisting = existing[existing.length - 1];
  const firstAdd = add[0] as T;
  if (lastExisting === undefined || firstAdd.t >= lastExisting.t) return existing.concat(add);
  if (!isSortedByT(existing)) return stableSortByT(existing.concat(add));
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (i < existing.length && j < add.length) {
    const a = existing[i] as T;
    const b = add[j] as T;
    // `!(b.t < a.t)` keeps existing first on ties and pushes non-finite t to the end.
    if (!(b.t < a.t)) {
      out.push(a);
      i++;
    } else {
      out.push(b);
      j++;
    }
  }
  while (i < existing.length) out.push(existing[i++] as T);
  while (j < add.length) out.push(add[j++] as T);
  return out;
}

function assertFiniteTime(name: string, t: number): void {
  if (!Number.isFinite(t)) throw new RangeError(`${name} must be a finite epoch-ms timestamp, got ${String(t)}`);
}

/** Copy an object without the keys whose value is `undefined`. */
function withoutUndefined<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const v = (obj as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = v;
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/** Input for {@link createSession}. */
export interface CreateSessionInput {
  participantCode: string;
  procedure: ProcedureInfo;
  sensor: SensorInfo;
  app: AppInfo;
  startedAt: EpochMs;
  /** Defaults to a fresh {@link createId} UUID. */
  id?: string;
  /** Minutes east of UTC at the start of the case. */
  tzOffsetMin?: number;
  participantSnapshot?: ParticipantSnapshot;
  baseline?: Baseline;
}

/**
 * Start a new session in `status: 'recording'` with empty `samples`, `rr` and
 * `events` (SPEC.md › util/session.ts). Nested input objects are shallow-copied
 * so later edits to them do not leak into the session.
 *
 * @throws RangeError if `startedAt` is not a finite number.
 */
export function createSession(input: CreateSessionInput): SurgicalSession {
  assertFiniteTime('startedAt', input.startedAt);
  const session: SurgicalSession = {
    schemaVersion: SCHEMA_VERSION,
    id: input.id ?? createId(),
    participantCode: input.participantCode,
    procedure: { ...input.procedure },
    startedAt: input.startedAt,
    status: 'recording',
    sensor: { ...input.sensor },
    app: { ...input.app },
    samples: [],
    rr: [],
    events: [],
  };
  if (input.tzOffsetMin !== undefined) session.tzOffsetMin = input.tzOffsetMin;
  if (input.participantSnapshot !== undefined) session.participantSnapshot = { ...input.participantSnapshot };
  if (input.baseline !== undefined) session.baseline = { ...input.baseline };
  return session;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/**
 * Return a new session with `samples` inserted in time order (stable; new
 * samples go after existing samples with the same `t`).
 */
export function appendSamples(session: SurgicalSession, samples: readonly HeartRateSample[]): SurgicalSession {
  if (samples.length === 0) return { ...session, samples: session.samples.slice() };
  return { ...session, samples: mergeSorted(session.samples, samples) };
}

/**
 * Return a new session with RR intervals inserted in time order. Intervals in
 * one batch that share a notification timestamp keep their beat order, and are
 * placed after any existing intervals with the same `t`.
 */
export function appendRr(session: SurgicalSession, rr: readonly RRInterval[]): SurgicalSession {
  if (rr.length === 0) return { ...session, rr: session.rr.slice() };
  return { ...session, rr: mergeSorted(session.rr, rr) };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** A phase or marker event, with `id` optional (generated when omitted). */
export type NewSessionEvent =
  | (Omit<PhaseEvent, 'id'> & { id?: string })
  | (Omit<MarkerEvent, 'id'> & { id?: string });

/**
 * Fields of an event that {@link updateEvent} may change. `phase` only applies
 * to phase events and `marker` only to marker events; a key set to
 * `undefined` removes that optional field (e.g. `{ note: undefined }`).
 */
export interface SessionEventPatch {
  t?: EpochMs;
  note?: string;
  loggedBy?: EventLogger;
  phase?: PhaseKind;
  marker?: MarkerKind;
}

/**
 * Return a new session with `event` inserted in time order (after existing
 * events with the same `t`). A missing `id` is filled with {@link createId}.
 *
 * @throws RangeError if `event.t` is not finite.
 */
export function addEvent(session: SurgicalSession, event: SessionEvent | NewSessionEvent): SurgicalSession {
  assertFiniteTime('event.t', event.t);
  const full = withoutUndefined({ ...event, id: event.id ?? createId() }) as SessionEvent;
  return { ...session, events: mergeSorted(session.events, [full]) };
}

/**
 * Return a new session in which the event with `id` has `patch` applied.
 * Changing `t` re-positions the event (stable). `id` and `type` cannot change;
 * a `phase` patch on a marker event (or `marker` on a phase event) is ignored.
 * If no event has that id, the input session is returned unchanged.
 *
 * @throws RangeError if `patch.t` is present but not finite.
 */
export function updateEvent(session: SurgicalSession, id: string, patch: SessionEventPatch): SurgicalSession {
  const index = session.events.findIndex((e) => e.id === id);
  if (index < 0) return session;
  if ('t' in patch && patch.t !== undefined) assertFiniteTime('patch.t', patch.t);
  const current = session.events[index] as SessionEvent;

  const merged: Record<string, unknown> = { ...current };
  const apply = (key: keyof SessionEventPatch): void => {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) return;
    merged[key] = patch[key];
  };
  if ('t' in patch && patch.t !== undefined) merged.t = patch.t;
  apply('note');
  apply('loggedBy');
  if (current.type === 'phase' && patch.phase !== undefined) merged.phase = patch.phase;
  if (current.type === 'marker' && patch.marker !== undefined) merged.marker = patch.marker;
  const updated = withoutUndefined(merged) as unknown as SessionEvent;

  if (updated.t === current.t) {
    const events = session.events.slice();
    events[index] = updated;
    return { ...session, events };
  }
  const others = session.events.filter((_, i) => i !== index);
  return { ...session, events: mergeSorted(others, [updated]) };
}

/**
 * Return a new session without the event with `id`. If no event has that id,
 * the input session is returned unchanged.
 */
export function removeEvent(session: SurgicalSession, id: string): SurgicalSession {
  const index = session.events.findIndex((e) => e.id === id);
  if (index < 0) return session;
  return { ...session, events: session.events.filter((_, i) => i !== index) };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Return a new session with `endedAt` and a final `status`
 * (`'completed'` by default, or `'aborted'`).
 *
 * @throws RangeError if `endedAt` is not finite or is before `startedAt`.
 */
export function finishSession(
  session: SurgicalSession,
  endedAt: EpochMs,
  status: Exclude<SessionStatus, 'recording'> = 'completed',
): SurgicalSession {
  assertFiniteTime('endedAt', endedAt);
  if (endedAt < session.startedAt) {
    throw new RangeError(`endedAt (${endedAt}) is before startedAt (${session.startedAt})`);
  }
  return { ...session, endedAt, status };
}

/**
 * Return a new session whose time-ordered arrays (`samples`, `rr`, `events`
 * and `externalHrv` when present) are stably sorted ascending by `t`. Items
 * with a non-finite `t` are moved to the end, in their original order.
 */
export function sortSession(session: SurgicalSession): SurgicalSession {
  const out: SurgicalSession = {
    ...session,
    samples: stableSortByT(session.samples),
    rr: stableSortByT(session.rr),
    events: stableSortByT(session.events),
  };
  if (session.externalHrv !== undefined) {
    out.externalHrv = stableSortByT<ExternalHrvReading>(session.externalHrv);
  }
  return out;
}
