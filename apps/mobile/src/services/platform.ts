/**
 * Platform facts used when stamping sessions and exports.
 *
 * Works unchanged on iOS, Android and the web: `expo-application` returns
 * `null` versions on the web, so every value has a fallback.
 */
import type { AppInfo, Platform as CorePlatform } from '@surgeonpulse/core';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

/** Consent form version used when none is configured in app.json. */
const DEFAULT_CONSENT_VERSION = 'PICF-1.0';

/** The current runtime platform in the core domain vocabulary. */
export function currentPlatform(): CorePlatform {
  switch (Platform.OS) {
    case 'ios':
    case 'android':
    case 'web':
      return Platform.OS;
    default:
      return 'unknown';
  }
}

/** `extra` values from app.json (`expo.extra`), tolerant of a missing manifest. */
function expoExtra(): Record<string, unknown> {
  const extra: unknown = Constants.expoConfig?.extra;
  return typeof extra === 'object' && extra !== null ? (extra as Record<string, unknown>) : {};
}

function appVersion(): string {
  let native: string | null = null;
  try {
    native = Application.nativeApplicationVersion;
  } catch {
    native = null;
  }
  return native ?? Constants.expoConfig?.version ?? '0.0.0';
}

/** App version + platform, stored with every session and export bundle. */
export function appInfo(): AppInfo {
  return { version: appVersion(), platform: currentPlatform() };
}

/**
 * Local timezone offset in minutes **east** of UTC at time `t`
 * (e.g. AEST → 600, New York in winter → −300). Never returns `-0`.
 */
export function tzOffsetMin(t: number = Date.now()): number {
  const offset = -new Date(t).getTimezoneOffset();
  return offset === 0 ? 0 : offset;
}

/** Version of the participant information & consent form (app.json `extra.consentVersion`). */
export const consentVersion: string = (() => {
  const v = expoExtra().consentVersion;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : DEFAULT_CONSENT_VERSION;
})();

/** Default research server URL from app.json `extra.researchServerUrl` ('' when not configured). */
export function defaultResearchServerUrl(): string {
  const v = expoExtra().researchServerUrl;
  return typeof v === 'string' ? v.trim() : '';
}
