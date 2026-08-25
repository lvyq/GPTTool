import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RpcNotification, RpcServerRequest } from '../runtime/line-rpc-client.ts';
import {
  CdpClient,
  type AccountUsageInfo,
  type CdpClientOptions,
  type ComposerPreferences,
} from './cdp-client.ts';
import {
  compatibilityError,
  summarizeCompatibility,
  type OfficialCompatibilityReport,
} from './compatibility.ts';
import { CodexSessionStore, type CodexHistoryItem, type CodexThread, type CodexTurn } from './codex-session-store.ts';
import {
  inspectCodexProvider,
  type CodexProviderStatus,
} from './provider-inspector.ts';
import {
  createOfficialDirectory,
  OfficialAppServerClient,
  probeOfficialAppServerCompatibility,
  readOfficialDirectory,
  setOfficialThreadName,
  type OfficialDirectoryEntry,
  type OfficialAppServerTransport,
} from './thread-metadata-client.ts';
import { loadCdpRules } from './cdp-rules.ts';

export interface CodexServiceOptions {
  executable: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  clientVersion?: string;
  cdpPort?: number;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  sessionCacheDirectory?: string;
  cdpClient?: CdpClient;
  sessionStore?: CodexSessionStore;
  inspectProvider?: (homeDirectory: string) => Promise<CodexProviderStatus>;
  navigate?: (url: string) => Promise<void>;
  pollIntervalMs?: number;
  setThreadName?: (threadId: string, name: string) => Promise<void>;
  createDirectory?: (path: string) => Promise<void>;
  readDirectory?: (path: string) => Promise<{ entries: OfficialDirectoryEntry[] }>;
  officialAppVersion?: string;
  compatibilityCheck?: () => Promise<OfficialCompatibilityReport>;
  appServerClient?: OfficialAppServerTransport | null;
  cdpRulesEndpoint?: string;
}

interface WatchedThread {
  activeTurnId?: string;
  agentItemId?: string;
  agentText: string;
  userItemIds: Set<string>;
  processItems: Map<string, string>;
  officialQueueItemIds: Set<string>;
}

interface PendingThread {
  cwd?: string;
}

interface CodexAttachment {
  path: string;
  name?: string;
  mimeType?: string;
  size?: number;
}

type TurnMode = 'normal' | 'plan' | 'goal';

/**
 * Controls the official ChatGPT/Codex renderer through Chrome DevTools Protocol.
 * Conversation history is read from Codex's local read-only state database so
 * the remote page and the official desktop app observe the same thread data.
 */
