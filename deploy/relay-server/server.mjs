import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { createStorage } from './storage.mjs';

const port = integerEnv('ASTERGATE_RELAY_PORT', 8790);
const assetsDirectory = requiredEnv('ASTERGATE_ASSETS_DIR');
const gatewayDirectory = process.env.ASTERGATE_GATEWAY_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), 'gateway');
const publicUrl = new URL(requiredEnv('ASTERGATE_PUBLIC_URL'));
const allowedOrigin = publicUrl.origin;
const { store, sessions, backend: storageBackend } = await createStorage();
const agents = new Map();
const agentStates = new Map();
const browsers = new Map();
const loginAttempts = new Map();
const registrationAttempts = new Map();
const pairingAttempts = new Map();
const claimAttempts = new Map();
const registrationOpen = (process.env.ASTERGATE_REGISTRATION_MODE || 'open').trim().toLowerCase() !== 'closed';
const MAX_RELAY_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_RELAY_CHUNKS = 256;
const CHUNK_TIMEOUT_MS = 30_000;

const gatewayFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/gateway.js', ['gateway.js', 'text/javascript; charset=utf-8']],
  ['/qr-decoder.js', ['qr-decoder.js', 'text/javascript; charset=utf-8']],
  ['/gateway.css', ['gateway.css', 'text/css; charset=utf-8']],
  ['/gpttool-logo.png', ['gpttool-logo.png', 'image/png']],
  ['/apple-touch-icon.png', ['apple-touch-icon.png', 'image/png']],
]);
const remoteFiles = new Map([
  ['', ['index.html', 'text/html; charset=utf-8']],
  ['remote.js', ['remote.js', 'text/javascript; charset=utf-8']],
  ['remote.css', ['remote.css', 'text/css; charset=utf-8']],
  ['web-version.json', ['web-version.json', 'application/json; charset=utf-8']],
  ['gpttool-logo.png', ['gpttool-logo.png', 'image/png']],
  ['apple-touch-icon.png', ['apple-touch-icon.png', 'image/png']],
]);

const server = createServer((request, response) => void handleHttp(request, response));
const agentServer = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
const browserServer = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

server.on('upgrade', (request, socket, head) => void handleUpgrade(request, socket, head).catch((error) => {
  console.warn(`Upgrade authorization failed: ${error.message}`);
  if (!socket.destroyed) rejectUpgrade(socket, 503);
}));

async function handleUpgrade(request, socket, head) {
  const requestUrl = new URL(request.url || '/', 'http://localhost');
  if (requestUrl.pathname === '/agent') {
    const deviceId = String(request.headers['x-gpttool-device-id'] || request.headers['x-astergate-device-id'] || '');
    const secret = bearerToken(request);
    if (!secret || !await store.verifyDevice(deviceId, secret)) return rejectUpgrade(socket, 401);
    request.asterGateDeviceId = deviceId;
    agentServer.handleUpgrade(request, socket, head, (client) => agentServer.emit('connection', client, request));
    return;
  }
  const match = requestUrl.pathname.match(/^\/device\/([^/]+)\/ws$/);
  if (match) {
    const session = await authenticatedSession(request);
    const deviceId = decodeURIComponent(match[1]);
    if (!session || request.headers.origin !== allowedOrigin || !await store.userOwnsDevice(session.userId, deviceId)) return rejectUpgrade(socket, 401);
    if (agents.get(deviceId)?.readyState !== WebSocket.OPEN) return rejectUpgrade(socket, 503);
    request.asterGateDeviceId = deviceId;
    browserServer.handleUpgrade(request, socket, head, (client) => browserServer.emit('connection', client, request));
    return;
  }
  rejectUpgrade(socket, 404);
}

