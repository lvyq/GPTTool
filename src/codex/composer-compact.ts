export interface CompactComposer {
  selection: string;
  models: string[];
  index: number;
  options: Array<{ model: string; effort: string; locked: boolean }>;
}

/** Read-only component props supply the keyboard slider's exact step mapping. */
export const COMPACT_COMPOSER_EXPRESSION = `(() => {
  const control = document.querySelector('[data-reasoning-slider]');
  if (!control || control.closest('[inert], [aria-hidden="true"]')) return null;
  const slider = control.querySelector('[role="slider"]');
  if (!slider) return null;
  let fiber = control[Object.keys(control).find(key => key.startsWith('__reactFiber'))];
  let options;
  for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
    const values = fiber.memoizedProps?.powerSelections;
    if (Array.isArray(values) && values.length && values.every(value => typeof value?.model === 'string' && typeof value?.reasoningEffort === 'string')) {
      options = values.map(value => ({ model: value.model, effort: value.reasoningEffort, locked: value.isLocked === true }));
      break;
    }
  }
  if (!options || options.length !== Number(slider.getAttribute('aria-valuemax')) + 1) return null;
  const menu = control.closest('[role="menu"]');
  const radios = [...menu.querySelectorAll('[role="menuitemradio"]')];
  const label = node => String(node.textContent || '').replace(/\\s+/g, ' ').trim();
  return { index: Number(slider.getAttribute('aria-valuenow')), options,
    selection: label(radios.find(node => node.getAttribute('aria-checked') === 'true') || {}),
    models: radios.map(label) };
})()`;

export function compactEffortIndex(state: CompactComposer, model: string, effort: string): number {
  const key = (value: string) => value.toLowerCase().replace(/^gpt[-\s]*/, '').replace(/[^a-z0-9]/g, '');
  return state.options.findIndex(option => !option.locked && key(option.model) === key(model) && option.effort === effort);
}
