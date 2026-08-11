import assert from 'node:assert/strict';
import test from 'node:test';
import { createRelayPairing, relayPortalUrl } from '../src/remote/relay-pairing.ts';

test('derives the HTTPS account portal from the WSS agent endpoint', () => {
  assert.equal(relayPortalUrl('wss://relay.example.com/gpttool/agent'), 'https://relay.example.com/gpttool/');
});

test('creates a new device identity without exposing server-wide credentials', async () => {
  let requestBody: Record<string, string> = {};
  const result = await createRelayPairing({
    relayUrl: 'wss://relay.example/astergate/agent', deviceName: 'Home Mac',
    fetchImpl: (async (_input: URL | RequestInfo, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ code: 'A1B2C3D4', expiresAt: 123456 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch,
  });
  assert.equal(requestBody.name, 'Home Mac');
  assert.match(requestBody.deviceId ?? '', /^[0-9a-f-]{36}$/);
  assert.ok((requestBody.secret ?? '').length >= 32);
  assert.equal(result.pairingCode, 'A1B2C3D4');
});