agentServer.on('connection', (client, request) => {
  const deviceId = request.asterGateDeviceId;
  const previous = agents.get(deviceId);
  if (previous?.readyState === WebSocket.OPEN) {
    for (const [connectionId, entry] of browsers) {
      if (entry.deviceId !== deviceId) continue;
      clearChunkAssemblies(entry); entry.socket.close(1012, 'Device reconnected'); browsers.delete(connectionId);
    }
    previous.close(4009, '同一设备已在另一个 GPTTool 实例中连接');
  }
  agents.set(deviceId, client);
  agentStates.set(deviceId, { serviceState: 'standby', message: 'GPTTool 后台在线，可远程启动' });
  send(client, { type: 'relay.ready', publicUrl: new URL(`device/${encodeURIComponent(deviceId)}/`, publicUrl).href });
  void store.listDeviceRecords?.(deviceId, ['turn-queue', 'preferences', 'usage-snapshot']).then((records) => {
    if (client.readyState !== WebSocket.OPEN) return;
    const message = JSON.stringify({ type: 'device.state.snapshot', records });
    if (Buffer.byteLength(message, 'utf8') <= 384 * 1024) client.send(message);
    else console.warn(`Persistent state for ${deviceId} exceeds relay snapshot limit`);
  }).catch((error) => console.warn(`Failed to restore ${deviceId} state: ${error.message}`));
  client.on('message', (raw) => void handleAgentMessage(deviceId, raw.toString()));
  client.on('error', (error) => console.warn(`Device ${deviceId} WebSocket error: ${error.message}`));
  client.on('close', (code, reason) => {
    console.log(`Device ${deviceId} disconnected (${code}${reason.length ? `: ${reason.toString()}` : ''})`);
    if (agents.get(deviceId) !== client) return;
    agents.delete(deviceId);
    agentStates.delete(deviceId);
    for (const [connectionId, entry] of browsers) {
      if (entry.deviceId !== deviceId) continue;
      clearChunkAssemblies(entry);
      entry.socket.close(1012, 'Device disconnected');
      browsers.delete(connectionId);
    }
  });
});

browserServer.on('connection', (client, request) => {
  const deviceId = request.asterGateDeviceId;
  const connectionId = randomUUID();
  browsers.set(connectionId, { deviceId, socket: client, chunks: new Map() });
  send(agents.get(deviceId), { type: 'browser.open', connectionId });
  client.on('message', (raw) => send(agents.get(deviceId), { type: 'browser.message', connectionId, data: raw.toString() }));
  client.on('error', (error) => console.warn(`Browser ${connectionId} WebSocket error: ${error.message}`));
  client.on('close', (code, reason) => {
    console.log(`Browser ${connectionId} disconnected (${code}${reason.length ? `: ${reason.toString()}` : ''})`);
    const entry = browsers.get(connectionId);
    if (entry) clearChunkAssemblies(entry);
    browsers.delete(connectionId);
    send(agents.get(deviceId), { type: 'browser.close', connectionId });
  });
});

const heartbeat = setInterval(() => {
  for (const socket of [...agents.values(), ...[...browsers.values()].map((entry) => entry.socket)]) {
    if (socket.readyState === WebSocket.OPEN) socket.ping();
  }
}, 25_000);
heartbeat.unref();

server.listen(port, '127.0.0.1', () => console.log(`GPTTool multi-tenant relay listening on 127.0.0.1:${port} (${storageBackend})`));

async function handleHttp(request, response) {
  securityHeaders(response);
  const requestUrl = new URL(request.url || '/', 'http://localhost');
  if (requestUrl.pathname === '/healthz') return json(response, 200, {
    ok: true,
    storage: storageBackend,
    onlineDevices: agents.size,
    activeBrowsers: browsers.size,
  });
  if (requestUrl.pathname.startsWith('/api/')) return handleApi(request, response, requestUrl);

  const deviceMatch = requestUrl.pathname.match(/^\/device\/([^/]+)\/(.*)$/);
  if (deviceMatch) {
    const session = await authenticatedSession(request);
    const deviceId = decodeURIComponent(deviceMatch[1]);
    if (!session) return redirect(response, publicUrl.pathname);
    if (!await store.userOwnsDevice(session.userId, deviceId)) return textResponse(response, 403, 'Device access denied');
    const entry = remoteFiles.get(deviceMatch[2]);
    if (!entry) return textResponse(response, 404, 'Not found');
    return streamFile(response, path.join(assetsDirectory, entry[0]), entry[1]);
  }

  const gateway = gatewayFiles.get(requestUrl.pathname);
  if (gateway) return streamFile(response, path.join(gatewayDirectory, gateway[0]), gateway[1]);
  return textResponse(response, 404, 'Not found');
}