export class CodexService {
  readonly #cdp: CdpClient;
  readonly #sessions: CodexSessionStore;
  readonly #appServer?: OfficialAppServerTransport;
  readonly #homeDirectory: string;
  readonly #navigate: (url: string) => Promise<void>;
  readonly #pollIntervalMs: number;
  readonly #notificationListeners = new Set<(notification: RpcNotification) => void>();
  readonly #requestListeners = new Set<(request: RpcServerRequest) => void>();
  readonly #watched = new Map<string, WatchedThread>();
  readonly #pendingThreads = new Map<string, PendingThread>();
  #pollTimer?: NodeJS.Timeout;
  #polling = false;
  #running = false;
  #reconnectPromise?: Promise<void>;
  #autoApprove = false;
  #lastAutoApprovalAt = 0;
  #officialTitles: Record<string, string> = {};
  #officialThreadOrder: string[] = [];
  #officialTitlesReadAt = 0;
  #officialTitlesRequest?: Promise<Record<string, string>>;
  #provider: CodexProviderStatus = {
    id: 'openai', name: 'OpenAI', model: '', wireApi: 'responses', mode: 'official',
    external: false, officialUsageApplies: true, message: '正在使用 OpenAI 官方模型服务',
  };
  #compatibility: OfficialCompatibilityReport = {
    state: 'unknown', mode: 'unknown', features: [], message: '尚未检查官方客户端兼容性',
  };

  constructor(private readonly options: CodexServiceOptions) {
    const home = options.homeDirectory ?? options.env?.HOME ?? process.env.HOME ?? process.env.USERPROFILE ?? '';
    this.#homeDirectory = home;
    this.#cdp = options.cdpClient ?? new CdpClient({ port: options.cdpPort ?? 39252 } satisfies CdpClientOptions);
    this.#sessions = options.sessionStore ?? new CodexSessionStore({
      databasePath: path.join(home, '.codex', 'state_5.sqlite'),
      cacheDirectory: options.sessionCacheDirectory,
    });
    this.#appServer = options.appServerClient === null || (options.cdpClient && !options.appServerClient)
      ? undefined
      : options.appServerClient ?? new OfficialAppServerClient({
          executable: options.executable,
          env: options.env,
          clientVersion: options.clientVersion,
        });
    this.#navigate = options.navigate ?? ((url) => navigateWithCdp(this.#cdp, url));
    this.#pollIntervalMs = options.pollIntervalMs ?? 600;
  }

  get running(): boolean { return this.#running && this.#cdp.connected; }
  get compatibility(): OfficialCompatibilityReport { return this.#compatibility; }

  async start(): Promise<void> {
    if (this.running) return;
    try {
      const rules = await loadCdpRules({
        officialVersion: this.options.officialAppVersion,
        endpoint: this.options.cdpRulesEndpoint,
        cacheDirectory: this.options.sessionCacheDirectory ? path.join(this.options.sessionCacheDirectory, 'adapter') : undefined,
      });
      this.#cdp.setRules?.(rules);
      await this.#cdp.connect();
      this.#cdp.off('disconnect', this.#onDisconnect);
      this.#cdp.off('error', this.#onCdpError);
      this.#cdp.on('disconnect', this.#onDisconnect);
      this.#cdp.on('error', this.#onCdpError);
      // Open the state database now so startup failures are reported before the
      // remote page is exposed. The official client may currently be showing a
      // non-Codex page, so composer discovery is intentionally deferred until a
      // thread is opened or a message is sent.
      await this.#sessions.listThreads(1);
      // app-server is an enhancement channel. Start it silently in the
      // background, but never make CDP messaging unavailable when an older
      // official client does not expose the current protocol.
      await this.#appServer?.connect().catch(() => undefined);
      await this.#refreshProvider();
      this.#running = true;
      if (this.#pollTimer) clearInterval(this.#pollTimer);
      this.#pollTimer = setInterval(() => void this.#pollWatchedThreads(), this.#pollIntervalMs);
    } catch (error) {
      await this.stop();
      throw enrichCdpStartupError(error);
    }
  }

  onNotification(listener: (notification: RpcNotification) => void): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  onServerRequest(listener: (request: RpcServerRequest) => void): () => void {
    this.#requestListeners.add(listener);
    return () => this.#requestListeners.delete(listener);
  }

  respond(_id: number, _result: unknown): void {
    throw new Error('CDP 模式下请在官方 ChatGPT 客户端处理审批和提问');
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    if (!this.running) await this.#ensureRunning();
    const input = asRecord(params) ?? {};
    switch (method) {
      case 'thread/list':
        return { data: await this.#threadsWithOfficialTitles(numberValue(input.limit, 50)), nextCursor: null } as T;
      case 'thread/read':
        return await this.#readThread(
          stringValue(input.threadId),
          input.includeTurns !== false,
          numberValue(input.turnLimit, 120),
        ) as T;
      case 'thread/turns/list': {
        const requested = Math.max(1, Math.min(numberValue(input.limit, 1), 12));
        const thread = await this.#sessions.readThread(requiredId(input.threadId), true, requested + 1);
        return { data: thread.turns?.slice(-numberValue(input.limit, 1)).reverse() ?? [], nextCursor: null } as T;
      }
      case 'thread/start':
        return this.#createPendingThread(stringValue(input.cwd)) as T;
      case 'thread/name/set': {
        const threadId = requiredId(input.threadId);
        const name = requiredThreadName(input.name);
        const renameThread = this.options.setThreadName ?? (this.#appServer
          ? ((id, nextName) => this.#appServer!.request('thread/name/set', { threadId: id, name: nextName }).then(() => undefined))
          : ((id, nextName) => setOfficialThreadName({
              executable: this.options.executable,
              env: this.options.env,
              clientVersion: this.options.clientVersion,
              threadId: id,
              name: nextName,
            })));
        await renameThread(threadId, name);
        this.#officialTitles[threadId] = name;
        this.#officialTitlesReadAt = Date.now();
        this.#emit({ method: 'thread/name/updated', params: { threadId, threadName: name } });
        return { threadId, name } as T;
      }
      case 'fs/createDirectory': {
        const directoryPath = requiredAbsolutePath(input.path);
        const createDirectory = this.options.createDirectory ?? (this.#appServer
          ? ((nextPath) => this.#appServer!.request('fs/createDirectory', { path: nextPath, recursive: true }).then(() => undefined))
          : ((nextPath) => createOfficialDirectory({
              executable: this.options.executable,
              env: this.options.env,
              clientVersion: this.options.clientVersion,
              path: nextPath,
            })));
        await createDirectory(directoryPath);
        return { path: directoryPath } as T;
      }
      case 'fs/readDirectory': {
        const directoryPath = requiredAbsolutePath(input.path);
        const readDirectory = this.options.readDirectory ?? (this.#appServer
          ? ((nextPath) => this.#appServer!.request('fs/readDirectory', { path: nextPath }))
          : ((nextPath) => readOfficialDirectory({
              executable: this.options.executable,
              env: this.options.env,
              clientVersion: this.options.clientVersion,
              path: nextPath,
            })));
        return await readDirectory(directoryPath) as T;
      }
      case 'thread/resume':
        return await this.#resumeThread(requiredId(input.threadId)) as T;
      case 'turn/start':
        return await this.#startTurn(
          requiredId(input.threadId),
          textFromInput(input.input, attachmentPaths(input.attachments).length > 0),
          attachmentPaths(input.attachments),
          turnMode(input.mode),
        ) as T;
      case 'turn/steer':
        return await this.#steerTurn(requiredId(input.threadId), requiredId(input.expectedTurnId), textFromInput(input.input)) as T;
      case 'turn/interrupt':
        await this.#cdp.interrupt();
        return {} as T;
      case 'approval/auto/get':
        return { enabled: this.#autoApprove } as T;
      case 'approval/auto/set':
        this.#autoApprove = input.enabled === true;
        return { enabled: this.#autoApprove } as T;
      case 'composer/preferences/get':
        await this.#refreshProvider();
        if (this.#provider.external) return providerComposerPreferences(this.#provider) as T;
        try {
          return await this.#composerPreferences() as T;
        } catch (error) {
          if (!this.#provider.external) throw error;
          return providerComposerPreferences(this.#provider) as T;
        }
      case 'composer/preferences/set':
        await this.#refreshProvider();
        try {
          return await this.#cdp.setComposerPreferences({
            model: stringValue(input.model) || undefined,
            effort: stringValue(input.effort) || undefined,
          }) as T;
        } catch (error) {
          if (!this.#provider.external) throw error;
          throw new Error(`${this.#provider.name} 的模型与推理强度由 Codex Provider 或中转工具管理；修改后请重新启动官方客户端`);
        }
      case 'account/usage/get':
        await this.#refreshProvider();
        if (!this.#provider.officialUsageApplies) {
          return {
            available: false,
            enforced: false,
            provider: this.#provider.name,
            message: this.#provider.message,
          } as T;
        }
        return await this.#accountUsage() as T;
      case 'provider/status/get':
        await this.#refreshProvider();
        return this.#provider as T;
      case 'compatibility/status/get':
        return this.#compatibility as T;
      default:
        throw new Error(`CDP 模式暂不支持 ${method}`);
    }
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
    this.#watched.clear();
    this.#pendingThreads.clear();
    this.#cdp.off('disconnect', this.#onDisconnect);
    this.#cdp.off('error', this.#onCdpError);
    await this.#cdp.close().catch(() => undefined);
    await this.#appServer?.close().catch(() => undefined);
  }

  /**
   * Runs a capability handshake against both the official renderer and stable
   * app-server surface. No message is sent and no task is persisted.
   */
  async verifyCompatibility(directory = this.options.cwd || this.#homeDirectory): Promise<OfficialCompatibilityReport> {
    if (!this.running) await this.#ensureRunning();
    this.#compatibility = { state: 'checking', mode: 'unknown', features: [], message: '正在检查官方 ChatGPT 兼容性…' };
    if (this.options.compatibilityCheck) {
      this.#compatibility = await this.options.compatibilityCheck();
    } else {
      const [renderer, appServer] = await Promise.all([
        this.#cdp.compatibilitySnapshot().catch(() => ({
          runtimeVersion: undefined,
          mainWindow: false, runtime: false, composer: false, submitControl: false,
          modelControl: false, usageControl: false, taskMetadata: false,
        })),
        (this.#appServer?.probe(directory) ?? probeOfficialAppServerCompatibility({
          executable: this.options.executable, env: this.options.env,
          clientVersion: this.options.clientVersion, directory,
        })).catch(() => ({
          runtimeVersion: undefined,
          initialized: false, threads: false, models: false, usage: false, directories: false,
        })),
      ]);
      this.#compatibility = summarizeCompatibility([
        { id: 'main-window', label: '官方主窗口', required: true, available: renderer.mainWindow },
        { id: 'renderer-runtime', label: 'CDP 后台连接', required: true, available: renderer.runtime },
        // Composer controls only exist after a task is opened. Testing them at
        // startup would visibly operate ChatGPT, so actual validation is
        // deferred to the user's first open/send action.
        { id: 'composer', label: '消息输入框（使用时检测）', required: false, available: true, detail: 'deferred' },
        { id: 'submit', label: '消息发送控件（使用时检测）', required: false, available: true, detail: 'deferred' },
        // Older official clients may not expose the current app-server schema.
        // GPTTool can still send and observe turns through CDP + the local
        // read-only session store, so these are enhancements, not core gates.
        { id: 'app-server', label: '新版 Codex 接口', required: false, available: appServer.initialized },
        { id: 'threads', label: '新版任务接口', required: false, available: appServer.threads },
        { id: 'models', label: '模型设置', required: false, available: appServer.models },
        { id: 'usage', label: '剩余用量', required: false, available: appServer.usage },
        { id: 'directories', label: '项目目录', required: false, available: appServer.directories },
        { id: 'task-metadata', label: '官方任务标题', required: false, available: appServer.threads || renderer.taskMetadata },
      ], {
        officialAppVersion: this.options.officialAppVersion,
        runtimeVersion: appServer.runtimeVersion || renderer.runtimeVersion,
      });
    }
    if (this.#compatibility.state === 'incompatible') throw compatibilityError(this.#compatibility);
    return this.#compatibility;
  }

  async #refreshProvider(): Promise<CodexProviderStatus> {
    this.#provider = await (this.options.inspectProvider ?? inspectCodexProvider)(this.#homeDirectory);
    return this.#provider;
  }

  async #readThread(threadId: string, includeTurns: boolean, turnLimit = 120): Promise<{ thread: CodexThread }> {
    if (this.#pendingThreads.has(threadId)) {
      return { thread: pendingThread(threadId, this.#pendingThreads.get(threadId)?.cwd) };
    }
    const thread = await this.#withOfficialTitle(await this.#sessions.readThread(threadId, includeTurns, turnLimit));
    if (includeTurns) this.#primeWatcher(thread);
    return { thread };
  }

  #createPendingThread(cwd?: string): { thread: CodexThread } {
    const id = `new:${randomUUID()}`;
    this.#pendingThreads.set(id, { cwd });
    return { thread: pendingThread(id, cwd) };
  }

  async #resumeThread(threadId: string): Promise<{ thread: CodexThread }> {
    if (this.#pendingThreads.has(threadId)) return this.#readThread(threadId, true, 12);
    let thread = await this.#sessions.readThread(threadId, true, 12);
    try {
      await this.#navigate(`codex://threads/${encodeURIComponent(threadId)}`);
      await this.#cdp.waitForComposer();
    } catch (cdpError) {
      if (!this.#appServer) throw cdpError;
      await this.#appServer.request('thread/resume', { threadId }).catch((appServerError) => {
        const message = appServerError instanceof Error ? appServerError.message : String(appServerError);
        throw new Error(`官方界面无法打开任务，独立服务恢复也失败：${message}`);
      });
    }
    thread = await this.#withOfficialTitle(thread);
    this.#primeWatcher(thread);
    return { thread };
  }

  async #threadsWithOfficialTitles(limit: number): Promise<CodexThread[]> {
    const threads = await this.#sessions.listThreads(limit);
    const titles = await this.#cachedOfficialTitles();
    const order = new Map(this.#officialThreadOrder.map((id, index) => [id, index]));
    return threads
      .map((thread) => applyOfficialTitle(thread, titles[thread.id]))
      .sort((left, right) => {
        const leftIndex = order.get(left.id);
        const rightIndex = order.get(right.id);
        if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex;
        if (leftIndex !== undefined) return -1;
        if (rightIndex !== undefined) return 1;
        return right.updatedAt - left.updatedAt;
      });
  }

  async #withOfficialTitle(thread: CodexThread): Promise<CodexThread> {
    const titles = await this.#cachedOfficialTitles();
    return applyOfficialTitle(thread, titles[thread.id]);
  }

  async #cachedOfficialTitles(): Promise<Record<string, string>> {
    if (Date.now() - this.#officialTitlesReadAt < 5_000) return this.#officialTitles;
    this.#officialTitlesRequest ??= this.#readOfficialTitles()
      .then((titles) => {
        this.#officialTitles = titles;
        this.#officialTitlesReadAt = Date.now();
        return titles;
      })
      .catch(() => this.#officialTitles)
      .finally(() => { this.#officialTitlesRequest = undefined; });
    return this.#officialTitlesRequest;
  }

  async #readOfficialTitles(): Promise<Record<string, string>> {
    if (this.#appServer) {
      const response = await this.#appServer.request<{ data?: Array<{ id?: string; name?: string }> }>(
        'thread/list', { limit: 100 },
      ).catch(() => undefined);
      if (response?.data?.length) {
        this.#officialThreadOrder = response.data.flatMap((thread) => thread.id ? [thread.id] : []);
        return Object.fromEntries(response.data
          .filter((thread) => thread.id && thread.name)
          .map((thread) => [thread.id!, thread.name!]));
      }
    }
    this.#officialThreadOrder = [];
    return this.#cdp.threadTitles();
  }

  async #composerPreferences(): Promise<ComposerPreferences> {
    const renderer = await this.#cdp.visibleComposerPreference().catch(() => undefined);
    const officialModels = this.#appServer
      ? await this.#appServer.request<{ data?: unknown[] }>('model/list', {}).catch(() => undefined)
      : undefined;
    const models = normalizeAppServerModels(officialModels?.data);
    if (renderer) {
      if (!models.length) {
        const preferences = await this.#cdp.composerPreferences().catch(() => renderer);
        return { ...preferences, source: 'official-renderer', synchronized: true };
      }
      // app-server exposes stable protocol ids (for example gpt-5.6-sol), while
      // the renderer picker accepts the human-facing label currently visible
      // in ChatGPT. Keep the renderer's values so applying a preference remains
      // synchronized with the official UI, and enrich only its capabilities
      // from app-server.
      const rendererModels = renderer.models.length ? renderer.models : models.map((model) => ({
        ...model,
        // The official picker accepts its visible label, not app-server's
        // internal protocol id.
        value: model.label,
      }));
      const mergedModels = rendererModels.map((rendererModel) => {
        const official = models.find((model) => modelMatchesRenderer(model, rendererModel));
        return official ? {
          ...rendererModel,
          efforts: official.efforts.length ? official.efforts : rendererModel.efforts,
          effort: rendererModel.effort || official.effort,
          effortLabel: rendererModel.effortLabel || official.effortLabel,
        } : rendererModel;
      });
      const rendererCurrent = { value: renderer.model, label: renderer.model };
      const current = mergedModels.find((model) => modelMatchesRenderer(model, rendererCurrent));
      const currentEfforts = current?.efforts.length
        ? current.efforts
        : renderer.efforts.length
          ? renderer.efforts
          : renderer.effort
            ? [{ value: renderer.effort, label: renderer.effortLabel || reasoningEffortLabel(renderer.effort) }]
            : [];
      const synchronizedModels = current
        ? mergedModels.map((model) => model === current ? {
            ...model,
            efforts: currentEfforts,
            effort: renderer.effort || model.effort,
            effortLabel: renderer.effortLabel || model.effortLabel,
          } : model)
        : [{
            value: renderer.model,
            label: renderer.model,
            efforts: currentEfforts,
            effort: renderer.effort,
            effortLabel: renderer.effortLabel,
          }, ...mergedModels];
      return {
        ...renderer,
        models: synchronizedModels,
        efforts: currentEfforts,
        source: 'official-renderer',
        synchronized: true,
      };
    }
    const selected = models.find((model) => model.isDefault) ?? models[0];
    if (!selected) throw new Error('官方客户端暂未提供模型信息');
    const effort = selected.effort || selected.efforts[0]?.value || '';
    return {
      model: selected.value,
      effort,
      effortLabel: selected.efforts.find((item) => item.value === effort)?.label ?? effort,
      models,
      efforts: selected.efforts,
      source: 'app-server-default',
      synchronized: false,
    };
  }

  async #accountUsage(): Promise<AccountUsageInfo> {
    if (this.#appServer) {
      const response = await this.#appServer.request('account/rateLimits/read', {}).catch(() => undefined);
      const usage = normalizeAppServerUsage(response);
      if (usage) return usage;
    }
    return this.#cdp.usageInfo();
  }

  async #startTurn(threadId: string, text: string, attachments: CodexAttachment[] = [], mode: TurnMode = 'normal'): Promise<{ threadId: string; turn: { id: string; status: 'inProgress' } }> {
    const pending = this.#pendingThreads.get(threadId);
    const previousNewestThreadId = pending ? (await this.#sessions.listThreads(1))[0]?.id ?? '' : '';
    const submittedAt = Date.now() - 1_000;
    const previousTurnIds = new Set<string>();
    let canonicalThreadId = threadId;
    let current: CodexThread | undefined;
    if (!pending) {
      current = await this.#sessions.readThread(threadId, true, 8);
      for (const turn of current.turns ?? []) previousTurnIds.add(turn.id);
      this.#primeWatcher(current);
    }
    // Only fall back before the renderer submit call. Once submitText starts,
    // its result is ambiguous during a weak connection and retrying through
    // app-server could create a duplicate message.
    try {
      if (pending) {
        const url = new URL('codex://threads/new');
        if (pending.cwd) url.searchParams.set('path', pending.cwd);
        await this.#navigate(url.toString());
      } else {
        await this.#navigate(`codex://threads/${encodeURIComponent(threadId)}`);
      }
      await this.#cdp.waitForComposer();
      await this.#cdp.prepareTurnMode(mode);
      await this.#cdp.attachFiles(attachments.map((attachment) => attachment.path));
    } catch (cdpError) {
      return await this.#startTurnWithAppServer(threadId, text, attachments, mode, pending, current, cdpError);
    }
    await this.#cdp.submitText(text);

    if (pending) {
      const created = await this.#waitForNewThread(submittedAt, previousNewestThreadId);
      if (!created) throw new Error('消息已交给官方客户端，但没有检测到新任务，请在桌面端确认发送状态');
      canonicalThreadId = created.id;
      this.#pendingThreads.delete(threadId);
      this.#primeWatcher(created);
    }

    const turnId = await this.#waitForActiveTurn(canonicalThreadId, previousTurnIds);
    if (!turnId) throw new Error('官方 ChatGPT 没有确认消息发送成功，请检查附件是否仍在官方输入框中后重试');
    this.#emit({ method: 'turn/started', params: { threadId: canonicalThreadId, turn: { id: turnId, status: 'inProgress' } } });
    return { threadId: canonicalThreadId, turn: { id: turnId, status: 'inProgress' } };
  }

  async #startTurnWithAppServer(
    requestedThreadId: string,
    text: string,
    attachments: CodexAttachment[],
    mode: TurnMode,
    pending: PendingThread | undefined,
    current: CodexThread | undefined,
    cdpError: unknown,
  ): Promise<{ threadId: string; turn: { id: string; status: 'inProgress' } }> {
    if (!this.#appServer) throw cdpError;
    try {
      let threadId = requestedThreadId;
      if (pending) {
        const started = await this.#appServer.request<{ thread?: { id?: string } }>('thread/start', {
          cwd: pending.cwd || this.options.cwd || this.#homeDirectory,
        });
        threadId = requiredId(started?.thread?.id);
        this.#pendingThreads.delete(requestedThreadId);
      } else {
        await this.#appServer.request('thread/resume', { threadId });
      }
      const input: Array<Record<string, unknown>> = [];
      if (text) input.push({ type: 'text', text });
      for (const attachment of attachments) {
        input.push(attachment.mimeType?.startsWith('image/')
          ? { type: 'localImage', path: attachment.path }
          : { type: 'mention', name: attachment.name || path.basename(attachment.path), path: attachment.path });
      }
      const response = await this.#appServer.request<{ turn?: { id?: string } }>('turn/start', {
        threadId,
        input,
        mode,
      });
      const turnId = requiredId(response?.turn?.id);
      if (current) this.#primeWatcher(current);
      this.#emit({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' }, transport: 'app-server' } });
      return { threadId, turn: { id: turnId, status: 'inProgress' } };
    } catch (appServerError) {
      const rendererMessage = cdpError instanceof Error ? cdpError.message : String(cdpError);
      const serverMessage = appServerError instanceof Error ? appServerError.message : String(appServerError);
      throw new Error(`官方客户端界面通道不可用（${rendererMessage}），app-server 降级也失败（${serverMessage}）`);
    }
  }

  async #steerTurn(threadId: string, turnId: string, text: string): Promise<{ threadId: string; turnId: string }> {
    await this.#navigate(`codex://threads/${encodeURIComponent(threadId)}`);
    await this.#cdp.submitText(text);
    return { threadId, turnId };
  }

  async #waitForNewThread(afterMs: number, previousNewestThreadId: string): Promise<CodexThread | undefined> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const thread = await this.#sessions.newestThreadAfter(afterMs, previousNewestThreadId);
      if (thread) return thread;
      await delay(200);
    }
    return undefined;
  }

  async #waitForActiveTurn(threadId: string, previousTurnIds: ReadonlySet<string>): Promise<string | undefined> {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const thread = await this.#sessions.readThread(threadId, true, 2);
      // The official state database can update several seconds after the JSONL
      // rollout. A newly observed turn id is authoritative confirmation that
      // the message was accepted, even while the database timestamp is stale.
      const turn = findLastTurn(thread.turns, (candidate) => !previousTurnIds.has(candidate.id));
      if (turn) return turn.id;
      await delay(180);
    }
    return undefined;
  }

  #primeWatcher(thread: CodexThread): void {
    const lastTurn = thread.turns?.at(-1);
    const agent = lastTurn?.items.filter((item) => item.type === 'agentMessage').at(-1);
    this.#watched.set(thread.id, {
      activeTurnId: lastTurn?.status === 'inProgress' ? lastTurn.id : undefined,
      agentItemId: agent?.id,
      agentText: agent?.text ?? '',
      userItemIds: new Set(thread.turns?.flatMap((turn) => turn.items.filter((item) => item.type === 'userMessage').map((item) => item.id)) ?? []),
      processItems: new Map((lastTurn?.items ?? []).filter(isProcessItem).map((item) => [item.id, JSON.stringify(item)])),
      officialQueueItemIds: new Set(),
    });
  }

  async #pollWatchedThreads(): Promise<void> {
    if (this.#polling || !this.running) return;
    this.#polling = true;
    try {
      await this.#autoApproveVisibleRequest();
      for (const [threadId, previous] of this.#watched) {
        let thread: CodexThread;
        try { thread = await this.#sessions.readThread(threadId, true, 1); } catch { continue; }
        this.#publishThreadChanges(thread, previous);
      }
    } finally {
      this.#polling = false;
    }
  }

  async #autoApproveVisibleRequest(): Promise<void> {
    if (!this.#autoApprove || Date.now() - this.#lastAutoApprovalAt < 1_500) return;
    const result: { approved: boolean; label?: string } = await this.#cdp.approveVisibleRequest().catch(() => ({ approved: false }));
    if (!result.approved) return;
    this.#lastAutoApprovalAt = Date.now();
    this.#emit({ method: 'approval/auto/approved', params: { label: result.label || '批准' } });
  }

  #publishThreadChanges(thread: CodexThread, previous: WatchedThread): void {
    const lastTurn = thread.turns?.at(-1);
    if (!lastTurn) return;
    const currentActiveId = lastTurn.status === 'inProgress' ? lastTurn.id : undefined;
    if (currentActiveId && currentActiveId !== previous.activeTurnId) {
      this.#emit({ method: 'turn/started', params: { threadId: thread.id, turn: { id: currentActiveId, status: 'inProgress' } } });
    }
    for (const user of lastTurn.items.filter((item) => item.type === 'userMessage')) {
      if (previous.userItemIds.has(user.id)) continue;
      previous.userItemIds.add(user.id);
      if (previous.activeTurnId && currentActiveId === previous.activeTurnId) {
        previous.officialQueueItemIds.add(user.id);
        this.#emit({
          method: 'official/queue/updated',
          params: {
            threadId: thread.id,
            items: [...previous.officialQueueItemIds].map((id) => {
              const item = lastTurn.items.find((candidate) => candidate.id === id && candidate.type === 'userMessage');
              return item ? {
                id: `official:${id}`,
                threadId: thread.id,
                text: historyItemText(item),
                attachments: historyItemAttachments(item),
                createdAt: Date.now(),
                status: 'queued',
                source: 'official',
                readOnly: true,
              } : undefined;
            }).filter(Boolean),
          },
        });
      }
      this.#emit({ method: 'item/completed', params: { threadId: thread.id, turnId: lastTurn.id, item: user } });
    }
    for (const item of lastTurn.items.filter(isProcessItem)) {
      const signature = JSON.stringify(item);
      const previousSignature = previous.processItems.get(item.id);
      if (previousSignature === signature) continue;
      previous.processItems.set(item.id, signature);
      this.#emit({
        method: previousSignature ? 'item/completed' : 'item/started',
        params: { threadId: thread.id, turnId: lastTurn.id, item },
      });
    }
    const agent = lastTurn.items.filter((item) => item.type === 'agentMessage').at(-1);
    if (agent) {
      const text = agent.text ?? '';
      if (agent.id !== previous.agentItemId) {
        previous.agentItemId = agent.id;
        previous.agentText = '';
        this.#emit({ method: 'item/started', params: { threadId: thread.id, turnId: lastTurn.id, item: { ...agent, text: '', status: 'inProgress' } } });
      }
      if (text !== previous.agentText) {
        if (text.startsWith(previous.agentText)) {
          const delta = text.slice(previous.agentText.length);
          if (delta) this.#emit({ method: 'item/agentMessage/delta', params: { threadId: thread.id, turnId: lastTurn.id, itemId: agent.id, delta } });
        } else {
          this.#emit({ method: 'item/completed', params: { threadId: thread.id, turnId: lastTurn.id, item: agent } });
        }
        previous.agentText = text;
      }
    }
    if (previous.activeTurnId && !currentActiveId) {
      if (agent) this.#emit({ method: 'item/completed', params: { threadId: thread.id, turnId: lastTurn.id, item: { ...agent, status: 'completed' } } });
      this.#emit({ method: 'turn/completed', params: { threadId: thread.id, turn: lastTurn } });
      if (previous.officialQueueItemIds.size) {
        previous.officialQueueItemIds.clear();
        this.#emit({ method: 'official/queue/updated', params: { threadId: thread.id, items: [] } });
      }
    }
    previous.activeTurnId = currentActiveId;
  }

  #emit(notification: RpcNotification): void {
    for (const listener of this.#notificationListeners) listener(notification);
  }

  #onDisconnect = (): void => {
    this.#running = false;
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
  };

  #onCdpError = (): void => {
    // WebSocket close handling updates service state. Individual command errors
    // are returned to their caller and should not terminate the desktop app.
  };

  async #ensureRunning(): Promise<void> {
    if (this.running) return;
    this.#reconnectPromise ??= this.start().finally(() => { this.#reconnectPromise = undefined; });
    await this.#reconnectPromise;
    if (!this.running) throw new Error('Codex CDP 服务尚未运行');
  }
}

