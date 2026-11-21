/**
 * The id of the stored session that the recording flow currently owns (being
 * recorded, waiting for its debrief, or resumed after an interruption), so
 * that data-management actions (delete, delete all, import) never pull a
 * session out from under the recording store.
 *
 * `recording.ts` registers the source; this module has no dependencies so the
 * sessions store can read it without an import cycle.
 */
let source: () => string | null = () => null;

/** Called once by `recording.ts`. */
export function setActiveSessionSource(fn: () => string | null): void {
  source = fn;
}

/** Id of the session owned by the recording flow, or null when no case is in progress. */
export function activeSessionId(): string | null {
  try {
    return source();
  } catch {
    return null;
  }
}
