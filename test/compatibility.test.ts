import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareOfficialVersions,
  compatibilityError,
  summarizeCompatibility,
} from '../src/codex/compatibility.ts';

test('blocks remote control when a required official capability disappears', () => {
  const report = summarizeCompatibility([
    { id: 'composer', label: '消息输入框', required: true, available: false },
    { id: 'usage', label: '剩余用量', required: false, available: true },
  ], { officialAppVersion: '26.800.1' });
  assert.equal(report.state, 'incompatible');
  assert.equal(report.mode, 'blocked');
  assert.match(report.message, /已阻止远程控制/);
  const error = compatibilityError(report) as Error & { code?: string };
  assert.equal(error.code, 'OFFICIAL_CLIENT_INCOMPATIBLE');
});

test('keeps core control available while reporting an optional compatibility loss', () => {
  const report = summarizeCompatibility([
    { id: 'composer', label: '消息输入框', required: true, available: true },
    { id: 'usage', label: '剩余用量', required: false, available: false },
  ], { officialAppVersion: '26.600.1' });
  assert.equal(report.state, 'degraded');
  assert.equal(report.mode, 'backward-compatible');
  assert.match(report.message, /向下兼容模式/);
});

test('marks a fully probed official client compatible', () => {
  const report = summarizeCompatibility([
    { id: 'composer', label: '消息输入框', required: true, available: true },
    { id: 'usage', label: '剩余用量', required: false, available: true },
  ]);
  assert.equal(report.state, 'compatible');
  assert.equal(report.mode, 'full');
});

test('keeps an older official client usable when only the new app-server is absent', () => {
  const report = summarizeCompatibility([
    { id: 'main-window', label: '官方主窗口', required: true, available: true },
    { id: 'renderer-runtime', label: '页面控制协议', required: true, available: true },
    { id: 'composer', label: '消息输入框', required: true, available: true },
    { id: 'submit', label: '消息发送控件', required: true, available: true },
    { id: 'app-server', label: '新版 Codex 接口', required: false, available: false },
    { id: 'threads', label: '新版任务接口', required: false, available: false },
  ], { officialAppVersion: '26.600.1' });
  assert.equal(report.state, 'degraded');
  assert.equal(report.mode, 'backward-compatible');
  assert.match(report.message, /消息发送可用/);
});

test('compares official client versions without using the build suffix as a hard gate', () => {
  assert.equal(compareOfficialVersions('26.600.1 (5000)', '26.727.51351'), 'older');
  assert.equal(compareOfficialVersions('26.727.51351 (6119)', '26.727.51351'), 'same');
  assert.equal(compareOfficialVersions('26.900.2', '26.727.51351'), 'newer');
  assert.equal(compareOfficialVersions(undefined, '26.727.51351'), 'unknown');
});
