// Orbit Hill - servidor de archivos estaticos (sin dependencias externas).
// Solo sirve dentro de public/ y shared/, con proteccion contra path traversal.

import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export function createStaticHandler({ publicDir, sharedDir }) {
  const roots = [
    { prefix: '/shared/', dir: resolve(sharedDir) },
    { prefix: '/', dir: resolve(publicDir) },
  ];

  return function handleStatic(req, res) {
    let pathname;
    try {
      const url = new URL(req.url, 'http://localhost');
      pathname = decodeURIComponent(url.pathname);
      if (pathname.includes('\0')) throw new Error('Invalid path');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('400 Ruta inválida');
      return true;
    }
    if (pathname === '/') pathname = '/index.html';

    const root = roots.find((r) => r.prefix === '/' || pathname.startsWith(r.prefix));
    const relative = root.prefix === '/' ? pathname.slice(1) : pathname.slice(root.prefix.length);
    const full = resolve(join(root.dir, normalize(relative)));

    // Barandilla: nunca salir del directorio permitido.
    if (full !== root.dir && !full.startsWith(root.dir + sep)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('403 Prohibido');
      return true;
    }

    let stat;
    try {
      stat = statSync(full);
    } catch {
      return false;
    }
    if (stat.isDirectory()) return false;

    res.writeHead(200, {
      'content-type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(full).on('error', () => res.destroy()).pipe(res);
    return true;
  };
}
