/**
 * Production build: `npm run build` → `dist/main.js` and `dist/backup.js`.
 *
 * esbuild bundles the server, `@surgeonpulse/core`, Fastify and zod into
 * self-contained ES modules, so the container (or any machine with Node 22)
 * runs `node dist/main.js` without `node_modules` or a TypeScript toolchain.
 * Code splitting keeps `node:sqlite` behind main.ts's dynamic import, so the
 * warning filter is installed before SQLite loads.
 *
 * Written with esbuild's JS API (not a shell command line) so it behaves the
 * same under sh, cmd.exe and PowerShell.
 */
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'dist');

rmSync(outdir, { recursive: true, force: true });

await build({
  absWorkingDir: root,
  entryPoints: ['src/main.ts', 'src/backup.ts'],
  outdir,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  legalComments: 'none',
  logLevel: 'warning',
  // Bundled CommonJS dependencies (Fastify) call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __spCreateRequire } from 'node:module'; const require = __spCreateRequire(import.meta.url);",
  },
});

process.stdout.write(`Built ${path.relative(process.cwd(), outdir) || outdir}${path.sep}main.js\n`);
