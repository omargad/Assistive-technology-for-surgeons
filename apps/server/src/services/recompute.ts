/**
 * Keeps stored summaries in step with the analytics definitions.
 *
 * Every summary records the core `ANALYTICS_VERSION` that computed it. When the
 * server starts with a newer core (an analytics fix changed a metric, quality
 * rule or episode rule), summaries from older versions are recomputed from the
 * stored de-identified session, so `summaries.csv` and `GET /sessions` never mix
 * two definitions. The session body and its digest are not touched.
 */
import { ANALYTICS_VERSION, parseSession, summarizeSession } from '@surgeonpulse/core';
import type { Repo } from '../repo';

export interface RecomputeResult {
  recomputed: number;
  failed: number;
}

/** Recompute every stored summary whose `analyticsVersion` differs from the current one. */
export function recomputeStaleSummaries(repo: Repo, now: number): RecomputeResult {
  const stale = repo.staleSummarySessions(ANALYTICS_VERSION);
  let recomputed = 0;
  let failed = 0;
  for (const { id, body } of stale) {
    try {
      repo.updateSummary(id, summarizeSession(parseSession(JSON.parse(body))));
      recomputed++;
    } catch {
      failed++;
    }
  }
  if (stale.length > 0) {
    repo.audit(
      { actor: 'system', action: 'summaries.recompute', detail: { analyticsVersion: ANALYTICS_VERSION, recomputed, failed } },
      now,
    );
  }
  return { recomputed, failed };
}
