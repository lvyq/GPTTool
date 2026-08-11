import assert from 'node:assert/strict';
import test from 'node:test';
import { CdpClient } from '../src/codex/cdp-client.ts';

test('prefers the main Codex page over auxiliary ChatGPT overlay targets', async () => {
  const targets = [
    {
      type: 'page',
      title: 'Codex',
      url: 'app://-/index.html?initialRoute=%2Favatar-overlay',
      webSocketDebuggerUrl: 'ws://127.0.0.1:39252/devtools/page/overlay',
    },
    {
      type: 'page',
      title: 'Codex',
      url: 'app://-/index.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:39252/devtools/page/main',
    },
  ];
  const client = new CdpClient({
    fetch: async () => new Response(JSON.stringify(targets), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  const target = await client.discover();

  assert.equal(target?.url, 'app://-/index.html');
  assert.equal(target?.webSocketDebuggerUrl, 'ws://127.0.0.1:39252/devtools/page/main');
});
