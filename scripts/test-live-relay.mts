import { readFile } from 'node:fs/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { RemoteRelayClient } from '../src/remote/remote-relay-client.ts';

const environmentFile = process.argv[2];
if (!environmentFile) throw new Error('Usage: test-live-relay.mts /path/to/relay.env');
const environment = { ...process.env, ...Object.fromEntries(
  (await readFile(environmentFile, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }),
) };
const deviceToken = environment.ASTERGATE_DEVICE_TOKEN;
const deviceId = environment.ASTERGATE_DEVICE_ID;
const username = environment.ASTERGATE_TEST_USERNAME || environment.ASTERGATE_ADMIN_USERNAME;
const password = environment.ASTERGATE_TEST_PASSWORD || environment.ASTERGATE_ADMIN_PASSWORD;
const publicBase = environment.ASTERGATE_PUBLIC_URL;
if (!deviceToken || !deviceId || !username || !password || !publicBase) throw new Error('Relay test environment is incomplete');

const localToken = 'live-test-local-token-0123456789';
const localServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise<void>((resolve) => localServer.once('listening', resolve));
const localAddress = localServer.address();
if (typeof localAddress !== 'object' || !localAddress) throw new Error('Local test server did not start');
localServer.on('connection', (socket, request) => {
  if (request.headers.cookie !== `astergate_session=${localToken}`) return socket.close(1008, 'Invalid local cookie');
  socket.on('message', (data) => socket.send(JSON.stringify({ publicRelayEcho: data.toString() })));
});

let announcedPublicUrl = '';
const relayClient = new RemoteRelayClient({
  relayUrl: new URL('agent', publicBase).href.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:'),
  deviceToken,
  deviceId,
  localPort: localAddress.port,
  localToken,
  reconnectDelayMs: 500,
  onPublicUrl: (value) => { announcedPublicUrl = value; },
});

let browser: WebSocket | undefined;
try {
  relayClient.start();
  await waitUntil(() => Boolean(announcedPublicUrl), 15_000);
  const login = await fetch(new URL('api/login', publicBase), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(publicBase).origin }, body: JSON.stringify({ username, password }) });
  if (login.status !== 200) throw new Error(`Public login returned HTTP ${login.status}`);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('Public login did not set an authentication cookie');
  const browserUrl = new URL(`device/${encodeURIComponent(deviceId)}/ws`, publicBase);
  browserUrl.protocol = browserUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  browser = new WebSocket(browserUrl, { headers: { Cookie: cookie, Origin: new URL(publicBase).origin } });
  await new Promise<void>((resolve, reject) => { browser!.once('open', resolve); browser!.once('error', reject); });
  browser.send('ASTERGATE_PUBLIC_RELAY_TEST');
  const response = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Public relay response timed out')), 15_000);
    browser!.once('message', (data) => { clearTimeout(timer); resolve(data.toString()); });
    browser!.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  const parsed = JSON.parse(response) as { publicRelayEcho?: string };
  if (parsed.publicRelayEcho !== 'ASTERGATE_PUBLIC_RELAY_TEST') throw new Error('Public relay returned the wrong payload');
  console.log('ASTERGATE_PUBLIC_RELAY_OK');
} finally {
  browser?.terminate();
  await relayClient.stop();
  for (const socket of localServer.clients) socket.terminate();
  await new Promise<void>((resolve) => localServer.close(() => resolve()));
}

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Public relay did not announce readiness');
}
