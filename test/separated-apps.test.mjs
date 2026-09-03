import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { createFrontendServer } from '../frontend/scripts/dev.mjs';
import { RemoteRelayClient } from '../src/remote/remote-relay-client.ts';

test('independent frontend + API-only backend preserve login, ownership and bidirectional WebSocket routing', { timeout: 30_000 }, async (t) => {
  execFileSync(process.execPath, ['frontend/scripts/build.mjs']);
  execFileSync(process.execPath, ['backend/scripts/build.mjs']);
  const backendFiles = await readdir('backend/dist');
  assert.ok(backendFiles.includes('server.mjs'));
  assert.ok(!backendFiles.some((f) => ['frontend', 'gateway', 'admin', '.env', 'public', 'remote'].includes(f)));
  assert.deepEqual((await readdir('frontend/dist')).sort(), ['admin', 'gateway', 'remote']);
  assert.ok(!(await readdir('frontend/dist/gateway')).includes('qr-decoder-entry.js'));
  assert.match(await readFile('frontend/dist/gateway/qr-decoder.js', 'utf8'), /jsQR/);

  const data = await mkdtemp(path.join(tmpdir(), 'gpttool-separated-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise((r) => probe.close(r));
  const backendOrigin = `http://127.0.0.1:${port}`;
  const front = createFrontendServer({ backendUrl: backendOrigin, basePath: '/remote/' }).listen(0, '127.0.0.1');
  t.after(() => { front.closeAllConnections(); front.close(); });
  await once(front, 'listening');
  const origin = `http://127.0.0.1:${front.address().port}`;
  const env = { ...process.env, ASTERGATE_RELAY_PORT: String(port), ASTERGATE_PUBLIC_URL: `${origin}/remote/`, ASTERGATE_DATABASE: path.join(data, 'state.json'), ASTERGATE_SESSIONS: path.join(data, 'sessions.json'), ASTERGATE_REGISTRATION_MODE: 'open' };
  for (const key of Object.keys(env)) {
    if (/^ASTERGATE_(?:ASSETS|GATEWAY|ADMIN|POSTGRES|MYSQL|SERVE_FRONTEND)/.test(key)) delete env[key];
  }
  const admin = (...args) => JSON.parse(execFileSync(process.execPath, ['backend/dist/admin.mjs', ...args], { env }).toString());
  const owner = admin('create-user', 'owner', 'fixture-password-123');
  const deviceId = '11111111-2222-3333-4444-555555555555';
  admin('import-device', owner.id, deviceId, 'Fixture', 'fixture-device-secret-1234567890');
  const child = spawn(process.execPath, ['backend/dist/server.mjs'], { env, stdio: 'ignore' });
  let relay; let browser;
  const local = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(local, 'listening');
  local.on('connection', (socket) => socket.on('message', (data) => socket.send(JSON.stringify({ echoed: data.toString() }))));
  t.after(async () => {
    browser?.terminate(); await relay?.stop();
    for (const socket of local.clients) socket.terminate();
    await new Promise((r) => local.close(r));
    front.closeAllConnections(); await new Promise((r) => front.close(r));
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    await rm(data, { recursive: true, force: true });
  });
  await eventually(async () => (await fetch(`${backendOrigin}/healthz`)).ok);
  assert.equal((await fetch(`${backendOrigin}/`)).status, 404);
  assert.equal((await fetch(`${backendOrigin}/admin/`)).status, 404);
  for (const url of ['/', '/admin/', '/device/device-one/', '/qr-decoder.js']) {
    assert.equal((await fetch(`${origin}/remote${url}`)).status, 200, url);
  }
  assert.equal((await fetch(`${origin}/remote/.env`)).status, 404);
  assert.equal((await fetch(`${origin}/remote/admin/server.mjs`)).status, 404);
  assert.equal((await fetch(`${origin}/remote/api/devices`)).status, 401);
  const badOrigin = await fetch(`${origin}/remote/api/login`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'fixture-password-123' }) });
  assert.equal(badOrigin.status, 403);
  const loggedIn = await fetch(`${origin}/remote/api/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'fixture-password-123' }) });
  assert.equal(loggedIn.status, 200);
  const setCookie = loggedIn.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly; Secure; SameSite=Strict; Path=\/remote\//);
  const cookie = setCookie.split(';')[0];
  const session = await fetch(`${origin}/remote/api/session`, { headers: { Cookie: cookie } });
  assert.equal((await session.json()).authenticated, true);
  assert.equal((await fetch(`${origin}/remote/api/admin/users`, { headers: { Cookie: cookie } })).status, 403);
  relay = new RemoteRelayClient({ relayUrl: `${origin.replace('http:', 'ws:')}/remote/agent`, deviceId, deviceToken: 'fixture-device-secret-1234567890', localPort: local.address().port, localToken: 'fixture-local-token', reconnectDelayMs: 20 });
  relay.start();
  await eventually(async () => (await (await fetch(`${origin}/remote/healthz`)).json()).onlineDevices === 1);
  const socketUrl = `${origin.replace('http:', 'ws:')}/remote/device/${deviceId}/ws`;
  await rejectedSocket(socketUrl, { Origin: origin }, 401);
  await rejectedSocket(socketUrl, { Cookie: cookie, Origin: 'https://evil.example' }, 401);
  browser = new WebSocket(socketUrl, { headers: { Cookie: cookie, Origin: origin } }); await once(browser, 'open');
  const received = once(browser, 'message'); browser.send('one message via separated frontend');
  assert.deepEqual(JSON.parse((await received)[0].toString()), { echoed: 'one message via separated frontend' });
});

async function eventually(check) {
  for (let i = 0; i < 100; i++) { try { if (await check()) return; } catch {} await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('Service did not become ready');
}
function rejectedSocket(url, headers, status) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.on('error', () => {});
    socket.on('open', () => { socket.terminate(); reject(new Error('Unauthorized connection accepted')); });
    socket.on('unexpected-response', (_, response) => { response.resume(); socket.terminate(); try { assert.equal(response.statusCode, status); resolve(); } catch (error) { reject(error); } });
  });
}
