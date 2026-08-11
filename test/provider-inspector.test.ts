import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectCodexProviderConfig } from '../src/codex/provider-inspector.ts';

test('treats the default Codex configuration as official OpenAI', () => {
  const status = inspectCodexProviderConfig('model = "gpt-5.6-sol"\n');
  assert.equal(status.mode, 'official');
  assert.equal(status.officialUsageApplies, true);
  assert.equal(status.model, 'gpt-5.6-sol');
});

test('accepts a Kimi translation router that exposes the Responses API', () => {
  const status = inspectCodexProviderConfig(`
model = "k3-256k"
model_provider = "kimi-proxy"

[model_providers.kimi-proxy]
name = "Kimi via CC Switch"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
`);
  assert.equal(status.mode, 'external-responses');
  assert.equal(status.officialUsageApplies, false);
  assert.equal(status.name, 'Kimi via CC Switch');
});

test('explains that the direct Kimi coding endpoint needs protocol translation', () => {
  const status = inspectCodexProviderConfig(`
model = "k3-256k"
model_provider = "kimi"

[model_providers.kimi]
name = "Kimi"
base_url = "https://api.kimi.com/coding/v1"
wire_api = "responses"
`);
  assert.equal(status.mode, 'translation-required');
  assert.match(status.message, /兼容路由转换/);
  assert.equal(status.officialUsageApplies, false);
});

test('treats a custom OpenAI base URL as an external Responses provider', () => {
  const status = inspectCodexProviderConfig(`
model = "relay-model"
openai_base_url = "https://relay.example.com/v1"
`);
  assert.equal(status.mode, 'external-responses');
  assert.equal(status.external, true);
});
