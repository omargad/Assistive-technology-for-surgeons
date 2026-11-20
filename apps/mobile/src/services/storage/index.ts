/**
 * The app's session repository — native (iOS / Android) entry point.
 *
 * Metro resolves `index.web.ts` instead of this file for the web bundle, so
 * expo-sqlite's native code path is never pulled into the web build.
 */
import { createSqliteRepository } from './sqlite';
import type { SessionRepository } from './types';

export const repository: SessionRepository = createSqliteRepository();