function modelMatchesRenderer(
  official: { value: string; label: string },
  renderer: { value: string; label: string },
): boolean {
  const normalized = (value: string) => value.toLowerCase().replace(/^gpt[-\s]*/i, '').replace(/[^a-z0-9]+/g, '');
  const officialKeys = new Set([normalized(official.value), normalized(official.label)]);
  return [renderer.value, renderer.label].some((value) => officialKeys.has(normalized(value)));
}

function requiredThreadName(value: unknown): string {
  const name = stringValue(value).trim();
  if (!name) throw new Error('任务名称不能为空');
  if (name.length > 200) throw new Error('任务名称不能超过 200 个字符');
  return name;
}

function requiredAbsolutePath(value: unknown): string {
  const nextPath = stringValue(value).trim();
  if (!path.isAbsolute(nextPath)) throw new Error('项目目录必须是本机绝对路径');
  return path.normalize(nextPath);
}

function isProcessItem(item: { type?: string }): boolean {
  return ['reasoning', 'commandExecution', 'fileChange', 'mcpToolCall', 'plan'].includes(item.type ?? '');
}

async function navigateWithCdp(cdp: CdpClient, url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'codex:' || parsed.hostname !== 'threads') throw new Error('不支持的 Codex 后台导航地址');
  const route = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  const opened = route === 'new' ? await cdp.openNewThread() : await cdp.openThread(route);
  if (!opened) throw new Error(route === 'new' ? '没有在官方 ChatGPT 中找到“新建任务”入口' : '官方 ChatGPT 任务列表中没有找到此任务');
  await delay(180);
}

