/**
 * Serves the built app and proxies the model, on one origin.
 *
 * Same-origin matters for more than tidiness. The page sets COEP
 * `require-corp` so the in-browser WebGPU path can allocate a
 * SharedArrayBuffer, and a cross-origin call to the model would then need CORS
 * negotiated on top of mixed-content rules. Proxying /ollama on this origin
 * removes both problems: the browser sees one server.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';

const ROOT = resolve('/app/public');
const PORT = Number(process.env.PORT ?? 7860);
const OLLAMA = { host: '127.0.0.1', port: 11434 };

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
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Cross-origin isolation, so the WebGPU fallback keeps working. */
const ISOLATION = {
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'cross-origin',
};

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = decodeURIComponent(url.pathname);

  // ── the model ─────────────────────────────────────────────────────────────
  if (path === '/ollama' || path.startsWith('/ollama/')) {
    const upstream = path.slice('/ollama'.length) || '/';

    // Strip the browser's Origin and Referer before forwarding.
    //
    // Ollama enforces its own origin allowlist and answers 403 to anything
    // that is not localhost. Passing the page's Origin through made every
    // request from the deployed Space fail with
    // "Ollama could not load granite4:micro: 403", while curl worked, because
    // curl sends no Origin. THIS server is the client here, not the browser,
    // and a server-side proxy has no business claiming a browser origin.
    const headers = { ...req.headers, host: `${OLLAMA.host}:${OLLAMA.port}` };
    delete headers.origin;
    delete headers.referer;

    const proxied = httpRequest(
      { ...OLLAMA, path: upstream + url.search, method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, { ...up.headers, ...ISOLATION });
        up.pipe(res);
      },
    );
    proxied.on('error', (e) => {
      // Answer in the shape the adapter expects, so the app can say the model
      // is unavailable rather than hanging on a socket that will never open.
      res.writeHead(503, { 'content-type': 'application/json', ...ISOLATION });
      res.end(JSON.stringify({ error: `model backend unavailable: ${e.message}` }));
    });
    req.pipe(proxied);
    return;
  }

  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok\n');
    return;
  }

  // ── the app ───────────────────────────────────────────────────────────────
  const candidate = resolve(join(ROOT, normalize(path)));
  if (!candidate.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  let file = candidate;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    const index = join(file, 'index.html');
    // adapter-static writes one fallback page for every unknown route.
    file = existsSync(index) ? index : join(ROOT, 'index.html');
  }
  if (!existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }

  const stat = statSync(file);
  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  const immutable = path.startsWith('/_app/immutable/');

  // Range support: the routing graph is 36 MB and the browser asks for it in
  // pieces.
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : stat.size - 1;
      if (start < stat.size && end < stat.size && start <= end) {
        res.writeHead(206, {
          'content-type': type,
          'content-length': end - start + 1,
          'content-range': `bytes ${start}-${end}/${stat.size}`,
          'accept-ranges': 'bytes',
          ...ISOLATION,
        });
        createReadStream(file, { start, end }).pipe(res);
        return;
      }
    }
  }

  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'accept-ranges': 'bytes',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
    ...ISOLATION,
  });
  createReadStream(file).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`DesirePath serving ${ROOT} on :${PORT}, model proxied at /ollama`);
});
