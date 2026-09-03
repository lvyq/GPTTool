import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { COMPACT_COMPOSER_EXPRESSION, compactEffortIndex } from '../src/codex/composer-compact.ts';

test('reads exact slider mappings from bounded component props, not assumed effort order', () => {
  const options = [
    { model: 'gpt-5.6-terra', reasoningEffort: 'low', isLocked: false },
    { model: 'gpt-5.6-sol', reasoningEffort: 'low', isLocked: false },
    { model: 'gpt-5.6-sol', reasoningEffort: 'medium', isLocked: false },
    { model: 'gpt-5.6-sol', reasoningEffort: 'ultra', isLocked: true },
  ];
  let max = '3';
  const slider = { getAttribute: (key: string) => key === 'aria-valuemax' ? max : '2' };
  const radio = { textContent: '5.6 Sol', getAttribute: () => 'true' };
  const control = {
    __reactFiber_test: { return: { memoizedProps: { powerSelections: options } } },
    closest: (selector: string) => selector === '[role="menu"]' ? { querySelectorAll: () => [radio] } : null,
    querySelector: () => slider,
  };
  const context = { document: { querySelector: () => control } };
  const state = runInNewContext(COMPACT_COMPOSER_EXPRESSION, context);
  assert.equal(state.index, 2);
  assert.equal(state.selection, '5.6 Sol');
  assert.equal(compactEffortIndex(state, '5.6 Sol', 'low'), 1);
  assert.equal(compactEffortIndex(state, '5.6 Terra', 'low'), 0);
  assert.equal(compactEffortIndex(state, '5.6 Sol', 'ultra'), -1);
  assert.equal(compactEffortIndex(state, '5.6 Sol', 'invented'), -1);
  max = '9';
  assert.equal(runInNewContext(COMPACT_COMPOSER_EXPRESSION, context), null);
});

test('unknown or hidden compact pickers do not receive invented capabilities', () => {
  assert.equal(runInNewContext(COMPACT_COMPOSER_EXPRESSION, { document: { querySelector: () => null } }), null);
  assert.equal(runInNewContext(COMPACT_COMPOSER_EXPRESSION, { document: { querySelector: () => ({ closest: () => true }) } }), null);
});
