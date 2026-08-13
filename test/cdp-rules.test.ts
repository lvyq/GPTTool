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
