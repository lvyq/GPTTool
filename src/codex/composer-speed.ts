/** A scoped DOM adapter: never guesses service-tier IDs or clicks other menus. */
export function composerSpeedExpression(action: 'open' | 'read' | 'select', wanted = ''): string {
  return `(() => {
    const action = ${JSON.stringify(action)};
    const wanted = ${JSON.stringify(wanted)};
    const visible = (node) => node instanceof HTMLElement && !node.closest('[inert], [aria-hidden="true"]') && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
    const normalize = (text) => String(text || '').replace(/\\s+/g, ' ').trim();
    // New compact picker exposes an explicit binary Fast-mode checkbox.
    const fast = [...document.querySelectorAll('[role="menu"] [role="menuitemcheckbox"][data-fast-mode-enabled]')].find(node => visible(node) && /快速模式|标准模式|fast mode|standard mode/i.test(node.getAttribute('aria-label') || '') && node.getAttribute('aria-disabled') !== 'true');
    if (fast && ['true', 'false'].includes(fast.getAttribute('aria-checked'))) {
      const current = fast.getAttribute('aria-checked') === 'true' ? 'fast' : 'standard';
      if (action === 'select') {
        if (!['fast', 'standard'].includes(wanted)) return null;
        fast.dataset.gpttoolSpeed = 'compact';
        return '[data-gpttool-speed="compact"]';
      }
      return { available: true, current, options: [{value:'standard',label:'标准'}, {value:'fast',label:'快速'}] };
    }
    const entry = [...document.querySelectorAll('[role="menuitem"]')].find(node => visible(node) && /^(速度|Speed)\\s/i.test(node.getAttribute('aria-label') || ''));
    if (!entry || entry.getAttribute('aria-disabled') === 'true') return null;
    const current = normalize(entry.getAttribute('aria-label')).replace(/^(速度|Speed)\\s+/i, '');
    if (action === 'open') {
      entry.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }));
      return { current };
    }
    const controlled = document.getElementById(entry.getAttribute('aria-controls') || '');
    const labelled = [...document.querySelectorAll('[role="menu"]')].find(node => entry.id && node.getAttribute('aria-labelledby') === entry.id);
    const fallback = [...document.querySelectorAll('[data-radix-popper-content-wrapper]')].find(node => visible(node) && /^(速度|Speed)/i.test(normalize(node.textContent)) && !node.contains(entry));
    const menu = [controlled, labelled, fallback].find(visible);
    if (!menu) return null;
    const items = [...menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].filter(node => visible(node) && node.getAttribute('aria-disabled') !== 'true');
    const options = items.map(node => {
      const copy = node.cloneNode(true);
      copy.querySelectorAll('.text-codex-description, svg').forEach(child => child.remove());
      const label = normalize(copy.textContent);
      return { value: label, label };
    });
    if (options.some(option => !option.value)) return null;
    // An unknown current value is not silently replaced with the first option.
    if (!options.some(option => option.value === current)) return null;
    if (action === 'select') {
      const index = options.findIndex(option => option.value === wanted);
      if (index < 0) return null;
      const token = 'speed-' + Math.random().toString(36).slice(2);
      items[index].dataset.gpttoolSpeed = token;
      return '[data-gpttool-speed="' + token + '"]';
    }
    return { available: true, current, options };
  })()`;
}

export interface ComposerSpeed {
  available: boolean;
  model?: string;
  current?: string;
  options: Array<{ value: string; label: string }>;
  message?: string;
}