function pendingThread(id: string, cwd = ''): CodexThread {
  const now = Date.now();
  return { id, name: '新任务', preview: '新任务', cwd, createdAt: now, updatedAt: now, status: { type: 'idle' }, turns: [] };
}

function textFromInput(value: unknown, allowEmpty = false): string {
  if (!Array.isArray(value)) {
    if (allowEmpty) return '';
    throw new Error('消息内容不能为空');
  }
  const text = value.map((part) => stringValue(asRecord(part)?.text)).filter(Boolean).join('\n').trim();
  if (!text && !allowEmpty) throw new Error('消息内容不能为空');
  return text;
}

function historyItemText(item: CodexHistoryItem): string {
  if (item.text?.trim()) return item.text.trim();
  return (item.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text?.trim() ?? '')
    .filter(Boolean)
    .join('\n');
}

function historyItemAttachments(item: CodexHistoryItem): Array<{
  id: string;
  name: string;
  mimeType: string;
  imageUrl?: string;
}> {
  return (item.content ?? []).flatMap((part, index) => {
    if (part.type !== 'attachment') return [];
    return [{
      id: `official:${item.id}:${index}`,
      name: part.name || `附件 ${index + 1}`,
      mimeType: part.mimeType || 'application/octet-stream',
      ...(part.imageUrl ? { imageUrl: part.imageUrl } : {}),
    }];
  });
}

