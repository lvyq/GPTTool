import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { RemoteRelayClient } from '../src/remote/remote-relay-client.ts';

test('isolates a public browser by account and relays it to the selected device', async (context) => {
  let browser: WebSocket | undefined;
  let client: RemoteRelayClient | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  const relayPort = await freePort(); const localPort = await freePort();
  const stateDirectory = await mkdtemp(path.join(tmpdir(), 'astergate-multitenant-'));
  const database = path.join(stateDirectory, 'state.json'); const deviceId = randomUUID();
  const deviceToken = 'device-token-0123456789-0123456789'; const localToken = 'local-token-0123456789-0123456789'; const password = 'owner-password-2026';
  const admin = (args: string[]) => execFileSync(process.execPath, ['deploy/relay-server/admin.mjs', ...args], { env: { ...process.env, ASTERGATE_DATABASE: database } }).toString();
  const user = JSON.parse(admin(['create-user', 'owner', password])) as { id: string };
  admin(['import-device', user.id, deviceId, 'Test Mac', deviceToken]);
  admin(['create-user', 'another-user', 'another-password-2026']);

  const localServer = new WebSocketServer({ port: localPort });
  localServer.on('connection', (socket, request) => {
    assert.equal(request.headers.cookie, `astergate_session=${localToken}`);
    socket.on('message', (data) => {
      const value = data.toString();
      socket.send(value === 'large relay response' ? JSON.stringify({ value: '中'.repeat(1_200_000) }) : JSON.stringify({ echoed: value }));
    });
  });
  context.after(async () => {
    browser?.terminate(); await client?.stop(); for (const socket of localServer.clients) socket.terminate();
    await new Promise<void>((resolve) => localServer.close(() => resolve())); child?.kill('SIGTERM');
    await rm(stateDirectory, { recursive: true, force: true });
  });

  child = spawn(process.execPath, ['deploy/relay-server/server.mjs'], {
    cwd: path.resolve('.'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ASTERGATE_RELAY_PORT: String(relayPort), ASTERGATE_ASSETS_DIR: path.resolve('src/remote-ui'), ASTERGATE_GATEWAY_DIR: path.resolve('deploy/relay-server/gateway'), ASTERGATE_PUBLIC_URL: `http://127.0.0.1:${relayPort}/`, ASTERGATE_DATABASE: database },
  });
  await waitForOnlineDevices(relayPort, 0);

  let publicUrl = '';
  let remoteStarts = 0;
  client = new RemoteRelayClient({
    relayUrl: `ws://127.0.0.1:${relayPort}/agent`, deviceToken, deviceId, localPort, localToken, reconnectDelayMs: 20,
    onPublicUrl: (value) => { publicUrl = value; },
    onCommand: async (command) => { assert.equal(command, 'start'); remoteStarts += 1; },
  });
  client.start(); await waitForOnlineDevices(relayPort, 1); await waitUntil(() => Boolean(publicUrl));
  assert.match(publicUrl, new RegExp(`/device/${deviceId}/$`));

  const ownerCookie = await login(relayPort, 'owner', password);
  const devices = await fetch(`http://127.0.0.1:${relayPort}/api/devices`, { headers: { Cookie: ownerCookie } });
  assert.deepEqual((await devices.json() as { devices: Array<{ id: string; online: boolean }> }).devices.map(({ id, online }) => ({ id, online })), [{ id: deviceId, online: true }]);

  const start = await fetch(`http://127.0.0.1:${relayPort}/api/devices/${deviceId}/start`, {
    method: 'POST', headers: { Cookie: ownerCookie, Origin: `http://127.0.0.1:${relayPort}` },
  });
  assert.equal(start.status, 202);
  await waitUntil(() => remoteStarts === 1);
  await waitUntil(async () => {
    const response = await fetch(`http://127.0.0.1:${relayPort}/api/devices`, { headers: { Cookie: ownerCookie } });
    const body = await response.json() as { devices: Array<{ serviceState: string }> };
    return body.devices[0]?.serviceState === 'running';
  });

  const outsiderCookie = await login(relayPort, 'another-user', 'another-password-2026');
  const denied = await fetch(`http://127.0.0.1:${relayPort}/device/${deviceId}/`, { headers: { Cookie: outsiderCookie }, redirect: 'manual' });
  assert.equal(denied.status, 403);

  browser = new WebSocket(`ws://127.0.0.1:${relayPort}/device/${deviceId}/ws`, { headers: { Cookie: ownerCookie, Origin: `http://127.0.0.1:${relayPort}` } });
  await new Promise<void>((resolve, reject) => { browser!.once('open', resolve); browser!.once('error', reject); });
  browser.send('hello relay');
  const response = await new Promise<string>((resolve, reject) => { browser!.once('message', (data) => resolve(data.toString())); browser!.once('error', reject); });
  assert.deepEqual(JSON.parse(response), { echoed: 'hello relay' });

  browser.send('large relay response');
  const largeResponse = await new Promise<string>((resolve, reject) => { browser!.once('message', (data) => resolve(data.toString())); browser!.once('error', reject); });
  assert.equal((JSON.parse(largeResponse) as { value: string }).value.length, 1_200_000);
  assert.equal(browser.readyState, WebSocket.OPEN);
  await waitForOnlineDevices(relayPort, 1);

  browser.send('after large response');
  const followUp = await new Promise<string>((resolve, reject) => { browser!.once('message', (data) => resolve(data.toString())); browser!.once('error', reject); });
  assert.deepEqual(JSON.parse(followUp), { echoed: 'after large response' });
});

