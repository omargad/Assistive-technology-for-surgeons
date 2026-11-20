/**
 * Dependencies shared by the route modules, created once per app in `app.ts`.
 */
import type { AuthHooks } from './auth';
import type { Config } from './config';
import type { TokenBucketLimiter } from './rateLimit';
import type { Repo } from './repo';

export interface AppContext {
  config: Config;
  repo: Repo;
  auth: AuthHooks;
  limiter: TokenBucketLimiter;
  /** Clock (epoch ms); injectable for tests. */
  now: () => number;
}

/** A filesystem-safe timestamp for download names on every OS (no `:`), e.g. `20261120T061502Z`. */
export function fileTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

/** `Content-Disposition` value for a download. */
export function attachment(fileName: string): string {
  return `attachment; filename="${fileName}"`;
}