async function handleApi(request, response, requestUrl) {
  if (request.method === 'GET' && requestUrl.pathname === '/api/session') {
    const session = await authenticatedSession(request);
    return json(response, 200, session
      ? { authenticated: true, user: await store.userById(session.userId), registrationOpen }
      : { authenticated: false, registrationOpen });
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/pair/start') {
    if (!consumeRateLimit(pairingAttempts, clientAddress(request), 20, 60 * 60_000)) return json(response, 429, { error: '配对请求过于频繁' });
    const body = await readJson(request, response); if (!body) return;
    try { return json(response, 200, await store.createPairing({ deviceId: body.deviceId, name: body.name, secret: body.secret })); }
    catch (error) { return json(response, 400, { error: error.message }); }
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/login') {
    if (!validOrigin(request)) return json(response, 403, { error: '请求来源无效' });
    const address = clientAddress(request);
    if (!consumeRateLimit(loginAttempts, address, 10, 15 * 60_000)) return json(response, 429, { error: '登录失败次数过多，请稍后再试' });
    const body = await readJson(request, response); if (!body) return;
    let user;
    try { user = await store.authenticate(body.username, body.password); } catch { user = undefined; }
    if (!user) return json(response, 401, { error: '账号或密码错误' });
    loginAttempts.delete(address);
    return issueSession(response, user);
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/register') {
    if (!validOrigin(request)) return json(response, 403, { error: '请求来源无效' });
    if (!registrationOpen) return json(response, 403, { error: '暂未开放新账号注册' });
    const address = clientAddress(request);
    if (!consumeRateLimit(registrationAttempts, address, 5, 60 * 60_000)) return json(response, 429, { error: '注册操作过于频繁，请稍后再试' });
    const body = await readJson(request, response); if (!body) return;
    if (body.website) return json(response, 400, { error: '注册失败，请刷新页面后重试' });
    if (body.password !== body.confirmPassword) return json(response, 400, { error: '两次输入的密码不一致' });
    try {
      const user = await store.createUser(body.username, body.password);
      registrationAttempts.delete(address);
      return issueSession(response, user, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : '注册失败';
      return json(response, /已存在/.test(message) ? 409 : 400, { error: message });
    }
  }
  const session = await authenticatedSession(request);
  if (!session) return json(response, 401, { error: '请先登录' });
  if (request.method !== 'GET' && !validOrigin(request)) return json(response, 403, { error: '请求来源无效' });

  if (request.method === 'POST' && requestUrl.pathname === '/api/logout') {
    const token = cookieValue(request, 'astergate_sid'); if (token) await sessions.delete(hashToken(token));
    response.setHeader('Set-Cookie', `astergate_sid=; HttpOnly; Secure; SameSite=Strict; Path=${publicUrl.pathname}; Max-Age=0`);
    return json(response, 200, { ok: true });
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/devices') {
    const devices = await store.listDevices(session.userId, new Set(agents.keys()));
    return json(response, 200, { devices: devices.map((device) => ({ ...device, ...(agentStates.get(device.id) || { serviceState: 'offline' }) })) });
  }
  const startMatch = requestUrl.pathname.match(/^\/api\/devices\/([^/]+)\/start$/);
  if (request.method === 'POST' && startMatch) {
    const deviceId = decodeURIComponent(startMatch[1]);
    if (!await store.userOwnsDevice(session.userId, deviceId)) return json(response, 404, { error: '设备不存在' });
    const agent = agents.get(deviceId);
    if (agent?.readyState !== WebSocket.OPEN) return json(response, 409, { error: '电脑当前离线，无法远程启动' });
    const current = agentStates.get(deviceId);
    if (current?.serviceState === 'running') return json(response, 200, { ok: true, serviceState: 'running' });
    agentStates.set(deviceId, { serviceState: 'starting', message: '正在远程启动 Codex 控制…' });
    send(agent, { type: 'device.command', command: 'start', requestId: randomUUID() });
    return json(response, 202, { ok: true, serviceState: 'starting' });
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/pair/claim') {
    if (!consumeRateLimit(claimAttempts, `${session.userId}:${clientAddress(request)}`, 20, 15 * 60_000)) return json(response, 429, { error: '配对二维码尝试次数过多，请稍后再试' });
    const body = await readJson(request, response); if (!body) return;
    try { return json(response, 200, { device: await store.claimPairing(session.userId, body.code) }); }
    catch (error) { return json(response, 400, { error: error.message }); }
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/password') {
    const body = await readJson(request, response); if (!body) return;
    try { await store.changePassword(session.userId, body.currentPassword, body.nextPassword); return json(response, 200, { ok: true }); }
    catch (error) { return json(response, 400, { error: error.message }); }
  }
  const revokeMatch = requestUrl.pathname.match(/^\/api\/devices\/([^/]+)$/);
  if (request.method === 'DELETE' && revokeMatch) {
    const deviceId = decodeURIComponent(revokeMatch[1]);
    try {
      await store.revokeDevice(session.userId, deviceId);
      agents.get(deviceId)?.close(1008, 'Device revoked');
      return json(response, 200, { ok: true });
    } catch (error) { return json(response, 404, { error: error.message }); }
  }
  return json(response, 404, { error: 'Not found' });
}

async function handleAgentMessage(deviceId, raw) {
  let message;
  try { message = JSON.parse(raw); } catch { return; }
  if (message.type === 'device.status' || message.type === 'device.command.result') {
    agentStates.set(deviceId, {
      serviceState: ['standby', 'starting', 'running', 'failed'].includes(message.serviceState) ? message.serviceState : 'standby',
      message: typeof message.message === 'string' ? message.message.slice(0, 300) : '',
    });
    return;
  }
  if (message.type === 'device.state.put') {
    try {
      await store.putDeviceRecord?.(deviceId, message.kind, message.key, message.value, message.updatedAt);
    } catch (error) {
      console.warn(`Failed to persist ${deviceId} state: ${error.message}`);
    }
    return;
  }
  if (message.type === 'device.state.delete') {
    try {
      await store.deleteDeviceRecord?.(deviceId, message.kind, message.key);
    } catch (error) {
      console.warn(`Failed to delete ${deviceId} state: ${error.message}`);
    }
    return;
  }
  if (!message.connectionId) return;
  const entry = browsers.get(message.connectionId);
  if (!entry || entry.deviceId !== deviceId) return;
  if (message.type === 'browser.message' && typeof message.data === 'string') entry.socket.send(message.data);
  else if (message.type === 'browser.message.chunk') handleBrowserMessageChunk(entry, message);
  else if (message.type === 'browser.close' || message.type === 'browser.error') entry.socket.close(1011, message.message || 'Device connection closed');
}

function handleBrowserMessageChunk(entry, message) {
  const messageId = typeof message.messageId === 'string' ? message.messageId : '';
  const index = Number(message.index); const total = Number(message.total);
  if (!messageId || !Number.isInteger(index) || !Number.isInteger(total) || index < 0 || index >= total || total < 1 || total > MAX_RELAY_CHUNKS || typeof message.data !== 'string') {
    entry.socket.close(1008, 'Invalid relay chunk'); return;
  }
  let assembly = entry.chunks.get(messageId);
  if (!assembly) {
    const timer = setTimeout(() => {
      if (entry.chunks.get(messageId) !== assembly) return;
      entry.chunks.delete(messageId); entry.socket.close(1011, 'Relay chunk timeout');
    }, CHUNK_TIMEOUT_MS);
    timer.unref();
    assembly = { total, chunks: new Array(total), received: 0, bytes: 0, timer };
    entry.chunks.set(messageId, assembly);
  }
  if (assembly.total !== total) { entry.socket.close(1008, 'Relay chunk mismatch'); return; }
  if (assembly.chunks[index]) return;
  const chunk = Buffer.from(message.data, 'base64');
  assembly.chunks[index] = chunk; assembly.received += 1; assembly.bytes += chunk.byteLength;
  if (assembly.bytes > MAX_RELAY_MESSAGE_BYTES) {
    clearTimeout(assembly.timer); entry.chunks.delete(messageId); entry.socket.close(1009, 'Relay message too large'); return;
  }
  if (assembly.received !== assembly.total) return;
  clearTimeout(assembly.timer); entry.chunks.delete(messageId);
  if (entry.socket.readyState === WebSocket.OPEN) entry.socket.send(Buffer.concat(assembly.chunks, assembly.bytes).toString('utf8'));
}

function clearChunkAssemblies(entry) {
  for (const assembly of entry.chunks.values()) clearTimeout(assembly.timer);
  entry.chunks.clear();
}

async function authenticatedSession(request) {
  const token = cookieValue(request, 'astergate_sid');
  if (!token) return undefined;
  const key = hashToken(token);
  const session = await sessions.get(key);
  if (!session || session.expiresAt <= Date.now()) { await sessions.delete(key); return undefined; }
  return session;
}

async function readJson(request, response) {
  const chunks = []; let size = 0;
  try {
    for await (const chunk of request) { size += chunk.length; if (size > 64 * 1024) throw new Error('请求过大'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) { json(response, 400, { error: error.message || '无效请求' }); return undefined; }
}

function validOrigin(request) { return request.headers.origin === allowedOrigin; }
function bearerToken(request) { const value = request.headers.authorization || ''; return value.startsWith('Bearer ') ? value.slice(7) : ''; }
function cookieValue(request, name) { const prefix = `${name}=`; return request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length); }
function hashToken(value) { return createHash('sha256').update(value).digest('base64url'); }
function clientAddress(request) { return String(request.headers['x-real-ip'] || request.socket.remoteAddress || 'unknown'); }
function consumeRateLimit(map, key, limit, windowMs) { const now = Date.now(); const values = (map.get(key) || []).filter((time) => time > now - windowMs); values.push(now); map.set(key, values); return values.length <= limit; }
async function issueSession(response, user, status = 200) {
  const token = randomBytes(32).toString('base64url');
  await sessions.set(hashToken(token), { userId: user.id, expiresAt: Date.now() + 7 * 24 * 60 * 60_000 });
  response.setHeader('Set-Cookie', `astergate_sid=${token}; HttpOnly; Secure; SameSite=Strict; Path=${publicUrl.pathname}; Max-Age=604800`);
  return json(response, status, { user });
}
function send(socket, value) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); }
function rejectUpgrade(socket, status) { socket.write(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`); socket.destroy(); }
function redirect(response, location) { response.statusCode = 302; response.setHeader('Location', location); response.end(); }
function json(response, status, value) { response.statusCode = status; response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(JSON.stringify(value)); }
function textResponse(response, status, value) { response.statusCode = status; response.setHeader('Content-Type', 'text/plain; charset=utf-8'); response.end(value); }
function streamFile(response, file, contentType) { if (!existsSync(file)) return textResponse(response, 500, 'Assets unavailable'); response.setHeader('Content-Type', contentType); createReadStream(file).pipe(response); }
function requiredEnv(name) { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function integerEnv(name, fallback) { const value = Number(process.env[name] || fallback); if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} is invalid`); return value; }
function securityHeaders(response) {
  response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self'; script-src 'self'; img-src 'self' data: blob:");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
}
