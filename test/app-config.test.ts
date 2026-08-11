import assert from 'node:assert/strict';
import test from 'node:test';
import { configScopeChanged, defaultConfig, normalizeConfig, validateConfig } from '../src/config/app-config.ts';

test('uses platform-specific Codex defaults', () => {
  assert.equal(defaultConfig('darwin').codexExecutable, '/Applications/ChatGPT.app/Contents/Resources/codex');
  assert.match(defaultConfig('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }).codexExecutable, /ChatGPT\.exe$/i);
  assert.equal(defaultConfig('darwin').remotePort, 8518);
  assert.equal(defaultConfig('darwin').keepComputerAwake, false);
  assert.equal(normalizeConfig({ remotePort: 8787 }).remotePort, 8518);
  assert.equal(normalizeConfig({ keepComputerAwake: true }).keepComputerAwake, true);
});

test('validates the required Codex executable', () => {
  const errors = validateConfig(normalizeConfig({ codexExecutable: '' }));
  assert.deepEqual(errors, ['请选择 Codex 可执行文件']);
});

test('requires encrypted public relay URLs', () => {
  assert.throws(() => normalizeConfig({ relayUrl: 'ws://example.com/agent' }), /加密 WSS/);
});

test('tracks Codex mode and remote configuration changes', () => {
  const current = defaultConfig('darwin');
  assert.equal(configScopeChanged('codex', current, { ...current, codexConnectionMode: 'app-server' }), true);
  assert.equal(configScopeChanged('codex', current, { ...current, remotePort: 9000 }), true);
  assert.equal(configScopeChanged('codex', current, { ...current, autoUpdate: false }), false);
  assert.equal(configScopeChanged('codex', current, { ...current, keepComputerAwake: true }), false);
});
