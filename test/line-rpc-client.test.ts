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
