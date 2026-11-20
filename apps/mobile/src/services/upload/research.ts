/**
 * Research upload, wired into the app: uploads with the shared client and
 * then records the upload in each accepted session's tags
 * (`uploaded:<ISO time>`) so the UI can show what has been sent. The server is
 * idempotent, so re-uploading is always safe.
 */
import type { ParticipantProfile, SurgicalSession } from '@surgeonpulse/core';
import { appInfo } from '../platform';
import { repository } from '../storage';
import { createUploader } from './client';
import type { UploadResult } from './client';

export type { UploadResult } from './client';
export { UploadError, normalizeServerUrl } from './client';

export const UPLOADED_TAG_PREFIX = 'uploaded:';

const uploader = createUploader({ app: appInfo });

/** Tags with any previous `uploaded:` marker replaced by one for `at`. */
export function withUploadedTag(tags: readonly string[] | undefined, at: number): string[] {
  return [...(tags ?? []).filter((t) => !t.startsWith(UPLOADED_TAG_PREFIX)), `${UPLOADED_TAG_PREFIX}${new Date(at).toISOString()}`];
}

/** Time of the last successful upload recorded in `tags`, or null. */
export function lastUploadedAt(tags: readonly string[] | undefined): number | null {
  const tag = (tags ?? []).find((t) => t.startsWith(UPLOADED_TAG_PREFIX));
  if (!tag) return null;
  const t = Date.parse(tag.slice(UPLOADED_TAG_PREFIX.length));
  return Number.isFinite(t) ? t : null;
}

async function markUploaded(sessions: readonly SurgicalSession[], result: UploadResult): Promise<void> {
  const at = Date.now();
  const byId = new Map(sessions.map((s) => [s.id, s]));
  for (const { id } of result.accepted) {
    const session = byId.get(id);
    if (!session) continue;
    try {
      await repository.updateMeta(id, { tags: withUploadedTag(session.tags, at) });
    } catch {
      // Tagging is bookkeeping only; the upload itself succeeded.
    }
  }
}

/** Upload de-identified sessions to the research server and tag the accepted ones locally. */
export async function uploadSessions(
  sessions: SurgicalSession[],
  cfg: { url: string; token: string; profile?: ParticipantProfile | null },
): Promise<UploadResult> {
  const result = await uploader.uploadSessions(sessions, cfg);
  await markUploaded(sessions, result);
  return result;
}

/** Confirm the enrolment token with the server (`GET /api/v1/me`). */
export function checkEnrolment(cfg: { url: string; token: string }): Promise<{ participantCode: string; sessionCount: number }> {
  return uploader.checkEnrolment(cfg);
}
