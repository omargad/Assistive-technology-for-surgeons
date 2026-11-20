/**
 * Server configuration from environment variables (see SPEC.md › Configuration).
 *
 * `loadConfig` validates with zod and throws a {@link ConfigError} whose
 * message lists every problem in plain language. Secret values (the admin
 * token) are never echoed in error messages.
 */
import path from 'node:path';
import { z } from 'zod';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Minimum length of `ADMIN_TOKEN`. */
export const MIN_ADMIN_TOKEN_LENGTH = 32;

/** Validated, normalised configuration. */
export interface Config {
  port: number;
  host: string;
  /** Absolute path of the data directory (holds `surgeonpulse.sqlite`). */
  dataDir: string;
  /** Researcher bearer token. Never log it. */
  adminToken: string;
  /** Exact origins allowed for CORS (no trailing slash). Empty disables CORS. */
  corsOrigins: string[];
  maxUploadMb: number;
  /** `maxUploadMb` in bytes; used as Fastify's `bodyLimit`. */
  bodyLimit: number;
  trustProxy: boolean;
  logLevel: LogLevel;
}

/** Thrown by {@link loadConfig}; `message` is ready to print to the console. */
export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Environment variables are strings; treat blank values as unset so defaults apply. */
const blankToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const BOOLEAN_WORDS: Record<string, boolean> = { true: true, false: false, '1': true, '0': false, yes: true, no: false };

/** Parse one CORS origin, returning it normalised (`scheme://host[:port]`), or null when invalid. */
function normaliseOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // Origins have no path, query or credentials; a trailing slash is tolerated.
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username || url.password) {
    return null;
  }
  return url.origin;
}

const EnvSchema = z.object({
  PORT: z.preprocess(
    blankToUndefined,
    z.coerce
      .number({ error: 'must be a number' })
      .int('must be a whole number')
      .min(0, 'must be between 0 and 65535')
      .max(65535, 'must be between 0 and 65535')
      .default(8787),
  ),
  HOST: z.preprocess(blankToUndefined, z.string().trim().default('127.0.0.1')),
  DATA_DIR: z.preprocess(blankToUndefined, z.string().default('./data')),
  ADMIN_TOKEN: z.preprocess(
    blankToUndefined,
    z
      .string({
        error: (issue) =>
          issue.input === undefined
            ? `is required (a random secret of at least ${MIN_ADMIN_TOKEN_LENGTH} characters)`
            : 'must be a string',
      })
      .trim()
      .min(MIN_ADMIN_TOKEN_LENGTH, `must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters`)
      .regex(/^\S+$/, 'must not contain whitespace'),
  ),
  CORS_ORIGINS: z.preprocess(
    blankToUndefined,
    z
      .string()
      .default('')
      .transform((value, ctx) => {
        const origins: string[] = [];
        for (const part of value.split(',')) {
          const raw = part.trim();
          if (raw === '') continue;
          if (raw === '*') {
            ctx.addIssue({ code: 'custom', message: 'wildcard "*" is not allowed; list the exact origins' });
            continue;
          }
          const origin = normaliseOrigin(raw);
          if (origin === null) {
            ctx.addIssue({ code: 'custom', message: `"${raw}" is not an origin like https://dashboard.example.org` });
            continue;
          }
          if (!origins.includes(origin)) origins.push(origin);
        }
        return origins;
      }),
  ),
  MAX_UPLOAD_MB: z.preprocess(
    blankToUndefined,
    z.coerce
      .number({ error: 'must be a number' })
      .positive('must be greater than 0')
      .max(1024, 'must be at most 1024')
      .default(25),
  ),
  TRUST_PROXY: z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim() === '' ? undefined : v.trim().toLowerCase()) : v),
    z
      .string()
      .default('false')
      .refine((v) => v in BOOLEAN_WORDS, 'must be true or false')
      .transform((v) => BOOLEAN_WORDS[v] === true),
  ),
  LOG_LEVEL: z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim() === '' ? undefined : v.trim().toLowerCase()) : v),
    z.enum(LOG_LEVELS, { error: `must be one of ${LOG_LEVELS.join(', ')}` }).default('info'),
  ),
});

/**
 * Validate the environment and return the server configuration.
 *
 * @param env  Usually `process.env`.
 * @param cwd  Base for a relative `DATA_DIR` (default: the current directory).
 * @throws ConfigError listing every invalid or missing variable.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): Config {
  const parsed = EnvSchema.safeParse({
    PORT: env.PORT,
    HOST: env.HOST,
    DATA_DIR: env.DATA_DIR,
    ADMIN_TOKEN: env.ADMIN_TOKEN,
    CORS_ORIGINS: env.CORS_ORIGINS,
    MAX_UPLOAD_MB: env.MAX_UPLOAD_MB,
    TRUST_PROXY: env.TRUST_PROXY,
    LOG_LEVEL: env.LOG_LEVEL,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const name = issue.path.length > 0 ? String(issue.path[0]) : 'environment';
      return `${name}: ${issue.message}`;
    });
    throw new ConfigError(issues);
  }
  const e = parsed.data;
  if (e.HOST === '') throw new ConfigError(['HOST: must not be empty']);
  return {
    port: e.PORT,
    host: e.HOST,
    dataDir: path.resolve(cwd, e.DATA_DIR),
    adminToken: e.ADMIN_TOKEN,
    corsOrigins: e.CORS_ORIGINS,
    maxUploadMb: e.MAX_UPLOAD_MB,
    bodyLimit: Math.floor(e.MAX_UPLOAD_MB * 1024 * 1024),
    trustProxy: e.TRUST_PROXY,
    logLevel: e.LOG_LEVEL,
  };
}
