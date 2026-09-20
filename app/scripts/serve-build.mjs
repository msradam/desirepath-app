/**
 * Serve app/build/ with the headers the app actually needs.
 *
 * `vite preview` previews Vite's own output directory, not the one
 * adapter-static writes, and it does not apply the COEP/COOP headers that
 * vite.config.ts sets for the dev server. Both matter here: WebLLM needs
 * SharedArrayBuffer, which needs cross-origin isolation, and the offline
 * check needs to serve exactly the artifact that would be deployed.
 *
 * Usage:
 *   node scripts/serve-build.mjs [port]
 *
 * With --offline it serves the first request for each asset and then refuses
 * every subsequent request, which is how the offline guarantee is tested: the
 * app must keep answering queries once its assets are in the browser.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../build', import.meta.url)));
const PORT = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 5181);
const OFFLINE_AFTER_FIRST = process.argv.includes('--offline');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

const served = new Set();
let refusing = false;
let restoreTimer = null;

/**
 * How long the network stays cut.
 *
 * It restores itself because a demo that crashes mid-offline otherwise leaves
 * the server refusing every request, and the next thing anyone tries looks
 * like the app is broken rather than like the switch is still flipped.
 */
const OFFLINE_SECONDS = 180;

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = decodeURIComponent(url.pathname);

  if (path === '/__offline') {
    // Flip to refusing everything. The page stays loaded; the network dies.
    refusing = true;
    clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => {
      refusing = false;
      console.log('  network restored automatically');
    }, OFFLINE_SECONDS * 1000);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(
      `offline. ${served.size} assets were served before the cut. ` +
        `Restores itself in ${OFFLINE_SECONDS}s, or GET /__online now.\n`,
    );
    return;
  }
  if (path === '/__online') {
    refusing = false;
    clearTimeout(restoreTimer);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('online\n');
    return;
  }

  if (refusing || (OFFLINE_AFTER_FIRST && served.has(path))) {
    // A dead network, not a 404: the app must treat this the way it would
    // treat a phone that has left coverage.
    res.destroy();
    return;
  }

  // Resolve inside the build directory, and nowhere else.
  const candidate = resolve(join(ROOT, normalize(path)));
  if (!candidate.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  let file = candidate;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    const index = join(file, 'index.html');
    // adapter-static writes a single fallback page for every unknown route.
    file = existsSync(index) ? index : join(ROOT, 'index.html');
  }
  if (!existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }

  served.add(path);
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'content-length': statSync(file).size,
    // WebLLM needs SharedArrayBuffer, which needs cross-origin isolation.
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
  });
  createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  console.log(`serving ${ROOT} on http://localhost:${PORT}`);
  console.log(`  GET /__offline to cut the network, /__online to restore it`);
});
