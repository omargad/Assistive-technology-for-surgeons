/**
 * Server entry point: `npm start` (tsx) or `node dist/main.js` (bundled).
 *
 * 1. Install the warning filter, then load the app with a dynamic import, so
 *    the expected `node:sqlite` ExperimentalWarning is not printed.
 * 2. Load `.env` (if present) and validate the configuration; exit with a
 *    readable message if it is invalid (e.g. no ADMIN_TOKEN).
 * 3. Listen, and close gracefully on SIGINT/SIGTERM (plus Ctrl+Break and
 *    console close on Windows): stop accepting connections, finish in-flight
 *    requests, close the database. A second signal or a 10 s timeout forces
 *    the exit.
 */
import { ConfigError, loadConfig } from './config';
import type { Config } from './config';
import { loadDotEnv } from './env';
import { installWarningFilter } from './warnings';

const SHUTDOWN_TIMEOUT_MS = 10_000;

function shutdownSignals(): NodeJS.Signals[] {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  // Windows: Ctrl+Break sends SIGBREAK and closing the console window sends SIGHUP.
  if (process.platform === 'win32') signals.push('SIGBREAK', 'SIGHUP');
  return signals;
}

function readConfig(): Config | null {
  try {
    loadDotEnv();
    return loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n\nSet these environment variables or copy .env.example to .env.\n`);
      return null;
    }
    throw err;
  }
}

async function main(): Promise<void> {
  installWarningFilter();
  const config = readConfig();
  if (config === null) {
    process.exitCode = 1;
    return;
  }

  const { buildApp } = await import('./app');
  const app = buildApp(config);

  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) {
      app.log.warn({ signal }, 'second signal received; exiting immediately');
      process.exit(1);
    }
    closing = true;
    app.log.info({ signal }, 'shutting down');
    const timer = setTimeout(() => {
      app.log.error('graceful shutdown timed out; exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err: { message: err instanceof Error ? err.message : String(err) } }, 'error while closing');
        process.exit(1);
      },
    );
  };
  for (const signal of shutdownSignals()) process.on(signal, () => shutdown(signal));

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error({ err: { message: err instanceof Error ? err.message : String(err) } }, 'could not start server');
    await app.close().catch(() => undefined);
    process.exitCode = 1;
    return;
  }
  app.log.info(
    {
      dataDir: config.dataDir,
      corsOrigins: config.corsOrigins,
      maxUploadMb: config.maxUploadMb,
      trustProxy: config.trustProxy,
    },
    'SurgeonPulse ingest server ready',
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
