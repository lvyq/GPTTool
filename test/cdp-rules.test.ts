import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_CDP_RULES, loadCdpRules, matchesOfficialVersion, validateRules } from '../src/codex/cdp-rules.ts';

test('selects a cloud CDP adapter only when it matches the installed official version', async () => {
  const cloud = { ...BUILTIN_CDP_RULES, id: 'official-2.9', exactOfficialVersion: '2.9.1', updatedAt: new Date().toISOString() };
  const matched = await loadCdpRules({
    officialVersion: '2.9.1', endpoint: 'https://relay.example/api/cdp-rules',
    fetch: async () => new Response(JSON.stringify(cloud), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  assert.equal(matched.id, 'official-2.9');
  assert.equal(matchesOfficialVersion(cloud, '2.9.1'), true);
  assert.equal(matchesOfficialVersion(cloud, '2.9.2'), false);
});

test('rejects executable cloud content and safely falls back to bundled rules', async () => {
  const invalid = { ...BUILTIN_CDP_RULES, id: 'unsafe', selectors: { ...BUILTIN_CDP_RULES.selectors, composer: 'javascript:alert(1)' } };
  assert.equal(validateRules(invalid, '2.9.1'), undefined);
  const loaded = await loadCdpRules({
    officialVersion: '2.9.1', endpoint: 'https://relay.example/api/cdp-rules',
    fetch: async () => new Response(JSON.stringify(invalid), { status: 200 }),
  });
  assert.equal(loaded.id, BUILTIN_CDP_RULES.id);
});

test('rejects a collector adapter that matched the version but did not find messaging controls', async () => {
  const broken = {
    ...BUILTIN_CDP_RULES,
    id: 'collector-false-positive',
    exactOfficialVersion: '26.818.61809 (7019)',
    collector: {
      capabilities: {
        runtime: true, mainWindow: true, documentReady: true,
        composer: false, submitControl: false, composerVisible: false,
      },
      selectorMatches: { composer: 0, submitControl: 0 },
    },
  };
  assert.equal(validateRules(broken, '26.818.61809 (7019)'), undefined);
  const loaded = await loadCdpRules({
    officialVersion: '26.818.61809 (7019)',
    endpoint: 'https://relay.example/api/cdp-rules',
    fetch: async () => new Response(JSON.stringify(broken), { status: 200 }),
  });
  assert.equal(loaded.id, BUILTIN_CDP_RULES.id);
});

test('accepts collector adapters only after the messaging surface is proven', () => {
  const compatible = {
    ...BUILTIN_CDP_RULES,
    id: 'collector-compatible',
    collector: {
      capabilities: {
        runtime: true, mainWindow: true, documentReady: true,
        composer: true, submitControl: true, composerVisible: true,
      },
      selectorMatches: { composer: 1, submitControl: 1 },
    },
  };
  assert.equal(validateRules(compatible)?.id, 'collector-compatible');
});
