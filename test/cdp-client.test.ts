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

test('recognizes newer Browser permission bottom sheets without a dialog role', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(
    new URL('../src/codex/cdp-client.ts', import.meta.url),
    'utf8',
  ));

  assert.match(source, /button,\[role="button"\]/);
  assert.match(source, /smallest visible common ancestor containing both one-time approval and/);
  assert.match(source, /ancestor !== document\.body && depth < 10/);
  assert.match(source, /isApprovalContainer\(ancestor\)/);
  assert.doesNotMatch(source, /approveOnce = \/.*始终允许/);
});
