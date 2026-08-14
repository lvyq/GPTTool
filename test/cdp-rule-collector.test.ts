import assert from 'node:assert/strict';
import test from 'node:test';
import { CdpRuleCollector, uploadRulePackage } from '../src/collector/rule-collector.ts';
import type { CdpClient, CdpCompatibilitySnapshot } from '../src/codex/cdp-client.ts';
import type { OfficialClientProbe } from '../src/codex/official-client-probe.ts';

const probe = {
  inspect: async () => ({ state: 'running', cdpReady: true, appVersion: '26.810.41047 (6570)', message: 'ready' }),
  restartWithCdp: async () => { throw new Error('must not restart'); },
} as unknown as OfficialClientProbe;

const client = {
  connect: async () => undefined,
  close: async () => undefined,
  evaluate: async () => ({
    selectors: {
      composer: '[data-codex-composer="true"]', composerRootMarker: '[data-composer-navigation-target="add-context"]',
      modelTrigger: '[data-codex-intelligence-trigger="true"]', profileTrigger: 'button[aria-label="profile"]',
      threadRow: '[data-app-action-sidebar-thread-id]', threadTitleRow: '[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-title]',
    },
    selectorMatches: { composer: 1, composerRootMarker: 1, modelTrigger: 1, profileTrigger: 1, threadRow: 5, threadTitleRow: 5 },
    capabilities: { documentReady: true, composerVisible: true, modelControl: true, profileControl: true, threadRows: true },
  }),
  compatibilitySnapshot: async (): Promise<CdpCompatibilitySnapshot> => ({
    runtimeVersion: 'Chrome/151', mainWindow: true, runtime: true, composer: true, submitControl: true,
    modelControl: true, usageControl: true, taskMetadata: true,
  }),
} as unknown as CdpClient;

test('collector refuses to inspect DOM without explicit consent', async () => {
  const collector = new CdpRuleCollector({ probe, client });
  await assert.rejects(() => collector.collect({ consent: false }), /明确授权/);
});

test('collector creates an exact-version package without user content', async () => {
  const collector = new CdpRuleCollector({
    probe, client, platform: 'darwin', toolVersion: '0.2.0', now: () => new Date('2026-08-15T00:00:00.000Z'),
  });
  const rules = await collector.collect({ consent: true });
  assert.equal(rules.id, 'official-darwin-26-810-41047-6570');
  assert.equal(rules.exactOfficialVersion, '26.810.41047 (6570)');
  assert.equal(rules.collector?.selectorMatches.composer, 1);
  assert.doesNotMatch(JSON.stringify(rules), /cookie|token|message body|attachment path/i);
});

test('uploader rejects non-HTTPS remote endpoints', async () => {
  const collector = new CdpRuleCollector({ probe, client, platform: 'darwin' });
  const rules = await collector.collect({ consent: true });
  await assert.rejects(() => uploadRulePackage({
    endpoint: 'http://example.com/api/admin/cdp-rules', token: 'secret', rules, platform: 'darwin', priority: 1,
  }), /HTTPS/);
});

test('uploader sends validated rule package with bearer authorization', async () => {
  const collector = new CdpRuleCollector({ probe, client, platform: 'darwin' });
  const rules = await collector.collect({ consent: true });
  let authorization = '';
  const result = await uploadRulePackage({
    endpoint: 'https://relay.example/api/admin/cdp-rules', token: 'secret', rules, platform: 'darwin', priority: 100,
    fetch: async (_url, init) => {
      authorization = String((init?.headers as Record<string, string>).authorization);
      return new Response(JSON.stringify({ ok: true, id: rules.id }), { status: 201, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(authorization, 'Bearer secret');
  assert.equal(result.id, rules.id);
});
