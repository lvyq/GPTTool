import type { RpcNotification, RpcServerRequest } from '../runtime/line-rpc-client.ts';
import { compatibilityError, summarizeCompatibility, type OfficialCompatibilityReport } from './compatibility.ts';
import type { AccountUsageInfo, ComposerPreferences } from './cdp-client.ts';
import { inspectCodexProvider, type CodexProviderStatus } from './provider-inspector.ts';
import { OfficialAppServerClient, type OfficialAppServerTransport } from './thread-metadata-client.ts';

export interface AppServerCodexServiceOptions {
  executable: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  clientVersion?: string;
  officialAppVersion?: string;
  homeDirectory?: string;
  appServerClient?: OfficialAppServerTransport | null;
}

interface AttachmentInput { path?: string; name?: string; mimeType?: string }

/**
 * Pure official app-server runtime. Unlike hybrid mode it never opens or
 * operates the ChatGPT renderer, so it is resilient to desktop UI changes.
 */
export class AppServerCodexService {
  readonly #client: OfficialAppServerTransport;
  readonly #notificationListeners = new Set<(value: RpcNotification) => void>();
  readonly #requestListeners = new Set<(value: RpcServerRequest) => void>();
  #running = false;
  #autoApprove = false;
  #model = '';
  #effort = '';
  #provider: CodexProviderStatus = {
    id: 'openai', name: 'OpenAI', model: '', wireApi: 'responses', mode: 'official',
    external: false, officialUsageApplies: true, message: '正在使用 OpenAI 官方模型服务',
  };
  #compatibility: OfficialCompatibilityReport = {
    state: 'unknown', mode: 'unknown', features: [], message: '尚未检查独立服务兼容性',
  };
  #unsubscribeNotification?: () => void;
  #unsubscribeRequest?: () => void;

  constructor(private readonly options: AppServerCodexServiceOptions) {
    this.#client = options.appServerClient ?? new OfficialAppServerClient(options);
  }

  get running(): boolean { return this.#running; }
  get compatibility(): OfficialCompatibilityReport { return this.#compatibility; }

  async start(): Promise<void> {
    if (this.#running) return;
    await this.#client.connect();
    this.#unsubscribeNotification = this.#client.onNotification((notification) => {
      for (const listener of this.#notificationListeners) listener(notification);
    });
    this.#unsubscribeRequest = this.#client.onServerRequest((request) => {
      if (this.#autoApprove && isApprovalRequest(request.method)) {
        this.#client.respond(request.id, { decision: 'accept' });
        return;
      }
      for (const listener of this.#requestListeners) listener(request);
    });
    await this.#refreshProvider();
    this.#running = true;
  }

  onNotification(listener: (value: RpcNotification) => void): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  onServerRequest(listener: (value: RpcServerRequest) => void): () => void {
    this.#requestListeners.add(listener);
    return () => this.#requestListeners.delete(listener);
  }

  respond(id: number, result: unknown): void { this.#client.respond(id, result); }

  async request<T>(method: string, params?: unknown): Promise<T> {
    if (!this.#running) throw new Error('Codex 独立服务尚未运行');
    const input = asRecord(params);
    switch (method) {
      case 'approval/auto/get': return { enabled: this.#autoApprove } as T;
      case 'approval/auto/set':
        this.#autoApprove = input.enabled === true;
        return { enabled: this.#autoApprove } as T;
      case 'composer/speed/get': return { available: false, options: [], message: '独立服务暂不支持速度设置，请使用官方同步模式' } as T;
      case 'composer/speed/set': throw new Error('独立服务暂不支持速度设置');
      case 'composer/preferences/inspect':
      case 'composer/preferences/get': return await this.#preferences() as T;
      case 'composer/preferences/set':
        this.#model = stringValue(input.model);
        this.#effort = stringValue(input.effort);
        return await this.#preferences() as T;
      case 'account/usage/get':
        await this.#refreshProvider();
        if (!this.#provider.officialUsageApplies) return {
          available: false, enforced: false, provider: this.#provider.name, message: this.#provider.message,
        } as T;
        return (normalizeUsage(await this.#client.request('account/rateLimits/read', {})) ?? {
          available: false, enforced: true, provider: 'OpenAI', message: '官方服务暂未返回剩余用量',
        }) as T;
      case 'provider/status/get':
        await this.#refreshProvider();
        return this.#provider as T;
      case 'compatibility/status/get': return this.#compatibility as T;
      case 'turn/start': return await this.#client.request<T>('turn/start', this.#turnStartParams(input));
      case 'turn/steer': return await this.#client.request<T>('turn/steer', {
        threadId: input.threadId, input: normalizeUserInput(input.input, []),
      });
      default: return await this.#client.request<T>(method, params);
    }
  }

  async verifyCompatibility(directory = this.options.cwd || this.options.homeDirectory || process.env.HOME || ''): Promise<OfficialCompatibilityReport> {
    this.#compatibility = { state: 'checking', mode: 'unknown', features: [], message: '正在检查官方 app-server…' };
    const probe = await this.#client.probe(directory);
    this.#compatibility = summarizeCompatibility([
      { id: 'app-server', label: '官方 app-server', required: true, available: probe.initialized },
      { id: 'threads', label: '任务接口', required: true, available: probe.threads },
      { id: 'models', label: '模型设置', required: false, available: probe.models },
      { id: 'usage', label: '剩余用量', required: false, available: probe.usage },
      { id: 'directories', label: '项目目录', required: false, available: probe.directories },
    ], { officialAppVersion: this.options.officialAppVersion, runtimeVersion: probe.runtimeVersion });
    if (this.#compatibility.state === 'incompatible') throw compatibilityError(this.#compatibility);
    return this.#compatibility;
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#unsubscribeNotification?.();
    this.#unsubscribeRequest?.();
    this.#unsubscribeNotification = undefined;
    this.#unsubscribeRequest = undefined;
    await this.#client.close();
  }

  #turnStartParams(input: Record<string, unknown>): Record<string, unknown> {
    const attachments = Array.isArray(input.attachments) ? input.attachments.map(asRecord) : [];
    const result: Record<string, unknown> = {
      threadId: input.threadId,
      input: normalizeUserInput(input.input, attachments),
    };
    if (this.#model) result.model = this.#model;
    if (this.#effort) result.effort = this.#effort;
    return result;
  }

  async #preferences(): Promise<ComposerPreferences> {
    const response = asRecord(await this.#client.request('model/list', {}));
    const models = normalizeModels(response.data);
    const selected = models.find((model) => model.value === this.#model) ?? models.find((model) => model.isDefault) ?? models[0];
    if (!selected) throw new Error('官方 app-server 暂未提供模型信息');
    this.#model = selected.value;
    const effort = selected.efforts.some((item) => item.value === this.#effort)
      ? this.#effort : selected.effort || selected.efforts[0]?.value || '';
    this.#effort = effort;
    return {
      model: selected.value,
      effort,
      effortLabel: selected.efforts.find((item) => item.value === effort)?.label ?? effort,
      models,
      efforts: selected.efforts,
    };
  }

  async #refreshProvider(): Promise<CodexProviderStatus> {
    const home = this.options.homeDirectory ?? this.options.env?.HOME ?? process.env.HOME ?? '';
    this.#provider = await inspectCodexProvider(home);
    return this.#provider;
  }
}

function normalizeUserInput(value: unknown, attachments: Record<string, unknown>[]): unknown[] {
  const textItems = Array.isArray(value) ? value : [];
  const files = attachments.map((attachment) => {
    const file = attachment as AttachmentInput;
    const filePath = String(file.path || '').trim();
    if (!filePath) return undefined;
    return String(file.mimeType || '').startsWith('image/')
      ? { type: 'localImage', path: filePath }
      : { type: 'mention', name: String(file.name || filePath.split(/[\\/]/).pop() || '附件'), path: filePath };
  }).filter(Boolean);
  return [...textItems, ...files];
}

function normalizeModels(value: unknown): Array<{
  value: string; label: string; efforts: Array<{ value: string; label: string }>;
  effort: string; effortLabel: string; isDefault: boolean;
}> {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const model = asRecord(entry);
    const id = stringValue(model.id) || stringValue(model.model);
    if (!id || model.hidden === true) return undefined;
    const efforts = (Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [])
      .map((entry) => stringValue(asRecord(entry).reasoningEffort))
      .filter(Boolean)
      .map((value) => ({ value, label: effortLabel(value) }));
    const effort = stringValue(model.defaultReasoningEffort) || efforts[0]?.value || '';
    return {
      value: id, label: stringValue(model.displayName) || id, efforts, effort,
      effortLabel: efforts.find((item) => item.value === effort)?.label ?? effort,
      isDefault: model.isDefault === true,
    };
  }).filter((value): value is NonNullable<typeof value> => Boolean(value));
}

function normalizeUsage(value: unknown): AccountUsageInfo | undefined {
  const primary = asRecord(asRecord(asRecord(value).rateLimits).primary);
  if (typeof primary.usedPercent !== 'number') return undefined;
  const percentage = Math.max(0, Math.min(100, Math.round(100 - primary.usedPercent)));
  const resetAt = typeof primary.resetsAt === 'number' ? new Date(primary.resetsAt * 1_000).toISOString() : undefined;
  const period = typeof primary.windowDurationMins === 'number' ? `${primary.windowDurationMins} 分钟` : '当前周期';
  return { available: true, enforced: true, provider: 'OpenAI', percentage, period, resetAt, message: `${period}剩余 ${percentage}%` };
}

function effortLabel(value: string): string {
  return ({ low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: '极高' } as Record<string, string>)[value] ?? value;
}

function isApprovalRequest(method: string): boolean { return method.includes('requestApproval'); }
function asRecord(value: unknown): Record<string, any> { return value && typeof value === 'object' ? value as Record<string, any> : {}; }
function stringValue(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
