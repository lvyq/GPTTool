import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { LineRpcClient, RpcResponseError } from '../src/runtime/line-rpc-client.ts';

test('matches a JSONL response to its request', async () => {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const client = new LineRpcClient(clientToServer, serverToClient, 500);

  clientToServer.once('data', (chunk) => {
    const request = JSON.parse(String(chunk));
    serverToClient.write(`${JSON.stringify({ id: request.id, result: { ok: true } })}\n`);
  });

  assert.deepEqual(await client.request('health/read'), { ok: true });
  client.close();
});

test('emits notifications independently of responses', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const client = new LineRpcClient(input, output, 500);
  const received = new Promise((resolve) => client.once('notification:turn/completed', resolve));

  output.write('{"method":"turn/completed","params":{"turnId":"t1"}}\n');
  assert.deepEqual(await received, { turnId: 't1' });
  client.close();
});

test('emits server requests and writes approval responses', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const client = new LineRpcClient(input, output);
  const request = once(client, 'serverRequest');
  output.write('{"id":44,"method":"item/commandExecution/requestApproval","params":{"command":"pwd"}}\n');
  const [received] = await request;
  assert.equal(received.id, 44);
  client.respond(44, { decision: 'decline' });
  assert.match(input.read().toString(), /"decision":"decline"/);
  client.close();
});

test('turns RPC error payloads into typed errors', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const client = new LineRpcClient(input, output, 500);

  input.once('data', (chunk) => {
    const request = JSON.parse(String(chunk));
    output.write(`${JSON.stringify({ id: request.id, error: { code: -32001, message: 'busy' } })}\n`);
  });

  await assert.rejects(client.request('turn/start'), (error: unknown) => {
    return error instanceof RpcResponseError && error.rpcError.code === -32001;
  });
  client.close();
});

test('closes and detaches stream listeners when an RPC frame exceeds its limit', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const client = new LineRpcClient(input, output, 500, 64);
  const protocolError = once(client, 'protocolError');
  const closed = once(client, 'close');

  output.write('x'.repeat(65));

  const [error] = await protocolError;
  assert.match((error as Error).message, /safety limit/);
  await closed;
  assert.equal(output.listenerCount('data'), 0);
  assert.equal(output.listenerCount('end'), 0);
  assert.equal(output.listenerCount('close'), 0);
  assert.equal(output.listenerCount('error'), 1);
  assert.equal(input.listenerCount('error'), 1);
  await assert.rejects(client.request('health/read'), /closed/);
});

test('ignores late data from a detached RPC stream', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const client = new LineRpcClient(input, output, 500);
  let notifications = 0;
  client.on('notification', () => { notifications += 1; });

  client.close();
  output.emit('data', '{"method":"turn/completed"}\n');

  assert.equal(notifications, 0);
});
