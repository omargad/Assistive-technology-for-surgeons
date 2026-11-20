/**
 * Test helpers: a fresh app on a temporary DATA_DIR per test (created with
 * fs.mkdtemp under the OS temp directory, so the suite runs on Windows,
 * macOS and Linux), plus shortcuts for enrolling and uploading simulated
 * sessions from core's simulator.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createExportBundle, simulateSession } from '@surgeonpulse/core';
import type { ParticipantProfile, SimulateOptions, SurgicalSession } from '@surgeonpulse/core';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app';
import type { BuildAppOptions } from '../src/app';
import { loadConfig } from '../src/config';
import type { Config } from '../src/config';

export const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef-XYZ';
export const ADMIN = { authorization: `Bearer ${ADMIN_TOKEN}` } as const;

/** Fixed clock start for deterministic timestamps (2026-11-20T00:00:00Z). */
export const T0 = Date.UTC(2026, 10, 20);

export interface TestContext {
  app: FastifyInstance;
  config: Config;
  dataDir: string;
  /** Mutable clock used by the app (epoch ms). */
  clock: { now: number };
  close(): Promise<void>;
}

export async function makeTempDir(prefix = 'surgeonpulse-test-'): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeDir(dir: string): Promise<void> {
  // Retries cover Windows, where a just-closed SQLite file can be briefly locked.
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

/** Build an app on a fresh temporary data directory. */
export async function createTestApp(
  env: Record<string, string> = {},
  options: Omit<BuildAppOptions, 'now'> = {},
): Promise<TestContext> {
  const dataDir = await makeTempDir();
  const config = loadConfig({ ADMIN_TOKEN, DATA_DIR: dataDir, LOG_LEVEL: 'silent', ...env });
  const clock = { now: T0 };
  const app = buildApp(config, { ...options, now: () => clock.now });
  await app.ready();
  return {
    app,
    config,
    dataDir,
    clock,
    async close() {
      await app.close();
      await removeDir(dataDir);
    },
  };
}

/** A short simulated session (fast to summarise) for `participantCode`. */
export function simSession(participantCode: string, seed: number, extra: SimulateOptions = {}): SurgicalSession {
  return simulateSession({ participantCode, seed, durationMin: 12, ...extra });
}

/** JSON text of a de-identified export bundle, as the mobile app uploads it. */
export function bundleJson(sessions: SurgicalSession[], participants: ParticipantProfile[] = []): string {
  return JSON.stringify(createExportBundle({ sessions, participants, deidentify: true, now: T0 }));
}

export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/** Enrol a participant through the admin API and return the enrolment. */
export async function enrol(
  app: FastifyInstance,
  participantCode: string,
  label?: string,
): Promise<{ id: string; token: string; participantCode: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/enrolments',
    headers: ADMIN,
    payload: label === undefined ? { participantCode } : { participantCode, label },
  });
  if (res.statusCode !== 201) throw new Error(`enrolment failed: ${res.statusCode} ${res.body}`);
  return res.json();
}

/** POST a raw JSON body to the upload endpoint. */
export function upload(app: FastifyInstance, token: string, body: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/v1/sessions',
    headers: { ...bearer(token), 'content-type': 'application/json' },
    payload: body,
  });
}

export interface UploadResponse {
  accepted: { id: string; status: 'created' | 'updated' | 'unchanged' }[];
  rejected: { index: number; id?: string; reason: string }[];
}
