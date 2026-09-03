import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Development-only reverse proxy. Production uses Nginx, not this process.
export function createFrontendServer({
  assetsDirectory = fileURLToPath(new URL('../dist/', import.meta.url)),
  backendUrl = 'http://127.0.0.1:8790',
  basePath = '/remote/',
} = {}) {
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(basePath)) throw new Error('Invalid frontend base path');
  const upstream = new URL(backendUrl);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.pathname !== '/') throw new Error('Backend URL must be a fixed HTTP origin');
  const requestUpstream = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
  const relativeUrl = (url) => url.startsWith(basePath) ? '/' + url.slice(basePath.length) : null;
  const isApi = (url) => /^\/(?:api(?:\/|\?)|healthz(?:\?|$))/.test(url);
  const isSocket = (url) => /^\/(?:agent|device\/[^/?]+\/ws)(?:\?|$)/.test(url);
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === basePath.slice(0, -1)) {
      res.writeHead(302, { Location: basePath }); res.end(); return;
    }
    const relative = relativeUrl(req.url || '/');
    if (relative && isApi(relative)) {
      // Preserve Origin and Cookie: never bypass the backend's CSRF or session checks.
      const remote = requestUpstream(upstream, { method: req.method, path: relative, headers: { ...req.headers, host: upstream.host } }, (response) => {
        res.writeHead(response.statusCode || 502, response.headers); response.pipe(res);
      });
      remote.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Backend unavailable'); });
      req.on('aborted', () => remote.destroy()); req.pipe(remote); return;
    }
    if (!relative || !['GET', 'HEAD'].includes(req.method || '')) { res.writeHead(404); res.end(); return; }
    const pathname = new URL(relative, 'http://localhost').pathname;
    if (pathname === '/admin' || /^\/device\/[^/]+$/.test(pathname)) {
      res.writeHead(302, { Location: basePath + pathname.slice(1) + '/' }); res.end(); return;
    }
    let directory = 'gateway'; let file = pathname.slice(1) || 'index.html';
    const device = pathname.match(/^\/device\/[^/]+\/(.*)$/);
    if (device) { directory = 'remote'; file = device[1] || 'index.html'; }
    else if (pathname.startsWith('/admin/')) { directory = 'admin'; file = pathname.slice(7) || 'index.html'; }
    const allow = {
      gateway: ['index.html', 'gateway.js', 'gateway.css', 'qr-decoder.js', 'gpttool-logo.png', 'apple-touch-icon.png'],
      remote: ['index.html', 'remote.js', 'remote.css', 'web-version.json', 'gpttool-logo.png', 'apple-touch-icon.png'],
      admin: ['index.html', 'admin.js', 'admin.css', 'rules.css'],
    };
    if (!allow[directory].includes(file)) { res.writeHead(404); res.end(); return; }
    const target = path.join(assetsDirectory, directory, file);
    try {
      const info = await stat(target);
      if (!info.isFile()) throw new Error('Not a file');
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)], 'Content-Length': info.size });
      if (req.method === 'HEAD') res.end();
      else createReadStream(target).on('error', () => res.destroy()).pipe(res);
    } catch { res.writeHead(404); res.end('Build frontend first'); }
  });
  server.on('upgrade', (req, socket, head) => {
    const relative = relativeUrl(req.url || '/');
    if (!relative || !isSocket(relative)) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    const remote = requestUpstream(upstream, { path: relative, headers: { ...req.headers, host: upstream.host } });
    remote.on('upgrade', (response, peer, peerHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (peerHead.length) socket.write(peerHead);
      if (head.length) peer.write(head);
      peer.on('error', () => socket.destroy()); socket.on('error', () => peer.destroy());
      peer.on('close', () => socket.destroy()); socket.on('close', () => peer.destroy());
      socket.pipe(peer).pipe(socket);
    });
    remote.on('response', (response) => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`); });
    remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy());
    remote.end();
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.FRONTEND_PORT || 5173);
  const basePath = process.env.FRONTEND_BASE_PATH || '/remote/';
  createFrontendServer({ backendUrl: process.env.FRONTEND_BACKEND_URL || 'http://127.0.0.1:8790', basePath })
    .listen(port, '127.0.0.1', () => console.log(`Frontend: http://localhost:${port}${basePath} (API proxied separately)`));
}
