/**
 * Tiny dependency-free static server with a single-page-app fallback, for running e2e/web-flow.mjs
 * against an `expo export --platform web` build (web.output = "single") without downloading `serve`.
 *
 * Usage:
 *   node e2e/serve-spa.mjs <dir> [port=8090] [host=127.0.0.1]
 *
 * - Existing files under <dir> are served with a content type from their extension.
 * - Any other GET/HEAD path (an Expo Router route such as /record/live) gets <dir>/index.html.
 * - Paths are resolved inside <dir> only; anything that escapes it is refused (403).
 * Prints "Serving <dir> at http://host:port" once it is listening. Stop it with Ctrl+C / SIGTERM.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const [dirArg, portArg = '8090', host = '127.0.0.1'] = process.argv.slice(2);
if (!dirArg) {
  console.error('Usage: node e2e/serve-spa.mjs <dir> [port=8090] [host=127.0.0.1]');
  process.exit(2);
}
const root = resolve(dirArg);
const port = Number(portArg);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`Invalid port: ${portArg}`);
  process.exit(2);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

async function fileAt(path) {
  try {
    const info = await stat(path);
    return info.isFile() ? info : null;
  } catch {
    return null;
  }
}

function send(res, method, path, info, status = 200) {
  res.writeHead(status, {
    'Content-Type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': 'no-store',
  });
  if (method === 'HEAD') res.end();
  else createReadStream(path).pipe(res);
}

const server = createServer(async (req, res) => {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const target = resolve(join(root, pathname));
  if (target !== root && !target.startsWith(root + sep)) {
    res.writeHead(403).end();
    return;
  }
  const direct = await fileAt(target);
  if (direct) {
    send(res, method, target, direct);
    return;
  }
  const index = join(root, 'index.html');
  const fallback = await fileAt(index);
  if (!fallback) {
    res.writeHead(404).end();
    return;
  }
  send(res, method, index, fallback);
});

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`Serving ${root} at http://${host}:${actualPort}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