function attachmentPaths(value: unknown): CodexAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    return {
      path: stringValue(record?.path),
      name: stringValue(record?.name) || undefined,
      mimeType: stringValue(record?.mimeType) || undefined,
      size: typeof record?.size === 'number' ? record.size : undefined,
    };
  }).filter((attachment) => path.isAbsolute(attachment.path));
}

function turnMode(value: unknown): TurnMode {
  return value === 'plan' || value === 'goal' ? value : 'normal';
}

function requiredId(value: unknown): string {
  const id = stringValue(value).trim();
  if (!id) throw new Error('任务 ID 不能为空');
  return id;
}

function numberValue(value: unknown, fallback: number): number {
  return Number.isInteger(value) ? Number(value) : fallback;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function normalizeEpoch(value: number): number {
  return value > 10_000_000_000 ? value : value * 1000;
}

function findLastTurn(turns: CodexTurn[] | undefined, predicate: (turn: CodexTurn) => boolean): CodexTurn | undefined {
  for (let index = (turns?.length ?? 0) - 1; index >= 0; index -= 1) {
    const turn = turns?.[index];
    if (turn && predicate(turn)) return turn;
  }
  return undefined;
}

function enrichCdpStartupError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch failed|ECONNREFUSED|discovery/i.test(message)) {
    return new Error('官方 ChatGPT 没有启用 CDP。请完全退出 ChatGPT，然后重新点击“启动 Codex 控制”，GPTTool 会以受控模式重新打开。');
  }
  return error instanceof Error ? error : new Error(message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function applyOfficialTitle(thread: CodexThread, title: string | undefined): CodexThread {
  const normalized = String(title || '').replace(/\s+/g, ' ').trim();
  return normalized ? { ...thread, name: normalized, preview: normalized } : thread;
}

function providerComposerPreferences(provider: CodexProviderStatus): {
  model: string;
  effort: string;
  effortLabel: string;
  models: Array<{ value: string; label: string; efforts: [] }>;
  efforts: [];
  provider: CodexProviderStatus;
  readOnly: true;
  source: 'provider';
  synchronized: true;
} {
  const model = provider.model || provider.name;
  return {
    model,
    effort: '',
    effortLabel: '由中转服务管理',
    models: [{ value: model, label: model, efforts: [] }],
    efforts: [],
    provider,
    readOnly: true,
    source: 'provider',
    synchronized: true,
  };
}

function normalizeAppServerModels(value: unknown): Array<{
  value: string;
  label: string;
  efforts: Array<{ value: string; label: string }>;
  effort: string;
  effortLabel: string;
  isDefault: boolean;
}> {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const model = asRecord(entry);
    const protocolValue = stringValue(model?.id) || stringValue(model?.model);
    if (!protocolValue || model?.hidden === true) return undefined;
    const label = stringValue(model?.displayName) || protocolValue;
    const efforts = (Array.isArray(model?.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [])
      .map((item) => {
        const effort = asRecord(item);
        const nextValue = stringValue(effort?.reasoningEffort);
        return nextValue ? { value: nextValue, label: reasoningEffortLabel(nextValue) } : undefined;
      })
      .filter((item): item is { value: string; label: string } => Boolean(item));
    const selectedEffort = stringValue(model?.defaultReasoningEffort) || efforts[0]?.value || '';
    return {
      value: label,
      label,
      efforts,
      effort: selectedEffort,
      effortLabel: efforts.find((item) => item.value === selectedEffort)?.label ?? selectedEffort,
      isDefault: model?.isDefault === true,
    };
  }).filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function normalizeAppServerUsage(value: unknown): AccountUsageInfo | undefined {
  const root = asRecord(value);
  const rateLimits = asRecord(root?.rateLimits);
  const primary = asRecord(rateLimits?.primary);
  const usedPercent = typeof primary?.usedPercent === 'number' ? primary.usedPercent : undefined;
  if (usedPercent === undefined) return undefined;
  const percentage = Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
  const duration = typeof primary?.windowDurationMins === 'number' ? primary.windowDurationMins : undefined;
  const resetSeconds = typeof primary?.resetsAt === 'number' ? primary.resetsAt : undefined;
  const period = duration ? usagePeriodLabel(duration) : '当前周期';
  const resetAt = resetSeconds ? new Date(resetSeconds * 1_000).toISOString() : undefined;
  return {
    available: true,
    percentage,
    period,
    resetAt,
    enforced: true,
    provider: 'OpenAI',
    message: `${period}剩余 ${percentage}%${resetAt ? `，${new Date(resetAt).toLocaleString('zh-CN')} 重置` : ''}`,
  };
}

function reasoningEffortLabel(value: string): string {
  return ({ low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: '极高' } as Record<string, string>)[value] ?? value;
}

function usagePeriodLabel(minutes: number): string {
  if (minutes % 10_080 === 0) return `${minutes / 10_080} 周`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}
