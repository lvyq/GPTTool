import { CdpClient } from '../codex/cdp-client.ts';
import { BUILTIN_CDP_RULES, type CdpOperationRules, validateRules } from '../codex/cdp-rules.ts';
import { OfficialClientProbe, type OfficialClientStatus } from '../codex/official-client-probe.ts';

export interface RuleCollectorOptions {
  probe?: OfficialClientProbe;
  client?: CdpClient;
  platform?: NodeJS.Platform;
  toolVersion?: string;
  officialExecutable?: string;
  now?: () => Date;
}

interface DomProbe {
  selectors: CdpOperationRules['selectors'];
  selectorMatches: Record<string, number>;
  capabilities: Record<string, boolean>;
}

export class CdpRuleCollector {
  readonly #probe: OfficialClientProbe;
  readonly #client: CdpClient;
  readonly #platform: NodeJS.Platform;
  readonly #toolVersion: string;
  readonly #officialExecutable: string;
  readonly #now: () => Date;

  constructor(options: RuleCollectorOptions = {}) {
    this.#probe = options.probe ?? new OfficialClientProbe();
    this.#client = options.client ?? new CdpClient();
    this.#platform = options.platform ?? process.platform;
    this.#toolVersion = options.toolVersion ?? 'dev';
    this.#officialExecutable = options.officialExecutable ?? defaultOfficialExecutable(this.#platform);
    this.#now = options.now ?? (() => new Date());
  }

  inspect(): Promise<OfficialClientStatus> { return this.#probe.inspect(this.#officialExecutable); }

  async collect(options: { consent: boolean; restartClient?: boolean }): Promise<CdpOperationRules> {
    if (options.consent !== true) throw new Error('必须明确授权本次 CDP 规则采集');
    let status = await this.inspect();
    if (!(status.state === 'running' && status.cdpReady)) {
      if (!options.restartClient) throw new Error('官方客户端未启用 CDP；请确认允许采集器重启客户端');
      status = await this.#probe.restartWithCdp(this.#officialExecutable);
    }
    if (!status.appVersion) throw new Error('无法读取官方 ChatGPT 版本号');
    await this.#client.connect();
    try {
      const dom = await this.#collectDomRules();
      const compatibility = await this.#client.compatibilitySnapshot();
      const { runtimeVersion, ...compatibilityFlags } = compatibility;
      const capturedAt = this.#now().toISOString();
      const officialVersion = status.appVersion;
      const rules: CdpOperationRules = {
        schemaVersion: 1,
        id: `official-${this.#platform}-${slug(officialVersion)}`,
        exactOfficialVersion: officialVersion,
        updatedAt: capturedAt,
        selectors: dom.selectors,
        labels: structuredClone(BUILTIN_CDP_RULES.labels),
        collector: {
          toolVersion: this.#toolVersion,
          officialVersion,
          runtimeVersion,
          platform: this.#platform,
          capturedAt,
          capabilities: { ...dom.capabilities, ...compatibilityFlags },
          selectorMatches: dom.selectorMatches,
        },
      };
      const validated = validateRules(rules, officialVersion);
      if (!validated) throw new Error('采集结果未通过安全校验');
      return validated;
    } finally {
      await this.#client.close().catch(() => undefined);
    }
  }

  async #collectDomRules(): Promise<DomProbe> {
    const builtin = BUILTIN_CDP_RULES.selectors;
    return this.#client.evaluate<DomProbe>(`(() => {
      const defaults = ${JSON.stringify(builtin)};
      const visible = (element) => {
        if (!(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 12 && rect.height > 12 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const count = (selector) => { try { return document.querySelectorAll(selector).length; } catch { return 0; } };
      const quote = (value) => String(value).replaceAll('"', '\\\\"');
      const stableSelector = (element, fallback) => {
        if (!(element instanceof Element)) return fallback;
        for (const name of ['data-codex-composer','data-composer-navigation-target','data-codex-intelligence-trigger','data-app-action-sidebar-thread-id','data-app-action-sidebar-thread-title']) {
          const value = element.getAttribute(name);
          if (value && value.length < 120) return '[' + name + '=\"' + quote(value) + '\"]';
        }
        const role = element.getAttribute('role');
        const editable = element.getAttribute('contenteditable');
        if (role === 'textbox' && editable === 'true') return '[role=\"textbox\"][contenteditable=\"true\"]';
        if (element.tagName === 'TEXTAREA') return 'textarea';
        const aria = element.getAttribute('aria-label');
        if (aria && aria.length < 80 && /^[^<>\\n\\r]+$/.test(aria)) return element.tagName.toLowerCase() + '[aria-label=\"' + quote(aria) + '\"]';
        return fallback;
      };
      const editors = [...document.querySelectorAll(defaults.composer)].filter(visible)
        .sort((a,b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
      const editor = editors[0];
      const model = document.querySelector(defaults.modelTrigger)
        || [...document.querySelectorAll('button,[role=button]')].find((el) => visible(el) && [...el.attributes].some((a) => /model|intelligence|reason/i.test(a.name + '=' + a.value)));
      const profile = document.querySelector(defaults.profileTrigger)
        || [...document.querySelectorAll('button,[role=button]')].find((el) => visible(el) && /profile|个人资料|账户|account/i.test(el.getAttribute('aria-label') || ''));
      const selectors = {
        composer: stableSelector(editor, defaults.composer),
        composerRootMarker: defaults.composerRootMarker,
        modelTrigger: stableSelector(model, defaults.modelTrigger),
        profileTrigger: stableSelector(profile, defaults.profileTrigger),
        threadRow: defaults.threadRow,
        threadTitleRow: defaults.threadTitleRow,
      };
      const selectorMatches = Object.fromEntries(Object.entries(selectors).map(([key,value]) => [key,count(value)]));
      return {
        selectors,
        selectorMatches,
        capabilities: {
          documentReady: document.readyState === 'complete' || document.readyState === 'interactive',
          composerVisible: Boolean(editor),
          modelControl: Boolean(model),
          profileControl: Boolean(profile),
          threadRows: selectorMatches.threadRow > 0,
        },
      };
    })()`);
  }
}

export async function uploadRulePackage(options: {
  endpoint: string;
  token: string;
  rules: CdpOperationRules;
  platform: string;
  priority: number;
  fetch?: typeof fetch;
}): Promise<{ ok: true; id: string }> {
  const url = new URL(options.endpoint);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('自动上传地址必须使用 HTTPS');
  }
  if (!options.token.trim()) throw new Error('请先配置云端规则上传令牌');
  const rules = validateRules(options.rules, options.rules.exactOfficialVersion);
  if (!rules) throw new Error('规则文件格式无效');
  const response = await (options.fetch ?? fetch)(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${options.token.trim()}` },
    body: JSON.stringify({ rules, platform: options.platform, priority: options.priority }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({})) as { ok?: boolean; id?: string; error?: string };
  if (!response.ok || !payload.ok) throw new Error(payload.error || `上传失败（HTTP ${response.status}）`);
  return { ok: true, id: payload.id || rules.id };
}

function defaultOfficialExecutable(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
  if (platform === 'win32') return 'ChatGPT.exe';
  return '';
}

function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80); }
