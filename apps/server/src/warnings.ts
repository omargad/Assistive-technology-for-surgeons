/**
 * Process warning filter.
 *
 * `node:sqlite` is built into Node 22 but still flagged experimental, so Node
 * prints an `ExperimentalWarning` the first time it is loaded. That single
 * warning is expected and only alarms operators; every other warning is still
 * printed in Node's usual format. Install the filter **before** anything
 * imports `node:sqlite` (main.ts loads the app with a dynamic import for this
 * reason).
 */

function isSqliteExperimentalWarning(warning: Error): boolean {
  return warning.name === 'ExperimentalWarning' && /\bSQLite\b/i.test(warning.message);
}

function warningsDisabled(): boolean {
  const flags = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? '').split(/\s+/)];
  return flags.includes('--no-warnings');
}

let installed = false;

/** Replace Node's default warning printer with one that drops only the node:sqlite ExperimentalWarning. */
export function installWarningFilter(): void {
  if (installed) return;
  installed = true;
  process.removeAllListeners('warning');
  if (warningsDisabled()) return;
  process.on('warning', (warning) => {
    if (isSqliteExperimentalWarning(warning)) return;
    process.stderr.write(`(node:${process.pid}) ${warning.name}: ${warning.message}\n`);
  });
}
