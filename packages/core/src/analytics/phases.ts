/**
 * Operative phase timeline derived from `type: 'phase'` events.
 */
import type { EpochMs, PhaseEvent, PhaseKind, PhaseSegment, SurgicalSession } from '../types';
import { stableSortBy } from './stats';

function maxT(xs: readonly { t: number }[]): number {
  let m = Number.NEGATIVE_INFINITY;
  for (const x of xs) if (Number.isFinite(x.t) && x.t > m) m = x.t;
  return m;
}

/**
 * End of a session: `endedAt` when set; otherwise the latest of the last sample t, last RR t and last event t
 * (useful while recording); otherwise `startedAt`.
 */
export function sessionEnd(session: SurgicalSession): EpochMs {
  if (typeof session.endedAt === 'number' && Number.isFinite(session.endedAt)) return session.endedAt;
  const latest = Math.max(maxT(session.samples), maxT(session.rr), maxT(session.events));
  return Number.isFinite(latest) ? latest : session.startedAt;
}

/**
 * Splits the session into phase segments.
 *
 * Phase events are stably sorted by t and each t is clamped to `[startedAt, sessionEnd]`. Consecutive events with
 * the same phase keep only the first. A segment runs from its event to the next phase event (or `sessionEnd`).
 * Zero-length segments are dropped, except a final segment that ends exactly at `sessionEnd` (e.g. "post-op"
 * logged as the case ends). After that, adjacent segments with the same phase are merged into one (A, B of zero
 * length, A → a single A), so a phase is never split in per-phase statistics. Time before the first phase event is
 * not a segment. `index` numbers the emitted segments 0, 1, 2, …
 */
export function derivePhases(session: SurgicalSession): PhaseSegment[] {
  const phaseEvents = session.events.filter(
    (e): e is PhaseEvent => e.type === 'phase' && Number.isFinite(e.t),
  );
  if (phaseEvents.length === 0) return [];
  const start = session.startedAt;
  const end = sessionEnd(session);
  const clamp = (t: number): number => Math.min(Math.max(t, start), end);

  const marks: { phase: PhaseKind; t: number }[] = [];
  for (const e of stableSortBy(phaseEvents, (ev) => ev.t)) {
    const prev = marks[marks.length - 1];
    if (prev !== undefined && prev.phase === e.phase) continue;
    marks.push({ phase: e.phase, t: clamp(e.t) });
  }

  const segments: PhaseSegment[] = [];
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i]!;
    const isFinal = i === marks.length - 1;
    const segEnd = isFinal ? end : marks[i + 1]!.t;
    const zeroLength = segEnd - mark.t <= 0;
    if (zeroLength && !(isFinal && segEnd === end)) continue;
    const prev = segments[segments.length - 1];
    if (prev !== undefined && prev.phase === mark.phase) {
      // Only zero-length segments were dropped in between, so the two are contiguous: extend the earlier one.
      prev.end = segEnd;
      continue;
    }
    segments.push({ phase: mark.phase, index: segments.length, start: mark.t, end: segEnd });
  }
  return segments;
}

/**
 * Phase in progress at time `t`: the segment with `start ≤ t < end`; at exactly the last segment's end the last
 * phase is returned. `undefined` outside the segments.
 */
export function phaseAt(segments: readonly PhaseSegment[], t: EpochMs): PhaseKind | undefined {
  for (const seg of segments) {
    if (t >= seg.start && t < seg.end) return seg.phase;
  }
  const last = segments[segments.length - 1];
  if (last !== undefined && t === last.end) return last.phase;
  return undefined;
}
