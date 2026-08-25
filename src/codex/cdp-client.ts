import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { BUILTIN_CDP_RULES, type CdpOperationRules } from './cdp-rules.ts';

interface CdpTarget {
  id?: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface CdpResponse {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
  method?: string;
  params?: unknown;
}

export interface CdpClientOptions {
  host?: string;
  port?: number;
  fetch?: typeof fetch;
  connectTimeoutMs?: number;
  rules?: CdpOperationRules;
}

export interface ComposerPreferences {
  model: string;
  effort: string;
  effortLabel: string;
  models: ComposerModelOption[];
  efforts: ReasoningEffortOption[];
  source?: 'official-renderer' | 'app-server-default' | 'provider';
  synchronized?: boolean;
}

export interface ReasoningEffortOption {
  value: string;
  label: string;
}

export interface ComposerModelOption {
  value: string;
  label: string;
  efforts: ReasoningEffortOption[];
  effort?: string;
  effortLabel?: string;
}

export interface AccountUsageInfo {
  available: boolean;
  percentage?: number;
  period?: string;
  resetAt?: string;
  message: string;
  enforced?: boolean;
  provider?: string;
}

export interface CdpCompatibilitySnapshot {
  runtimeVersion?: string;
  mainWindow: boolean;
  runtime: boolean;
  composer: boolean;
  submitControl: boolean;
  modelControl: boolean;
  usageControl: boolean;
  taskMetadata: boolean;
}

const OFFICIAL_REASONING_EFFORTS = [
  { value: 'low', label: '轻度' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
  { value: 'ultra', label: '极高' },
];

export class CdpClient extends EventEmitter {
  readonly host: string;
  readonly port: number;
  readonly #fetch: typeof fetch;
  readonly #connectTimeoutMs: number;
  #socket?: WebSocket;
  #nextId = 1;
  #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  #composerPreferencesCache?: ComposerPreferences;
  #rules: CdpOperationRules;

  constructor(options: CdpClientOptions = {}) {
    super();
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 39252;
    this.#fetch = options.fetch ?? fetch;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 8_000;
    this.#rules = options.rules ?? BUILTIN_CDP_RULES;
  }

  setRules(rules: CdpOperationRules): void { this.#rules = rules; this.#composerPreferencesCache = undefined; }
  get rulesId(): string { return this.#rules.id; }

  get connected(): boolean { return this.#socket?.readyState === WebSocket.OPEN; }

  async discover(): Promise<CdpTarget | undefined> {
    const response = await this.#fetch(`http://${this.host}:${this.port}/json/list`, { signal: AbortSignal.timeout(2_500) });
    if (!response.ok) throw new Error(`CDP discovery failed with HTTP ${response.status}`);
    const targets = await response.json() as CdpTarget[];
    const pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    // Recent ChatGPT builds expose auxiliary Electron pages (for example the
    // avatar overlay) before the actual Codex window. They share the same
    // app://-/index.html prefix but do not contain the composer, so selecting
    // the first prefixed target makes GPTTool look connected while sends fail.
    return pages.find((target) => target.url === 'app://-/index.html')
      ?? pages.find((target) => target.url?.startsWith('app://-/index.html') && !/avatar-overlay/i.test(target.url))
      ?? pages.find((target) => /chatgpt|codex/i.test(`${target.title} ${target.url}`))
      ?? pages[0];
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const target = await this.discover();
    if (!target?.webSocketDebuggerUrl) throw new Error('没有找到官方 ChatGPT 的 CDP 页面');
    const socket = new WebSocket(target.webSocketDebuggerUrl, { handshakeTimeout: this.#connectTimeoutMs });
    this.#socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接官方 ChatGPT CDP 超时')), this.#connectTimeoutMs);
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    socket.on('message', (data) => this.#handleMessage(data.toString()));
    socket.on('close', () => this.#handleClose(new Error('官方 ChatGPT CDP 连接已断开')));
    socket.on('error', (error) => this.emit('error', error));
    await this.command('Runtime.enable');
    await this.command('Page.enable');
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'GPTTool stopped');
    this.#handleClose(new Error('CDP client stopped'));
  }

  command<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.connected || !this.#socket) return Promise.reject(new Error('尚未连接官方 ChatGPT CDP'));
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP ${method} 请求超时`));
      }, 12_000);
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.#socket!.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const response = await this.command<{ result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'CDP 页面脚本执行失败');
    }
    return response.result?.value as T;
  }

  async waitForComposer(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await this.evaluate<boolean>(`(() => {
        const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 40 && r.height > 20 && s.visibility !== 'hidden' && s.display !== 'none'; };
        return [...document.querySelectorAll(${JSON.stringify(this.#rules.selectors.composer)})].some(visible);
      })()`).catch(() => false);
      if (found) return;
      await delay(250);
    }
    throw new Error('官方 ChatGPT 页面已经连接，但消息输入框尚未加载完成；请确认已登录后重试');
  }

  /**
   * Non-mutating renderer feature probe. This deliberately checks capabilities
   * instead of hard-coding a ChatGPT version range, because desktop releases
   * can change the internal DOM without changing the bundled Codex protocol.
   */
  async compatibilitySnapshot(): Promise<CdpCompatibilitySnapshot> {
    const target = await this.discover();
    const browser = await this.command<{ product?: string; userAgent?: string }>('Browser.getVersion')
      .catch((): { product?: string; userAgent?: string } => ({}));
    const snapshot = await this.evaluate<Omit<CdpCompatibilitySnapshot, 'runtimeVersion' | 'mainWindow'>>(`(() => {
      const visible = (element) => {
        if (!(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 20 && rect.height > 20 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const editors = [...document.querySelectorAll(${JSON.stringify(this.#rules.selectors.composer)})]
        .filter(visible)
        .sort((left, right) => right.getBoundingClientRect().bottom - left.getBoundingClientRect().bottom);
      const editor = editors[0];
      let root = editor instanceof HTMLElement ? editor : null;
      for (let depth = 0; root?.parentElement && depth < 10; depth += 1) {
        if (root.querySelector(${JSON.stringify(this.#rules.selectors.composerRootMarker)})) break;
        root = root.parentElement;
      }
      const submitControl = Boolean(root && [...root.querySelectorAll('button')]
        .some((button) => visible(button) && button.querySelector('svg')));
      return {
        runtime: document.readyState === 'interactive' || document.readyState === 'complete',
        composer: Boolean(editor),
        submitControl,
        modelControl: Boolean(document.querySelector(${JSON.stringify(this.#rules.selectors.modelTrigger)})),
        usageControl: Boolean(document.querySelector(${JSON.stringify(this.#rules.selectors.profileTrigger)})),
        taskMetadata: Boolean(document.querySelector(${JSON.stringify(this.#rules.selectors.threadRow)}))
      };
    })()`);
    return {
      runtimeVersion: browser.product || browser.userAgent,
      mainWindow: target?.url === 'app://-/index.html',
      ...snapshot,
    };
  }

  async threadTitles(): Promise<Record<string, string>> {
    return this.evaluate<Record<string, string>>(`(() => Object.fromEntries(
      [...document.querySelectorAll(${JSON.stringify(this.#rules.selectors.threadTitleRow)})]
        .map((element) => {
          const id = String(element.getAttribute('data-app-action-sidebar-thread-id') || '').replace(/^local:/, '');
          const title = String(element.getAttribute('data-app-action-sidebar-thread-title') || '').trim();
          return [id, title];
        })
        .filter(([id, title]) => id && title)
    ))()`);
  }

  async openThread(threadId: string): Promise<boolean> {
    return this.evaluate<boolean>(`(() => {
      const id = ${JSON.stringify(`local:${threadId}`)};
      const row = [...document.querySelectorAll(${JSON.stringify(this.#rules.selectors.threadRow)})]
        .find((element) => element.getAttribute('data-app-action-sidebar-thread-id') === id);
      if (!(row instanceof HTMLElement)) return false;
      row.click();
      return true;
    })()`);
  }

  async openNewThread(): Promise<boolean> {
    return this.evaluate<boolean>(`(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 20 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const labels = /^(新建任务|new task)$/i;
      const button = [...document.querySelectorAll('button,[role="button"]')]
        .filter(visible)
        .find((element) => labels.test(String(element.getAttribute('aria-label') || element.textContent || '').trim()));
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()`);
  }

  async approveVisibleRequest(): Promise<{ approved: boolean; label?: string }> {
    return this.evaluate<{ approved: boolean; label?: string }>(`(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 20 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const label = (element) => String(element.textContent || element.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
      const approveOnce = /^(批准|允许|确认|继续|approve|allow|confirm|continue)$/i;
      const reject = /^(拒绝|取消|reject|deny|cancel)$/i;
      const controls = (container) => [...container.querySelectorAll('button,[role="button"]')]
        .filter((control) => visible(control) && !control.matches(':disabled'));
      const isApprovalContainer = (container) => {
        const buttons = controls(container);
        return buttons.some((button) => reject.test(label(button)))
          && buttons.some((button) => approveOnce.test(label(button)));
      };
      const containers = [...document.querySelectorAll('[role="dialog"],[data-state="open"]')]
        .filter((container) => visible(container) && isApprovalContainer(container));
      // Newer ChatGPT builds render Browser/network permission prompts as a
      // bottom sheet without role="dialog" or data-state="open". Resolve the
      // smallest visible common ancestor containing both one-time approval and
      // reject controls so unrelated page buttons are never clicked.
      for (const candidate of [...document.querySelectorAll('button,[role="button"]')]
        .filter((button) => visible(button) && approveOnce.test(label(button)))) {
        let ancestor = candidate.parentElement;
        for (let depth = 0; ancestor && ancestor !== document.body && depth < 10; depth += 1, ancestor = ancestor.parentElement) {
          if (!visible(ancestor) || !isApprovalContainer(ancestor)) continue;
          containers.push(ancestor);
          break;
        }
      }
      for (const container of containers) {
        const buttons = controls(container);
        const button = buttons.find((candidate) => approveOnce.test(label(candidate)));
        if (!button) continue;
        const approvedLabel = label(button);
        button.click();
        return { approved: true, label: approvedLabel };
      }
      return { approved: false };
    })()`);
  }

  async composerPreferences(): Promise<ComposerPreferences> {
    const original = await this.#readComposerPreference();
    const modelLabels = await this.#readModelLabels().catch(() => original.model ? [original.model] : []);
    const models: ComposerModelOption[] = [];
    let selectedModel = original.model;
    try {
      for (const label of modelLabels) {
        try {
          if (label !== selectedModel) {
            await this.#selectModel(label);
            selectedModel = label;
          }
          const snapshot = await this.#readComposerPreference();
          models.push({
            value: snapshot.model || label,
            label: snapshot.model || label,
            efforts: snapshot.efforts,
            effort: snapshot.effort,
            effortLabel: snapshot.effortLabel,
          });
        } catch {
          models.push({ value: label, label, efforts: label === original.model ? original.efforts : [] });
        }
      }
    } finally {
      if (original.model && selectedModel !== original.model) await this.#selectModel(original.model).catch(() => undefined);
      const restored = await this.#readComposerPreference().catch(() => original);
      if (original.effort && restored.effort !== original.effort) await this.#selectEffort(original.effort, restored.efforts).catch(() => undefined);
    }
    const current = await this.#readComposerPreference().catch(() => original);
    const normalizedModels = uniqueModelOptions(models.length ? models : [{
      value: current.model,
      label: current.model,
      efforts: current.efforts,
      effort: current.effort,
      effortLabel: current.effortLabel,
    }]);
    const result = { ...current, models: normalizedModels };
    this.#composerPreferencesCache = result;
    return result;
  }

  /**
   * Reads only the values already rendered in the official composer. Unlike
   * composerPreferences(), this does not open menus or temporarily switch
   * through models, so it is safe for silent background synchronization.
   */
  async visibleComposerPreference(): Promise<ComposerPreferences> {
    const current = await this.evaluate<Omit<ComposerPreferences, 'models' | 'efforts'>>(`(() => {
      const trigger = document.querySelector('[data-codex-intelligence-trigger="true"]');
      if (!(trigger instanceof HTMLElement)) throw new Error('官方 ChatGPT 当前页面没有模型选择器');
      // Newer renderers keep several aria-hidden measurement labels inside
      // the trigger. Reading the first matching node returns a stale effort
      // (for example "轻度") instead of the value visibly applied in the
      // composer. Scope the lookup to the live dropdown viewport first.
      const viewport = trigger.querySelector('[data-composer-dropdown-viewport]')
        || trigger.querySelector('[data-composer-dropdown-foreground]')
        || trigger;
      return {
        model: String(viewport.querySelector('[class*="ModelPickerTriggerModelText"]')?.textContent || '').trim(),
        effort: String(trigger.getAttribute('data-selected-reasoning-effort') || '').trim(),
        effortLabel: String(viewport.querySelector('[class*="ModelPickerTriggerEffortLabel"]')?.textContent || '').trim()
      };
    })()`);
    return { ...current, models: [], efforts: [] };
  }

  async #readComposerPreference(): Promise<Omit<ComposerPreferences, 'models'>> {
    const current = await this.evaluate<Omit<ComposerPreferences, 'models' | 'efforts'>>(`(() => {
      const trigger = document.querySelector('[data-codex-intelligence-trigger="true"]');
      if (!(trigger instanceof HTMLElement)) throw new Error('官方 ChatGPT 当前页面没有模型选择器');
      const viewport = trigger.querySelector('[data-composer-dropdown-viewport]')
        || trigger.querySelector('[data-composer-dropdown-foreground]')
        || trigger;
      const model = String(viewport.querySelector('[class*="ModelPickerTriggerModelText"]')?.textContent || '').trim();
      const effortLabel = String(viewport.querySelector('[class*="ModelPickerTriggerEffortLabel"]')?.textContent || '').trim();
      const effort = String(trigger.getAttribute('data-selected-reasoning-effort') || '').trim();
      return {
        model,
        effort,
        effortLabel
      };
    })()`);
    let efforts = OFFICIAL_REASONING_EFFORTS;
    try {
      const menu = await this.#openEffortMenu();
      efforts = effortOptionsFromLabels(menu.labels);
    } finally {
      await this.#closeMenu('[data-codex-intelligence-trigger="true"]');
    }
    return { ...current, efforts };
  }

  async setComposerPreferences(input: { model?: string; effort?: string }): Promise<ComposerPreferences> {
    const original = await this.#readComposerPreference();
    let current = original;
    try {
      if (input.model && input.model !== current.model) {
        const availableModels = await this.#readModelLabels();
        if (!availableModels.includes(input.model)) throw new Error('官方客户端当前不支持这个模型');
        await this.#selectModel(input.model);
        current = await this.#readComposerPreference();
      }
      if (input.effort && input.effort !== current.effort) {
        if (!current.efforts.some((item) => item.value === input.effort)) {
          throw new Error(`${current.model || '当前模型'}不支持所选推理强度`);
        }
        await this.#selectEffort(input.effort, current.efforts);
      }
    } catch (error) {
      if (current.model !== original.model) {
        await this.#selectModel(original.model).catch(() => undefined);
        const restored = await this.#readComposerPreference().catch(() => original);
        if (original.effort && restored.effort !== original.effort) {
          await this.#selectEffort(original.effort, restored.efforts).catch(() => undefined);
        }
      }
      throw error;
    }
    const applied = await this.#readComposerPreference();
    const cachedModels = this.#composerPreferencesCache?.models ?? [];
    const models = uniqueModelOptions([
      ...cachedModels.map((model) => model.value === applied.model
        ? {
            ...model,
            efforts: applied.efforts,
            effort: applied.effort,
            effortLabel: applied.effortLabel,
          }
        : model),
      ...(cachedModels.some((model) => model.value === applied.model)
        ? []
        : [{
            value: applied.model,
            label: applied.model,
            efforts: applied.efforts,
            effort: applied.effort,
            effortLabel: applied.effortLabel,
          }]),
    ]);
    const result = { ...applied, models };
    this.#composerPreferencesCache = result;
    return result;
  }

  async usageInfo(): Promise<AccountUsageInfo> {
    const profileTrigger = this.#rules.selectors.profileTrigger;
    try {
      const expanded = await this.evaluate<boolean>(`document.querySelector(${JSON.stringify(profileTrigger)})?.getAttribute('aria-expanded') === 'true'`);
      if (!expanded) await this.#clickElement(profileTrigger);
      let usage = await this.#visibleUsageInfo();
      // Newer ChatGPT builds keep the usage row expanded across menu opens.
      // Clicking it unconditionally collapses the only percentage display and
      // makes a successful read look unavailable. Expand it only when the
      // percentage is not already visible; opening the profile menu still
      // causes the official renderer to refresh its current account state.
      if (!usage) await this.#clickMenuText('剩余用量').catch(() => undefined);
      const deadline = Date.now() + 2_500;
      let stableKey = '';
      let stableReads = 0;
      while (Date.now() < deadline) {
        const candidate = await this.#visibleUsageInfo();
        if (candidate) {
          usage = candidate;
          const key = `${candidate.period}:${candidate.percentage}:${candidate.resetAt}`;
          stableReads = key === stableKey ? stableReads + 1 : 1;
          stableKey = key;
          if (stableReads >= 2) break;
        }
        await delay(100);
      }
      if (!usage) return { available: false, message: '官方客户端暂时没有显示剩余额度' };
      return usage;
    } finally {
      await this.#closeMenu(profileTrigger);
    }
  }

  async #visibleUsageInfo(): Promise<AccountUsageInfo | null> {
    return this.evaluate<AccountUsageInfo | null>(`(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const overlays = [...document.querySelectorAll(
        '[role="menuitem"],[role="menuitemradio"],[role="menu"],[role="dialog"],[data-radix-popper-content-wrapper]'
      )].filter((element) => visible(element) && /剩余用量/.test(String(element.textContent || '')));
      const texts = overlays
        .map((element) => element.textContent)
        .map((value) => String(value || '').replace(/\\s+/g, ' ').trim())
        .filter(Boolean);
      const match = texts
        .map((text) => text.match(/(\\d+\\s*(?:小时|时|周|天|月))\\s*(\\d{1,3})%\\s*[·•]?\\s*(\\d{1,2}月\\d{1,2}日)/))
        .filter(Boolean)
        .at(-1);
      if (!match) return null;
      const percentage = Math.max(0, Math.min(100, Number(match[2])));
      const period = match[1].replace(/\\s+/g, ' ');
      return {
        available: true,
        percentage,
        period,
        resetAt: match[3],
        message: period + '剩余 ' + percentage + '%，' + match[3] + '重置'
      };
    })()`);
  }

  async attachFiles(filePaths: string[]): Promise<void> {
    if (!filePaths.length) return;
    const names = filePaths.map((filePath) => filePath.split(/[\\/]/).at(-1) ?? filePath);
    const baselineCounts = await this.#visibleAttachmentNameCounts(names);
    const inputId = `gpttool-file-input-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const selector = `#${inputId}`;
    try {
      await this.evaluate(`(() => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.id = ${JSON.stringify(inputId)};
        input.style.display = 'none';
        document.body.append(input);
      })()`);
      const documentNode = await this.command<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 });
      const inputNode = await this.command<{ nodeId: number }>('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector });
      if (!inputNode.nodeId) throw new Error('无法创建官方 ChatGPT 后台附件输入');
      await this.command('DOM.setFileInputFiles', { files: filePaths, nodeId: inputNode.nodeId });
      const accepted = await this.evaluate<boolean>(`(() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        if (!(input instanceof HTMLInputElement) || !input.files?.length) return false;
        const transfer = new DataTransfer();
        for (const file of input.files) transfer.items.add(file);
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 40 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const target = [...document.querySelectorAll(${JSON.stringify(this.#rules.selectors.composer)})]
          .filter(visible)
          .sort((left, right) => right.getBoundingClientRect().bottom - left.getBoundingClientRect().bottom)[0];
        if (!(target instanceof HTMLElement)) return false;
        target.focus();
        let dropTarget = target;
        for (let depth = 0; dropTarget.parentElement && depth < 14; depth += 1) {
          const reactPropsKey = Object.keys(dropTarget).find((key) => key.startsWith('__reactProps'));
          const reactProps = reactPropsKey ? dropTarget[reactPropsKey] : undefined;
          if (typeof reactProps?.onDrop === 'function') break;
          dropTarget = dropTarget.parentElement;
        }
        for (const type of ['dragenter', 'dragover', 'drop']) {
          dropTarget.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
        }
        return true;
      })()`);
      if (!accepted) throw new Error('无法把附件交给官方 ChatGPT 输入框');
      await this.#waitForAttachedFileNames(names, baselineCounts);
    } finally {
      await this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.remove()`).catch(() => undefined);
    }
  }

  async prepareTurnMode(mode: 'normal' | 'plan' | 'goal'): Promise<void> {
    if (mode === 'normal') return;
    await this.waitForComposer();
    const focused = await this.evaluate<boolean>(`(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 40 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const editor = [...document.querySelectorAll(${JSON.stringify(this.#rules.selectors.composer)})]
        .filter(visible)
        .sort((left, right) => right.getBoundingClientRect().bottom - left.getBoundingClientRect().bottom)[0];
      if (!(editor instanceof HTMLElement)) return false;
      editor.focus();
      if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'value')?.set;
        setter?.call(editor, '');
      } else {
        const range = document.createRange();
        range.selectNodeContents(editor);
        const selection = getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        selection?.deleteFromDocument();
      }
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
      return true;
    })()`);
    if (!focused) throw new Error('无法聚焦官方 ChatGPT 输入框');
    await this.command('Input.insertText', { text: mode === 'plan' ? '/plan' : '/goal' });

    const deadline = Date.now() + 3_500;
    let selector = '';
    while (Date.now() < deadline && !selector) {
      selector = await this.evaluate<string>(`(() => {
        document.querySelectorAll('[data-gpttool-turn-mode-option]').forEach((element) => element.removeAttribute('data-gpttool-turn-mode-option'));
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 30 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const wanted = ${JSON.stringify(mode)};
        const matches = (text) => wanted === 'plan'
          ? /(?:计划模式|plan mode|\/plan)/i.test(text)
          : /(?:目标模式|goal(?: mode)?|设置(?:要持续追求的)?目标|set goal|\/goal)/i.test(text);
        const candidates = [...document.querySelectorAll('[role="option"],[role="menuitem"],[cmdk-item],button')]
          .filter(visible)
          .filter((element) => matches([
            element.textContent,
            element.getAttribute('aria-label'),
            element.getAttribute('title'),
            element.getAttribute('data-value')
          ].filter(Boolean).join(' ')))
          .sort((left, right) => right.getBoundingClientRect().bottom - left.getBoundingClientRect().bottom);
        const option = candidates[0];
        if (!(option instanceof HTMLElement)) return '';
        option.setAttribute('data-gpttool-turn-mode-option', wanted);
        return '[data-gpttool-turn-mode-option="' + wanted + '"]';
      })()`).catch(() => '');
      if (!selector) await delay(80);
    }
    if (!selector) {
      await this.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }).catch(() => undefined);
      throw new Error(mode === 'plan'
        ? '当前官方 ChatGPT 客户端没有提供计划模式，请先更新官方客户端'
        : '当前官方 ChatGPT 客户端没有提供目标模式，请先更新官方客户端');
    }
    await this.#clickElement(selector);
    await delay(180);
  }

  async submitText(text: string): Promise<void> {
    await this.waitForComposer();
    const focused = await this.evaluate<boolean>(`(() => {
      const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 40 && r.height > 20 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const candidates = [...document.querySelectorAll(${JSON.stringify(this.#rules.selectors.composer)})].filter(visible);
      const el = candidates.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
      if (!el) return false;
      el.focus();
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
        setter?.call(el, '');
      } else {
        const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range); selection?.deleteFromDocument();
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
      return true;
    })()`);
    if (!focused) throw new Error('无法聚焦官方 ChatGPT 输入框');
    await this.command('Input.insertText', { text });
    await delay(80);
    const submitted = await this.evaluate<boolean>(`(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 20 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const editors = [...document.querySelectorAll(${JSON.stringify(this.#rules.selectors.composer)})]
        .filter(visible)
        .sort((left, right) => right.getBoundingClientRect().bottom - left.getBoundingClientRect().bottom);
      const editor = editors[0];
      if (!(editor instanceof HTMLElement)) return false;
      let root = editor;
      for (let depth = 0; root.parentElement && depth < 10; depth += 1) {
        if (root.querySelector(${JSON.stringify(this.#rules.selectors.composerRootMarker)})) break;
        root = root.parentElement;
      }
      const candidates = [...root.querySelectorAll('button')]
        .filter((button) => visible(button) && !button.disabled)
        .filter((button) => !button.getAttribute('data-composer-navigation-target'))
        .filter((button) => !button.getAttribute('aria-label') && !button.getAttribute('title'))
        .filter((button) => button.querySelector('svg'));
      const button = candidates.sort((left, right) => right.getBoundingClientRect().right - left.getBoundingClientRect().right)[0];
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`).catch(() => false);
    if (submitted) {
      await delay(220);
      const blocked = await this.#usageBlockMessage();
      if (blocked) throw new Error(blocked);
      return;
    }
    const blocked = await this.#usageBlockMessage();
    if (blocked) throw new Error(blocked);
    await this.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await this.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  }

  async #usageBlockMessage(): Promise<string> {
    const message = await this.evaluate<string>(`(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const pattern = /(?:已达到|已用完|没有剩余|额度不足|达到).{0,20}(?:使用|额度|限制|上限)|usage limit|limit reached|try again after/i;
      const candidates = [...document.querySelectorAll('[role="alert"],[role="dialog"],[data-state="open"],[aria-live]')]
        .filter(visible)
        .map((element) => String(element.textContent || '').replace(/\\s+/g, ' ').trim())
        .filter((text) => text && pattern.test(text));
      return candidates[0]?.slice(0, 240) || '';
    })()`).catch(() => '');
    return message ? `Codex 剩余额度已用完，官方客户端已阻止执行。${message}` : '';
  }

  async #visibleAttachmentNameCounts(names: string[]): Promise<Record<string, number>> {
    return this.evaluate<Record<string, number>>(`(() => {
      const names = ${JSON.stringify(names)};
      const counts = Object.fromEntries(names.map((name) => [name, 0]));
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const editor = [...document.querySelectorAll('[data-codex-composer="true"],textarea,[contenteditable="true"],[role="textbox"]')]
        .filter(visible)
        .sort((left, right) => right.getBoundingClientRect().bottom - left.getBoundingClientRect().bottom)[0];
      if (!(editor instanceof HTMLElement)) return counts;
      const root = editor.closest('[data-codex-composer-root]') || editor.parentElement || editor;
      const labels = [...root.querySelectorAll('[aria-label],[title],button')]
        .filter(visible)
        .flatMap((element) => [
          element.getAttribute('aria-label'),
          element.getAttribute('title'),
          element.textContent,
        ])
        .map((value) => String(value || '').replace(/\\s+/g, ' ').trim())
        .filter(Boolean);
      for (const name of names) counts[name] = labels.filter((label) => label === name).length;
      return counts;
    })()`);
  }

  async #waitForAttachedFileNames(names: string[], baselineCounts: Record<string, number>): Promise<void> {
    const expectedCounts = names.reduce<Record<string, number>>((counts, name) => {
      counts[name] = (counts[name] ?? baselineCounts[name] ?? 0) + 1;
      return counts;
    }, { ...baselineCounts });
    const deadline = Date.now() + 10_000;
    let stableChecks = 0;
    while (Date.now() < deadline) {
      const counts = await this.#visibleAttachmentNameCounts(Object.keys(expectedCounts))
        .catch((): Record<string, number> => ({}));
      const attached = Object.entries(expectedCounts).every(([name, count]) => (counts[name] ?? 0) >= count);
      if (attached) {
        stableChecks += 1;
        if (stableChecks >= 2) {
          await delay(180);
          return;
        }
      } else {
        stableChecks = 0;
      }
      await delay(100);
    }
    throw new Error('文件已上传到本机，但官方 ChatGPT 没有完成附件接收；请确认官方客户端已登录并停留在 Codex 页面后重试');
  }

  async interrupt(): Promise<void> {
    const clicked = await this.evaluate<boolean>(`(() => {
      const labels = /stop|停止|中止|取消生成|cancel/i;
      const buttons = [...document.querySelectorAll('button')];
      const button = buttons.find((el) => labels.test([el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent].filter(Boolean).join(' ')) && !el.disabled);
      if (!button) return false; button.click(); return true;
    })()`).catch(() => false);
    if (clicked) return;
    await this.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await this.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  }

  async #openIntelligenceMenu(): Promise<void> {
    const expanded = await this.evaluate<boolean>(`document.querySelector('[data-codex-intelligence-trigger="true"]')?.getAttribute('aria-expanded') === 'true'`);
    if (!expanded) await this.#clickElement('[data-codex-intelligence-trigger="true"]');
  }

  async #openEffortMenu(): Promise<{ labels: string[] }> {
    await this.#openIntelligenceMenu();
    const alreadyOpen = await this.#effortMenuInfo();
    if (alreadyOpen) return alreadyOpen;
    const hasEffortEntry = await this.evaluate<boolean>(`(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      return [...document.querySelectorAll('[role="menuitem"]')]
        .some((element) => visible(element) && /^推理强度 /.test(String(element.getAttribute('aria-label') || '')));
    })()`);
    if (!hasEffortEntry) await this.#clickElement('[data-model-picker-view-toggle="true"]');
    const hovered = await this.evaluate<boolean>(`(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const item = [...document.querySelectorAll('[role="menuitem"]')]
        .find((element) => visible(element) && /^推理强度 /.test(String(element.getAttribute('aria-label') || '')));
      if (!(item instanceof HTMLElement)) return false;
      item.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }));
      return true;
    })()`);
    if (!hovered) throw new Error('官方客户端当前没有推理强度入口');
    const deadline = Date.now() + 1_500;
    let menu = await this.#effortMenuInfo();
    while (!menu && Date.now() < deadline) {
      await delay(80);
      menu = await this.#effortMenuInfo();
    }
    if (!menu) throw new Error('官方客户端的推理强度选项尚未加载完成');
    return menu;
  }

  async #selectEffort(effort: string, efforts: ReasoningEffortOption[]): Promise<void> {
    const targetIndex = efforts.findIndex((item) => item.value === effort);
    if (targetIndex < 0) throw new Error('官方客户端当前不支持这个推理强度');
    try {
      await this.#openEffortMenu();
      const selector = await this.evaluate<string>(`(() => {
        const targetIndex = ${targetIndex};
        const wrapper = [...document.querySelectorAll('[data-radix-popper-content-wrapper]')].find((element) => {
          const rect = element.getBoundingClientRect();
          const text = String(element.textContent || '').replace(/\\s+/g, '').trim();
          return rect.width > 0 && rect.height > 0 && text.startsWith('推理强度');
        });
        const items = wrapper ? [...wrapper.querySelectorAll('[role="menuitem"]')] : [];
        const item = items[targetIndex];
        if (!(item instanceof HTMLElement)) return '';
        const token = 'gpttool-effort-option-' + Math.random().toString(36).slice(2);
        item.dataset.gpttoolEffortOption = token;
        return '[data-gpttool-effort-option="' + token + '"]';
      })()`);
      if (!selector) throw new Error('官方客户端的推理强度选项尚未加载完成');
      await this.#clickElement(selector);
    } finally {
      await this.#closeMenu('[data-codex-intelligence-trigger="true"]');
    }
  }

  async #readModelLabels(): Promise<string[]> {
    try {
      await this.#openIntelligenceMenu();
      const hovered = await this.evaluate<boolean>(`(() => {
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const item = [...document.querySelectorAll('[role="menuitem"]')]
          .find((element) => visible(element) && /^模型 /.test(String(element.getAttribute('aria-label') || '')));
        if (!(item instanceof HTMLElement)) return false;
        item.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }));
        return true;
      })()`);
      if (!hovered) throw new Error('官方客户端当前没有模型入口');
      const deadline = Date.now() + 1_500;
      let labels = await this.#modelMenuLabels();
      while (!labels.length && Date.now() < deadline) {
        await delay(80);
        labels = await this.#modelMenuLabels();
      }
      if (!labels.length) throw new Error('官方客户端的模型选项尚未加载完成');
      return labels;
    } finally {
      await this.#closeMenu('[data-codex-intelligence-trigger="true"]');
    }
  }

  async #modelMenuLabels(): Promise<string[]> {
    return this.evaluate<string[]>(`(() => {
      const wrappers = [...document.querySelectorAll('[data-radix-popper-content-wrapper]')].filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      for (const wrapper of wrappers) {
        const items = [...wrapper.querySelectorAll('[role="menuitem"]')];
        if (items.length < 2 || items.some((item) => /^(模型|推理强度|速度) /.test(String(item.getAttribute('aria-label') || '')))) continue;
        const labels = items.map((item) => String(item.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean);
        if (labels.length > 1) return [...new Set(labels)];
      }
      return [];
    })()`);
  }

  async #selectModel(model: string): Promise<void> {
    try {
      await this.#openIntelligenceMenu();
      const hovered = await this.evaluate<boolean>(`(() => {
        const item = [...document.querySelectorAll('[role="menuitem"]')]
          .find((element) => /^模型 /.test(String(element.getAttribute('aria-label') || '')));
        if (!(item instanceof HTMLElement)) return false;
        item.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }));
        return true;
      })()`);
      if (!hovered) throw new Error('官方客户端当前没有模型入口');
      const deadline = Date.now() + 1_500;
      let selector = '';
      while (!selector && Date.now() < deadline) {
        selector = await this.evaluate<string>(`(() => {
          const wanted = ${JSON.stringify(model)};
          const wrappers = [...document.querySelectorAll('[data-radix-popper-content-wrapper]')].filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          for (const wrapper of wrappers) {
            const item = [...wrapper.querySelectorAll('[role="menuitem"]')]
              .find((candidate) => String(candidate.textContent || '').replace(/\\s+/g, ' ').trim() === wanted);
            if (!(item instanceof HTMLElement)) continue;
            const token = 'gpttool-model-option-' + Math.random().toString(36).slice(2);
            item.dataset.gpttoolModelOption = token;
            return '[data-gpttool-model-option="' + token + '"]';
          }
          return '';
        })()`);
        if (!selector) await delay(80);
      }
      if (!selector) throw new Error(`官方客户端暂时没有显示模型“${model}”`);
      await this.#clickElement(selector);
    } finally {
      await this.#closeMenu('[data-codex-intelligence-trigger="true"]');
    }
  }

  async #effortMenuInfo(): Promise<{ labels: string[] } | null> {
    return this.evaluate<{ labels: string[] } | null>(`(() => {
      const wrapper = [...document.querySelectorAll('[data-radix-popper-content-wrapper]')].find((element) => {
        const rect = element.getBoundingClientRect();
        const text = String(element.textContent || '').replace(/\\s+/g, '').trim();
        return rect.width > 0 && rect.height > 0 && text.startsWith('推理强度');
      });
      if (!(wrapper instanceof HTMLElement)) return null;
      const labels = [...wrapper.querySelectorAll('[role="menuitem"]')].map((item) => {
        const text = String(item.textContent || '').replace(/\\s+/g, ' ').trim();
        if (/更快消耗使用额度/.test(text)) return '极高（更快消耗额度）';
        return text;
      }).filter(Boolean);
      return labels.length ? { labels } : null;
    })()`);
  }

  async #closeMenu(triggerSelector: string): Promise<void> {
    const expanded = await this.evaluate<boolean>(`document.querySelector(${JSON.stringify(triggerSelector)})?.getAttribute('aria-expanded') === 'true'`).catch(() => false);
    if (expanded) await this.#clickElement(triggerSelector).catch(() => undefined);
  }

  async #clickMenuText(text: string): Promise<void> {
    const deadline = Date.now() + 2_500;
    while (Date.now() < deadline) {
      const selector = await this.evaluate<string>(`(() => {
        const wanted = ${JSON.stringify(text)};
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const items = [...document.querySelectorAll('[role="menu"] [role="menuitem"],[role="menu"] [role="menuitemradio"]')];
        const item = items.find((element) => {
          const label = String(element.textContent || '').replace(/\\s+/g, ' ').trim();
          return visible(element) && (label === wanted || label.startsWith(wanted));
        });
        if (!(item instanceof HTMLElement)) return '';
        const token = 'gpttool-menu-' + Math.random().toString(36).slice(2);
        item.dataset.gpttoolClickTarget = token;
        return '[data-gpttool-click-target="' + token + '"]';
      })()`);
      if (selector) {
        await this.#clickElement(selector);
        return;
      }
      await delay(100);
    }
    throw new Error(`官方客户端暂时没有显示“${text}”入口`);
  }

  async #clickElement(selector: string): Promise<void> {
    const deadline = Date.now() + 1_800;
    let point: { x: number; y: number } | null = null;
    while (!point && Date.now() < deadline) {
      point = await this.evaluate<{ x: number; y: number } | null>(`(() => {
        const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          const style = getComputedStyle(candidate);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        });
        if (!(element instanceof HTMLElement)) return null;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
      if (!point) await delay(80);
    }
    if (!point) throw new Error('官方 ChatGPT 的模型设置控件尚未加载完成');
    await this.command('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await this.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await delay(160);
  }

  #handleMessage(raw: string): void {
    let message: CdpResponse;
    try { message = JSON.parse(raw) as CdpResponse; } catch { return; }
    if (typeof message.id === 'number') {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? `CDP error ${message.error.code ?? ''}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) this.emit('event', message.method, message.params);
  }

  #handleClose(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.emit('disconnect', error);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function effortOptionsFromLabels(labels: string[]): ReasoningEffortOption[] {
  let extremeCount = 0;
  return labels.map((label, index) => {
    const normalized = label.replace(/\s+/g, '').toLowerCase();
    let value = OFFICIAL_REASONING_EFFORTS[index]?.value ?? `official-${index}`;
    if (/轻度|低|low|minimal/.test(normalized)) value = 'low';
    else if (/^中$|medium/.test(normalized)) value = 'medium';
    else if (/极高|xhigh|extra.?high|ultra/.test(normalized)) {
      value = /更快消耗|ultra/.test(normalized) || extremeCount > 0 ? 'ultra' : 'xhigh';
      extremeCount += 1;
    } else if (/^高$|high/.test(normalized)) value = 'high';
    return { value, label };
  });
}

function uniqueModelOptions(models: ComposerModelOption[]): ComposerModelOption[] {
  return models.filter((model, index, values) => (
    Boolean(model.value) && values.findIndex((candidate) => candidate.value === model.value) === index
  ));
}
