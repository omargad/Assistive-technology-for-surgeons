/**
 * The local "uploaded" marker (`uploaded:<ISO time>` in `session.tags`).
 *
 * Pure helpers with no storage or network imports, so the recording store can
 * use them. The marker means "the server has this version of the session": any
 * change to the session's data (a health-app import, edited event times) must
 * remove it, so the session counts as not uploaded again and the changed data
 * reaches the study server.
 */

export const UPLOADED_TAG_PREFIX = 'uploaded:';

/** `tags` without any `uploaded:` marker (`undefined` stays `undefined`). */
export function withoutUploadedTag(tags: readonly string[] | undefined): string[] | undefined {
  if (tags === undefined) return undefined;
  return tags.filter((t) => !t.startsWith(UPLOADED_TAG_PREFIX));
}

/** Whether `tags` carry an `uploaded:` marker. */
export function hasUploadedTag(tags: readonly string[] | undefined): boolean {
  return (tags ?? []).some((t) => t.startsWith(UPLOADED_TAG_PREFIX));
}
