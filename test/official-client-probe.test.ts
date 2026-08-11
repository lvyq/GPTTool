import assert from 'node:assert/strict';
import test from 'node:test';
import { OfficialClientProbe, officialAppPath } from '../src/codex/official-client-probe.ts';

test('derives the macOS app bundle from the embedded Codex executable', () => {
  assert.equal(
    officialAppPath('/Applications/ChatGPT.app/Contents/Resources/codex', 'darwin'),
    '/Applications/ChatGPT.app',
  );
  assert.equal(officialAppPath('/opt/homebrew/bin/codex', 'darwin'), undefined);
});

test('derives the Windows ChatGPT executable from supported selections', () => {
  assert.equal(officialAppPath('C:\\Apps\\ChatGPT\\ChatGPT.exe', 'win32'), 'C:\\Apps\\ChatGPT\\ChatGPT.exe');
  assert.equal(officialAppPath('C:\\Apps\\ChatGPT\\resources\\codex.exe', 'win32'), 'C:\\Apps\\ChatGPT\\ChatGPT.exe');
});

test('rejects a standalone Codex executable in desktop CDP mode', async () => {
  const probe = new OfficialClientProbe({ platform: 'darwin' });
  assert.equal((await probe.inspect('/usr/local/bin/codex')).state, 'unsupported');
  await assert.rejects(probe.ensureRunning('/usr/local/bin/codex'), /官方 ChatGPT/);
});

test('launches an installed desktop client and waits until its process appears', async () => {
  let launched = false;
  let reads = 0;
  let launchArguments: string[] = [];
  const probe = new OfficialClientProbe({
    platform: 'darwin',
    pathExists: async () => true,
    processCommands: async () => (++reads >= 3 ? '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' : ''),
    launchApp: async (_appPath, arguments_) => { launched = true; launchArguments = arguments_; },
    fetch: async () => new Response(JSON.stringify(launched ? [{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/1' }] : [])),
    delay: async () => undefined,
    attempts: 4,
  });
  const status = await probe.ensureRunning('/Applications/ChatGPT.app/Contents/Resources/codex');
  assert.equal(launched, true);
  assert.equal(status.state, 'running');
  assert.equal(status.cdpReady, true);
  assert.ok(launchArguments.some((argument) => argument === '--remote-debugging-port=39252'));
});

test('does not mistake an app-bundled codex worker for the desktop client', async () => {
  const probe = new OfficialClientProbe({
    platform: 'darwin',
    pathExists: async () => true,
    processCommands: async () => '/Applications/ChatGPT.app/Contents/Resources/codex app-server --listen stdio://',
  });
  assert.equal((await probe.inspect('/Applications/ChatGPT.app/Contents/Resources/codex')).state, 'stopped');
});

test('requires confirmation before restarting a normally running desktop client', async () => {
  const probe = new OfficialClientProbe({
    platform: 'darwin',
    pathExists: async () => true,
    processCommands: async () => '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
    fetch: async () => { throw new Error('not listening'); },
  });
  const status = await probe.inspect('/Applications/ChatGPT.app/Contents/Resources/codex');
  assert.equal(status.state, 'running');
  assert.equal(status.cdpReady, false);
  await assert.rejects(probe.ensureRunning('/Applications/ChatGPT.app/Contents/Resources/codex'), /重新启动/);
});

test('does not launch when the desktop client is missing', async () => {
  const probe = new OfficialClientProbe({ platform: 'darwin', pathExists: async () => false });
  await assert.rejects(
    probe.ensureRunning('/Applications/ChatGPT.app/Contents/Resources/codex'),
    /未找到官方 ChatGPT 客户端/,
  );
});

test('reports the official desktop version for compatibility fingerprints', async () => {
  const probe = new OfficialClientProbe({
    platform: 'darwin',
    pathExists: async () => true,
    processCommands: async () => '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
    fetch: async () => new Response(JSON.stringify([{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/1' }])),
    readAppVersion: async () => '26.727.51351 (6119)',
  });
  assert.equal((await probe.inspect('/Applications/ChatGPT.app/Contents/Resources/codex')).appVersion, '26.727.51351 (6119)');
});