test('supports self-service registration, automatic login, validation and account isolation', async (context) => {
  let child: ReturnType<typeof spawn> | undefined;
  const relayPort = await freePort();
  const stateDirectory = await mkdtemp(path.join(tmpdir(), 'astergate-registration-'));
  const database = path.join(stateDirectory, 'state.json');
  context.after(async () => {
    child?.kill('SIGTERM');
    await rm(stateDirectory, { recursive: true, force: true });
  });

  child = spawn(process.execPath, ['deploy/relay-server/server.mjs'], {
    cwd: path.resolve('.'), stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ASTERGATE_RELAY_PORT: String(relayPort),
      ASTERGATE_ASSETS_DIR: path.resolve('src/remote-ui'),
      ASTERGATE_GATEWAY_DIR: path.resolve('deploy/relay-server/gateway'),
      ASTERGATE_PUBLIC_URL: `http://127.0.0.1:${relayPort}/`,
      ASTERGATE_DATABASE: database,
    },
  });
  await waitForOnlineDevices(relayPort, 0);

  const sessionBefore = await fetch(`http://127.0.0.1:${relayPort}/api/session`);
  assert.deepEqual(await sessionBefore.json(), { authenticated: false, registrationOpen: true });

  const mismatch = await register(relayPort, 'new-owner', 'registration-password-2026', 'different-password-2026');
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json() as { error: string }).error, '两次输入的密码不一致');

  const registered = await register(relayPort, 'New-Owner', 'registration-password-2026');
  assert.equal(registered.status, 201);
  const cookie = registered.headers.get('set-cookie')!.split(';')[0]!;
  const registeredUser = (await registered.json() as { user: { id: string; username: string } }).user;
  assert.equal(registeredUser.username, 'new-owner');

  const authenticated = await fetch(`http://127.0.0.1:${relayPort}/api/session`, { headers: { Cookie: cookie } });
  assert.deepEqual(await authenticated.json(), {
    authenticated: true,
    registrationOpen: true,
    user: registeredUser,
  });

  const devices = await fetch(`http://127.0.0.1:${relayPort}/api/devices`, { headers: { Cookie: cookie } });
  assert.deepEqual(await devices.json(), { devices: [] });

  const duplicate = await register(relayPort, 'new-owner', 'another-registration-password');
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json() as { error: string }).error, '账号已存在');

  const gateway = await fetch(`http://127.0.0.1:${relayPort}/`);
  assert.match(await gateway.text(), /创建账号/);
});

async function login(port: number, username: string, password: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ username, password }) });
  assert.equal(response.status, 200); return response.headers.get('set-cookie')!.split(';')[0]!;
}
async function register(port: number, username: string, password: string, confirmPassword = password): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ username, password, confirmPassword, website: '' }),
  });
}
async function freePort(): Promise<number> { const server = createServer(); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0; await new Promise<void>((resolve) => server.close(() => resolve())); return port; }
async function waitForOnlineDevices(port: number, count: number): Promise<void> { await waitUntil(async () => { try { const response = await fetch(`http://127.0.0.1:${port}/healthz`); return ((await response.json()) as { onlineDevices: number }).onlineDevices === count; } catch { return false; } }); }
async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 25)); } throw new Error('Timed out waiting for relay state'); }
