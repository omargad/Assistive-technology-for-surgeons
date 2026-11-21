/**
 * `buildApp(config, options)` assembles the Fastify application. It is the
 * entry point for tests (`app.inject()`) and for `main.ts`.
 *
 * Privacy defaults: request bodies are never logged (Fastify does not log
 * them and no hook here does), Authorization/Cookie headers are redacted from
 * any log line that might include them, and errors are returned in a uniform
 * shape without echoing request content.
 */
import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { createAuth } from './auth';
import type { Config } from './config';
import type { AppContext } from './context';
import { databasePath, ensureDataDir, openDatabase } from './db';
import type { Database, DataDirStatus } from './db';
import { registerErrorHandling, registerJsonParser, registerSecurityHeaders } from './http';
import { DEFAULT_RATE_LIMITS, TokenBucketLimiter } from './rateLimit';
import type { RateLimitRules } from './rateLimit';
import { createRepo } from './repo';
import { recomputeStaleSummaries } from './services/recompute';
import { adminRoutes } from './routes/admin';
import { exportRoutes } from './routes/export';
import { healthRoutes } from './routes/health';
import { meRoutes } from './routes/me';
import { sessionRoutes } from './routes/sessions';
import { uploadRoutes } from './routes/upload';

export const API_PREFIX = '/api/v1';

export interface BuildAppOptions {
  /** Use this database instead of opening `<DATA_DIR>/surgeonpulse.sqlite`. The caller then owns (closes) it. */
  db?: Database;
  /** Clock (epoch ms); defaults to `Date.now`. */
  now?: () => number;
  /** Override rate-limit rules (defaults: uploads 30/min, auth failures 10/min). */
  rateLimits?: Partial<RateLimitRules>;
  /** Write log lines here instead of stdout (used by tests to inspect logs). */
  logStream?: { write(line: string): void };
}

/** Header paths that must never appear in logs. */
export const REDACTED_LOG_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'res.headers["set-cookie"]',
];

/**
 * Fastify `trustProxy` for a {@link Config.trustProxy} value. `true` trusts only the directly connected
 * reverse proxy (hop 0), so the client IP is the right-most `X-Forwarded-For` entry, the one that proxy
 * appended. Trusting every hop (Fastify's own `true`) would let a client choose its rate-limit bucket by
 * sending its own `X-Forwarded-For`, so it is never used.
 */
export function fastifyTrustProxy(trustProxy: Config['trustProxy']): FastifyServerOptions['trustProxy'] {
  if (trustProxy === false) return false;
  if (trustProxy === true) return (_address: string, hop: number) => hop === 0;
  return [...trustProxy];
}

function loggerOptions(config: Config, stream: BuildAppOptions['logStream']): FastifyServerOptions['logger'] {
  if (config.logLevel === 'silent' && stream === undefined) return false;
  return {
    level: config.logLevel,
    redact: { paths: REDACTED_LOG_PATHS, censor: '[redacted]' },
    ...(stream !== undefined ? { stream } : {}),
  };
}

/** Build the application. Plugins load on `ready()`/`listen()`/`inject()`. */
export function buildApp(config: Config, options: BuildAppOptions = {}): FastifyInstance {
  const now = options.now ?? Date.now;
  let db = options.db;
  let dataDir: DataDirStatus | undefined;
  const ownsDb = db === undefined;
  if (db === undefined) {
    dataDir = ensureDataDir(config.dataDir);
    db = openDatabase(databasePath(config.dataDir));
  }
  const database = db;

  let app: FastifyInstance;
  try {
    app = Fastify({
      logger: loggerOptions(config, options.logStream),
      bodyLimit: config.bodyLimit,
      trustProxy: fastifyTrustProxy(config.trustProxy),
      // Bound slow clients; large uploads on hospital Wi-Fi still have two minutes.
      requestTimeout: 120_000,
    });
  } catch (err) {
    if (ownsDb) database.close();
    throw err;
  }

  const repo = createRepo(database);
  // Summaries computed by older analytics definitions are refreshed before anything is served (RV-13).
  const recomputed = recomputeStaleSummaries(repo, now());
  const limiter = new TokenBucketLimiter({ ...DEFAULT_RATE_LIMITS, ...options.rateLimits }, now);
  const ctx: AppContext = {
    config,
    repo,
    limiter,
    now,
    auth: createAuth({ adminToken: config.adminToken, repo, limiter, now }),
  };

  app.decorateRequest('auth', null);
  registerJsonParser(app);
  registerSecurityHeaders(app);
  registerErrorHandling(app);

  if (config.corsOrigins.length > 0) {
    // Only for browser clients (the dashboard, the app's web build). Native apps don't use CORS.
    void app.register(cors, {
      origin: config.corsOrigins,
      methods: ['GET', 'POST', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type', 'Accept'],
      // Let browser clients read download names and rate-limit back-off hints.
      exposedHeaders: ['Content-Disposition', 'Retry-After'],
      credentials: false,
      maxAge: 600,
    });
  }

  void app.register(healthRoutes(ctx));
  void app.register(uploadRoutes(ctx), { prefix: API_PREFIX });
  void app.register(meRoutes(ctx), { prefix: API_PREFIX });
  void app.register(sessionRoutes(ctx), { prefix: API_PREFIX });
  void app.register(exportRoutes(ctx), { prefix: API_PREFIX });
  void app.register(adminRoutes(ctx), { prefix: `${API_PREFIX}/admin` });

  app.addHook('onReady', async () => {
    if (recomputed.recomputed + recomputed.failed > 0) {
      app.log.info(recomputed, 'recomputed session summaries from an older analytics version');
    }
    if (dataDir?.created) app.log.info({ dataDir: config.dataDir }, 'created data directory (mode 0700)');
    if (dataDir?.insecure) {
      app.log.warn(
        { dataDir: config.dataDir },
        'data directory is accessible to other users; restrict it (chmod 700) because it holds research data',
      );
    }
  });

  if (ownsDb) {
    app.addHook('onClose', async () => {
      database.close();
    });
  }

  return app;
}
