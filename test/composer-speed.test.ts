import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { composerSpeedExpression } from '../src/codex/composer-speed.ts';

class Element {
  dataset: Record<string, string> = {};
  hidden = false;
  constructor(public attributes: Record<string, string> = {}) {}
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  getBoundingClientRect() { return { width: 100, height: 40 }; }
  closest() { return this.hidden ? this : null; }
}

function compact(checked: string, action: 'read' | 'select' = 'read', wanted = '', disabled = false, hidden = false) {
  const element = new Element({ 'aria-label': '启用快速模式', 'aria-checked': checked, 'aria-disabled': String(disabled) });
  element.hidden = hidden;
  const document = { querySelectorAll: (selector: string) => selector.includes('menuitemcheckbox') ? [element] : [] };
  return { result: runInNewContext(composerSpeedExpression(action, wanted), { document, HTMLElement: Element }), element };
}

test('reads compact standard and fast states without clicking', () => {
  const standard = compact('false');
  assert.equal(standard.result.current, 'standard');
  assert.equal(compact('true').result.current, 'fast');
  assert.equal(standard.result.options.length, 2);
  assert.deepEqual(standard.element.dataset, {});
});

test('marks only a supported speed for the explicit apply operation', () => {
  assert.equal(compact('false', 'select', 'fast').result, '[data-gpttool-speed="compact"]');
  assert.equal(compact('false', 'select', 'invented-tier').result, null);
});

test('does not expose disabled, inert, or unknown compact states as available', () => {
  assert.equal(compact('false', 'read', '', true).result, null);
  assert.equal(compact('false', 'read', '', false, true).result, null);
  assert.equal(compact('mixed').result, null);
});

test('legacy submenu strips descriptions and uses only the speed entry controls', () => {
  const entry = Object.assign(new Element({ 'aria-label': '速度 标准', 'aria-controls': 'speed-menu' }), { id: 'speed-trigger' });
  const items = ['标准', '快速'].map(text => Object.assign(new Element(), {
    cloneNode: () => ({ textContent: text, querySelectorAll: () => [] }),
  }));
  const menu = Object.assign(new Element(), { querySelectorAll: () => items });
  const document = {
    querySelectorAll: (selector: string) => selector === '[role="menuitem"]' ? [entry] : [],
    getElementById: (id: string) => id === 'speed-menu' ? menu : null,
  };
  const context = { document, HTMLElement: Element };
  assert.equal(runInNewContext(composerSpeedExpression('read'), context).current, '标准');
  assert.match(runInNewContext(composerSpeedExpression('select', '快速'), context), /data-gpttool-speed/);
  assert.deepEqual(items[0]!.dataset, {});
  assert.ok(items[1]!.dataset.gpttoolSpeed);
  entry.attributes['aria-label'] = '速度 未知';
  assert.equal(runInNewContext(composerSpeedExpression('read'), context), null);
});
