import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, readFile, writeFile, mkdir, rm, rename, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir, networkInterfaces } from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { RpcNotification, RpcServerRequest } from '../runtime/line-rpc-client.ts';

export interface CodexBridge {
  request<T>(method: string, params?: unknown): Promise<T>;
  respond(id: number, result: unknown): void;
  onNotification(listener: (notification: RpcNotification) => void): () => void;
  onServerRequest(listener: (request: RpcServerRequest) => void): () => void;
}

export interface RemoteCodexServerOptions {
  codex: CodexBridge;
  assetsDirectory: string;
  stateDirectory: string;
  port?: number;
  allowLan?: boolean;
  defaultCwd?: string;
  directoryRoot?: string;
  onPersistentStateChange?: (kind: string, key: string, value: unknown) => void;
}

interface ClientRequest {
  id: number;
  type: string;
  threadId?: string;
  turnId?: string;
  text?: string;
  cwd?: string;
  path?: string;
  requestId?: number;
  decision?: 'accept' | 'decline';
  answers?: Record<string, { answers: string[] }>;
  queueId?: string;
  toIndex?: number;
  enabled?: boolean;
  model?: string;
  effort?: string;
  speed?: string;
  mode?: string;
  clientRequestId?: string;
  attachmentIds?: string[];
  itemId?: string;
  attachmentIndex?: number;
  offset?: number;
  limit?: number;
  uploadId?: string;
  name?: string;
  mimeType?: string;
  size?: number;
  index?: number;
  data?: string;
}

interface AttachmentDescriptor {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

interface UploadedAttachment extends AttachmentDescriptor {
  path: string;
  received: number;
  nextIndex: number;
  ready: boolean;
  updatedAt: number;
}

interface QueuedTurn {
  id: string;
  threadId: string;
  text: string;
  createdAt: number;
  status: 'queued' | 'starting';
  mode?: TurnMode;
  attachmentIds?: string[];
  attachments?: AttachmentDescriptor[];
}

type TurnMode = 'normal' | 'plan' | 'goal';

interface QueueSnapshot {
  threadId: string;
  activeTurnId: string | null;
  items: QueuedTurn[];
}

interface ThreadQueueState {
  activeTurnId: string | null;
  items: QueuedTurn[];
  starting: boolean;
  draining: boolean;
  blockedAfterError: boolean;
  polling: boolean;
  watcher?: NodeJS.Timeout;
}

interface AccountUsageSnapshot {
  available: boolean;
  enforced: boolean;
  provider?: string;
  percentage?: number;
  period?: string;
  resetAt?: string;
  message: string;
}

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/remote.js', ['remote.js', 'text/javascript; charset=utf-8']],
  ['/remote.css', ['remote.css', 'text/css; charset=utf-8']],
  ['/gpttool-logo.png', ['gpttool-logo.png', 'image/png']],
  ['/apple-touch-icon.png', ['apple-touch-icon.png', 'image/png']],
] as const);

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
]);

const MAX_QUEUED_TURNS_PER_THREAD = 50;
const MAX_TURN_TEXT_LENGTH = 100_000;
const MAX_ATTACHMENTS_PER_TURN = 5;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_UPLOADS = 20;
const MAX_UPLOAD_CHUNK_BYTES = 96 * 1024;
const QUEUE_WATCH_INTERVAL_MS = 1_750;
const USAGE_POLL_INTERVAL_MS = 30_000;
const IDEMPOTENT_TURN_TTL_MS = 15 * 60 * 1000;
const MAX_IDEMPOTENT_TURN_REQUESTS = 500;

export class RemoteCodexServer {
  #server?: Server;
  #webSockets?: WebSocketServer;
  #token = '';
  #port = 0;
  #unsubscribeNotification?: () => void;
  #unsubscribeServerRequest?: () => void;
  #pendingApprovals = new Map<number, string>();
  #pendingUserInputs = new Set<number>();
  #loadedThreadIds = new Set<string>();
  #turnQueues = new Map<string, ThreadQueueState>();
  #uploads = new Map<string, UploadedAttachment>();
  #activeTurnAttachments = new Map<string, string[]>();
  #idempotentTurnRequests = new Map<string, { createdAt: number; promise: Promise<unknown> }>();
  #attachmentPreviews = new Map<string, Map<string, string>>();
  #autoApprovalEnabled = false;
  #queuePersistChain: Promise<void> = Promise.resolve();
  #usageSnapshot?: AccountUsageSnapshot;
  #usageCheckedAt = 0;
  #usageRefresh?: Promise<AccountUsageSnapshot>;
  #usagePollTimer?: NodeJS.Timeout;
  #composerSnapshot?: unknown;
  #composerRefresh?: Promise<unknown>;
  #officialSettingsChain: Promise<void> = Promise.resolve();
  #threadIndexSnapshot?: unknown;
  #threadIndexRefresh?: Promise<unknown>;

  constructor(private readonly options: RemoteCodexServerOptions) {}

  get running(): boolean { return Boolean(this.#server?.listening); }
  get token(): string { return this.#token; }
  get port(): number { return this.#port; }

  get accessUrls(): string[] {
    if (!this.running) return [];
    const hosts = this.options.allowLan === false ? ['127.0.0.1'] : ['127.0.0.1', ...privateIpv4Addresses()];
    return [...new Set(hosts)].map((host) => `http://${host}:${this.#port}/?token=${encodeURIComponent(this.#token)}`);
  }

  async start(): Promise<void> {
    if (this.running) return;
    await mkdir(this.#uploadDirectory(), { recursive: true });
    await this.#loadQueuePersistence();
    await this.#loadThreadIndexCache();
    this.#token = await this.#loadOrCreateToken();
    this.#autoApprovalEnabled = await this.#loadAutoApprovalPreference();
    this.options.onPersistentStateChange?.('preferences', 'approval', { autoApprovalEnabled: this.#autoApprovalEnabled });
    if (this.#autoApprovalEnabled) await this.options.codex.request('approval/auto/set', { enabled: true });
    this.#server = createServer((request, response) => void this.#serveHttp(request, response));
    this.#webSockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
    this.#server.on('upgrade', (request, socket, head) => {
      if (request.url !== '/ws' || !this.#authenticated(request)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.#webSockets?.handleUpgrade(request, socket, head, (client) => {
        this.#webSockets?.emit('connection', client, request);
      });
    });
    this.#webSockets.on('connection', (client) => {
      client.on('message', (data) => void this.#handleMessage(client, data.toString()));
      if (this.#usageSnapshot) this.#send(client, { type: 'usage.updated', ...this.#usageSnapshot, cached: true });
      if (this.#composerSnapshot) this.#send(client, { type: 'preferences.updated', result: this.#composerSnapshot, cached: true });
    });
    this.#unsubscribeNotification = this.options.codex.onNotification((notification) => {
      this.#broadcast({ type: 'event', method: notification.method, params: notification.params });
      this.#trackTurnNotification(notification);
    });
    this.#unsubscribeServerRequest = this.options.codex.onServerRequest((request) => {
      if (APPROVAL_METHODS.has(request.method)) this.#pendingApprovals.set(request.id, request.method);
      if (request.method === 'item/tool/requestUserInput') this.#pendingUserInputs.add(request.id);
      this.#broadcast({ type: 'serverRequest', request });
    });
    const host = this.options.allowLan === false ? '127.0.0.1' : '0.0.0.0';
    await this.#listenOnAvailablePort(host);
    const address = this.#server.address();
    this.#port = typeof address === 'object' && address ? address.port : (this.options.port ?? 8518);
    for (const [threadId, state] of this.#turnQueues) {
      if (!state.items.length) continue;
      this.#broadcastQueue(threadId);
    }
    void this.#refreshComposerPreferences().catch(() => undefined);
    void this.#readAccountUsage(true).catch(() => undefined);
    this.#usagePollTimer = setInterval(() => {
      void this.#readAccountUsage(true).catch(() => undefined);
    }, USAGE_POLL_INTERVAL_MS);
  }

  restorePersistentState(records: Array<{ kind?: unknown; key?: unknown; value?: unknown }>): void {
    for (const record of records) {
      if (record.kind === 'usage-snapshot' && record.key === 'latest') {
        const usage = normalizeAccountUsage(record.value);
        if (usage?.available && !this.#usageSnapshot) {
          this.#usageSnapshot = usage;
          this.#broadcast({ type: 'usage.updated', ...usage, cached: true });
        }
        continue;
      }
      if (record.kind === 'preferences' && record.key === 'composer' && isComposerPreferences(record.value)) {
        if (!this.#composerSnapshot) this.#composerSnapshot = record.value;
        continue;
      }
      if (record.kind !== 'turn-queue' || typeof record.key !== 'string') continue;
      const threadId = record.key;
      const value = asRecord(record.value);
      const items = Array.isArray(value?.items) ? value.items : [];
      const state = this.#queueState(threadId);
      if (state.items.length || !items.length) continue;
      const restored = items.map((item) => this.#restoreQueuedTurn(threadId, item)).filter((item): item is QueuedTurn => Boolean(item));
      if (!restored.length) continue;
      state.items.push(...restored);
      state.blockedAfterError = false;
      this.#broadcastQueue(threadId);
    }
  }

  async #listenOnAvailablePort(host: string): Promise<void> {
    const requestedPort = this.options.port ?? 8518;
    try {
      await this.#listen(requestedPort, host);
    } catch (error) {
      const listenError = error as NodeJS.ErrnoException;
      if (listenError.code === 'EADDRINUSE') {
        throw new Error(`GPTTool 固定端口 ${requestedPort} 已被其他程序占用，请关闭占用程序后重试`);
      }
      throw error;
    }
  }

  #listen(port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = this.#server;
      if (!server) return reject(new Error('远程 Web 服务尚未初始化'));
      const cleanup = () => {
        server.off('error', onError);
        server.off('listening', onListening);
      };
      const onError = (error: NodeJS.ErrnoException) => {
        cleanup();
        reject(error);
      };
      const onListening = () => {
        cleanup();
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  async stop(): Promise<void> {
    if (this.#usagePollTimer) clearInterval(this.#usagePollTimer);
    this.#usagePollTimer = undefined;
    this.#scheduleQueuePersistence();
    await this.#queuePersistChain.catch(() => undefined);
    this.#unsubscribeNotification?.();
    this.#unsubscribeServerRequest?.();
    this.#unsubscribeNotification = undefined;
    this.#unsubscribeServerRequest = undefined;
    this.#pendingApprovals.clear();
    this.#pendingUserInputs.clear();
    this.#loadedThreadIds.clear();
    this.#uploads.clear();
    this.#activeTurnAttachments.clear();
    this.#idempotentTurnRequests.clear();
    this.#attachmentPreviews.clear();
    for (const state of this.#turnQueues.values()) {
      if (state.watcher) clearInterval(state.watcher);
      state.watcher = undefined;
      state.polling = false;
    }
    for (const client of this.#webSockets?.clients ?? []) client.close(1001, 'Server stopped');
    this.#webSockets?.close();
    this.#webSockets = undefined;
    const server = this.#server;
    this.#server = undefined;
    this.#port = 0;
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async #serveHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.#setSecurityHeaders(response);
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    const suppliedToken = requestUrl.searchParams.get('token');
    if (suppliedToken && this.#tokenMatches(suppliedToken)) {
      response.statusCode = 302;
      response.setHeader('Set-Cookie', `astergate_session=${this.#token}; HttpOnly; SameSite=Strict; Path=/`);
      response.setHeader('Location', '/');
      response.end();
      return;
    }
    if (!this.#authenticated(request)) {
      response.statusCode = 401;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end('GPTTool remote access token required.');
      return;
    }
    const staticFile = STATIC_FILES.get(requestUrl.pathname as '/' | '/remote.js' | '/remote.css' | '/gpttool-logo.png' | '/apple-touch-icon.png');
    if (!staticFile) {
      response.statusCode = 404;
      response.end('Not found');
      return;
    }
    try {
      response.statusCode = 200;
      response.setHeader('Content-Type', staticFile[1]);
      response.setHeader('Cache-Control', 'no-store');
      response.end(await readFile(path.join(this.options.assetsDirectory, staticFile[0])));
    } catch {
      response.statusCode = 500;
      response.end('Remote UI assets unavailable');
    }
  }

  async #handleMessage(client: WebSocket, raw: string): Promise<void> {
    let message: ClientRequest;
    try {
      message = JSON.parse(raw) as ClientRequest;
      if (!Number.isInteger(message.id) || typeof message.type !== 'string') throw new Error('无效请求');
      const result = await this.#dispatch(message);
      this.#send(client, { id: message.id, ok: true, result });
    } catch (error) {
      const id = typeof (message! as ClientRequest | undefined)?.id === 'number' ? message!.id : 0;
      this.#send(client, { id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  #dispatch(message: ClientRequest): Promise<unknown> | unknown {
    switch (message.type) {
      case 'thread.list':
        return this.#listThreads();
      case 'thread.rename':
        return this.#renameThread(
          requiredString(message.threadId, 'threadId'),
          requiredDisplayName(message.name, '任务名称'),
        );
      case 'project.directory.create':
        return this.#createProjectDirectory(requiredString(message.path, 'path'));
      case 'project.directory.list':
        return this.#listProjectDirectory(requiredString(message.path, 'path'));
      case 'project.directory.root':
        return { path: this.#directoryRoot() };
      case 'thread.open':
        // Keep the first screen intentionally small. Older turns remain
        // available through thread.history, while mobile users can render and
        // interact with the newest messages much sooner.
        return this.#readThread(requiredString(message.threadId, 'threadId'), 0, 6);
      case 'thread.history':
        return this.#readThread(
          requiredString(message.threadId, 'threadId'),
          requiredNonNegativeInteger(message.offset, 'offset'),
          boundedHistoryLimit(message.limit),
        );
      case 'thread.create':
        return this.#createThread(message.cwd?.trim() || this.options.defaultCwd || undefined);
      case 'attachment.upload.start':
        return this.#startAttachmentUpload(message.name, message.mimeType, message.size);
      case 'attachment.upload.chunk':
        return this.#appendAttachmentChunk(message.uploadId, message.index, message.data);
      case 'attachment.upload.finish':
        return this.#finishAttachmentUpload(message.uploadId);
      case 'attachment.upload.remove':
        return this.#removeAttachment(message.uploadId);
      case 'attachment.preview':
        return this.#attachmentPreview(
          requiredString(message.threadId, 'threadId'),
          requiredString(message.itemId, 'itemId'),
          requiredNonNegativeInteger(message.attachmentIndex, 'attachmentIndex'),
        );
      case 'turn.start': {
        return this.#runIdempotentTurnRequest(
          'start',
          optionalClientRequestId(message.clientRequestId),
          () => {
            const attachmentIds = this.#validatedAttachmentIds(message.attachmentIds);
            return this.#startTurn(
              requiredString(message.threadId, 'threadId'),
              requiredTurnText(message.text, attachmentIds.length > 0),
              attachmentIds,
              requiredTurnMode(message.mode),
            );
          },
        );
      }
      case 'turn.queue': {
        return this.#runIdempotentTurnRequest(
          'queue',
          optionalClientRequestId(message.clientRequestId),
          () => {
            const attachmentIds = this.#validatedAttachmentIds(message.attachmentIds);
            return this.#queueTurn(
              requiredString(message.threadId, 'threadId'),
              requiredTurnText(message.text, attachmentIds.length > 0),
              attachmentIds,
              requiredTurnMode(message.mode),
            );
          },
        );
      }
      case 'turn.queue.list':
      case 'turn.queue/list':
      case 'turn.list':
        return this.#queueSnapshot(requiredString(message.threadId, 'threadId'));
      case 'turn.queue.remove':
      case 'turn.queue/remove':
      case 'turn.remove':
        return this.#removeQueuedTurn(
          requiredString(message.threadId, 'threadId'),
          requiredString(message.queueId, 'queueId'),
        );
      case 'turn.queue.update':
      case 'turn.queue/update':
        return this.#updateQueuedTurn(
          requiredString(message.threadId, 'threadId'),
          requiredString(message.queueId, 'queueId'),
          message.text,
        );
      case 'turn.queue.reorder':
      case 'turn.queue/reorder':
      case 'turn.reorder':
        return this.#reorderQueuedTurn(
          requiredString(message.threadId, 'threadId'),
          requiredString(message.queueId, 'queueId'),
          message.toIndex,
        );
      case 'turn.steer':
        return this.#steerTurn(
          requiredString(message.threadId, 'threadId'),
          requiredString(message.turnId, 'turnId'),
          requiredTurnText(message.text),
        );
      case 'turn.interrupt':
        return this.options.codex.request('turn/interrupt', {
          threadId: requiredString(message.threadId, 'threadId'),
          turnId: requiredString(message.turnId, 'turnId'),
        });
      case 'approval.auto.get':
        return { enabled: this.#autoApprovalEnabled };
      case 'approval.auto.set':
        return this.#setAutoApproval(message.enabled === true);
      case 'composer.preferences.get':
        return this.#composerPreferences();
      case 'composer.preferences.inspect':
        return this.#withOfficialSettings(() => this.options.codex.request('composer/preferences/inspect'));
      case 'composer.speed.get':
        return this.#withOfficialSettings(() => this.options.codex.request('composer/speed/get'));
      case 'composer.speed.set':
        return this.#withOfficialSettings(() => this.options.codex.request('composer/speed/set', {
          speed: requiredString(message.speed, 'speed'), model: requiredString(message.model, 'model'),
        }));
      case 'composer.preferences.set':
        return this.#setComposerPreferences(message.model, message.effort);
      case 'account.usage.get':
        return this.#accountUsage();
      case 'compatibility.status.get':
        return this.options.codex.request('compatibility/status/get');
      case 'approval.respond': {
        if (!Number.isInteger(message.requestId) || !this.#pendingApprovals.has(message.requestId!)) throw new Error('审批请求已失效');
        if (!['accept', 'decline'].includes(message.decision ?? '')) throw new Error('无效审批结果');
        this.options.codex.respond(message.requestId!, { decision: message.decision });
        this.#pendingApprovals.delete(message.requestId!);
        return { accepted: true };
      }
      case 'userInput.respond': {
        if (!Number.isInteger(message.requestId) || !this.#pendingUserInputs.has(message.requestId!)) throw new Error('提问请求已失效');
        if (!message.answers || typeof message.answers !== 'object') throw new Error('回答不能为空');
        this.options.codex.respond(message.requestId!, { answers: message.answers });
        this.#pendingUserInputs.delete(message.requestId!);
        return { accepted: true };
      }
      default:
        throw new Error('不支持的远程操作');
    }
  }

  #runIdempotentTurnRequest(kind: 'start' | 'queue', clientRequestId: string | undefined, operation: () => Promise<unknown>): Promise<unknown> {
    if (!clientRequestId) return operation();
    const now = Date.now();
    for (const [key, entry] of this.#idempotentTurnRequests) {
      if (now - entry.createdAt > IDEMPOTENT_TURN_TTL_MS) this.#idempotentTurnRequests.delete(key);
    }
    const key = `${kind}:${clientRequestId}`;
    const existing = this.#idempotentTurnRequests.get(key);
    if (existing) return existing.promise;
    const promise = Promise.resolve().then(operation);
    this.#idempotentTurnRequests.set(key, { createdAt: now, promise });
    void promise.catch(() => {
      if (this.#idempotentTurnRequests.get(key)?.promise === promise) this.#idempotentTurnRequests.delete(key);
    });
    while (this.#idempotentTurnRequests.size > MAX_IDEMPOTENT_TURN_REQUESTS) {
      const oldest = this.#idempotentTurnRequests.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.#idempotentTurnRequests.delete(oldest);
    }
    return promise;
  }

  async #createThread(cwd?: string): Promise<unknown> {
    const result = await this.options.codex.request<{ thread?: { id?: string } }>('thread/start', { cwd });
    if (result.thread?.id) this.#loadedThreadIds.add(result.thread.id);
    return result;
  }

  async #createProjectDirectory(directoryPath: string): Promise<unknown> {
    return this.options.codex.request('fs/createDirectory', { path: this.#browsableDirectory(directoryPath), recursive: true });
  }

  async #listProjectDirectory(directoryPath: string): Promise<unknown> {
    const safePath = this.#browsableDirectory(directoryPath);
    const result = await this.options.codex.request<{ entries?: Array<{ fileName?: string; isDirectory?: boolean }> }>('fs/readDirectory', { path: safePath });
    const entries = (result.entries ?? [])
      .filter((entry) => entry.isDirectory === true
        && typeof entry.fileName === 'string'
        && entry.fileName.length > 0
        && !entry.fileName.startsWith('.'))
      .map((entry) => ({ name: String(entry.fileName) }))
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true }));
    return { path: safePath, root: this.#directoryRoot(), entries };
  }

  #directoryRoot(): string {
    return path.resolve(this.options.directoryRoot || homedir());
  }

  #browsableDirectory(directoryPath: string): string {
    const root = this.#directoryRoot();
    const target = path.resolve(directoryPath);
    const relative = path.relative(root, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('只能浏览当前用户目录中的文件夹');
    }
    return target;
  }

  async #listThreads(): Promise<unknown> {
    if (this.#threadIndexSnapshot) {
      void this.#refreshThreadIndex().catch(() => undefined);
      return this.#threadIndexSnapshot;
    }
    return this.#refreshThreadIndex();
  }

  async #refreshThreadIndex(): Promise<unknown> {
    this.#threadIndexRefresh ??= this.options.codex.request('thread/list', {
      limit: 50,
      sortKey: 'updated_at',
      sortDirection: 'desc',
    }).then(async (result) => {
      this.#threadIndexSnapshot = result;
      this.options.onPersistentStateChange?.('task-index', 'recent', result);
      await this.#writeThreadIndexCache(result);
      this.#broadcast({ type: 'event', method: 'thread/list/updated', params: result });
      return result;
    }).finally(() => { this.#threadIndexRefresh = undefined; });
    return this.#threadIndexRefresh;
  }

  async #renameThread(threadId: string, name: string): Promise<unknown> {
    await this.options.codex.request('thread/name/set', { threadId, name });
    await this.#threadIndexRefresh?.catch(() => undefined);
    this.#threadIndexSnapshot = undefined;
    const threads = await this.#refreshThreadIndex();
    return { threadId, name, threads };
  }

  async #readThread(threadId: string, offset: number, limit: number): Promise<unknown> {
    const requestedTurns = Math.min(120, offset + limit + 1);
    const result = await this.options.codex.request('thread/read', {
      threadId,
      includeTurns: true,
      turnLimit: requestedTurns,
    });
    this.#synchronizeActiveTurn(threadId, result);
    this.#cacheAttachmentPreviews(threadId, result);
    const compact = compactThreadReadResponse(result, offset, limit);
    this.options.onPersistentStateChange?.('task-snapshot', threadId, compactPersistentSnapshot(compact));
    return compact;
  }

  #cacheAttachmentPreviews(threadId: string, value: unknown): void {
    const response = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const thread = response.thread && typeof response.thread === 'object' ? response.thread as Record<string, unknown> : {};
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    const previews = new Map<string, string>();
    let totalBytes = 0;
    for (const turnValue of [...turns].reverse()) {
      const turn = turnValue && typeof turnValue === 'object' ? turnValue as Record<string, unknown> : {};
      const items = Array.isArray(turn.items) ? [...turn.items].reverse() : [];
      for (const itemValue of items) {
        const item = itemValue && typeof itemValue === 'object' ? itemValue as Record<string, unknown> : {};
        if (item.type !== 'userMessage' || typeof item.id !== 'string') continue;
        const attachments = (Array.isArray(item.content) ? item.content : []).filter((part) => {
          const record = part && typeof part === 'object' ? part as Record<string, unknown> : {};
          return record.type === 'attachment';
        });
        attachments.forEach((part, index) => {
          const record = part as Record<string, unknown>;
          const imageUrl = typeof record.imageUrl === 'string' && /^data:image\//i.test(record.imageUrl) ? record.imageUrl : '';
          if (!imageUrl || imageUrl.length > 2_800_000 || totalBytes + imageUrl.length > 8_000_000) return;
          previews.set(`${item.id}:${index}`, imageUrl);
          totalBytes += imageUrl.length;
        });
      }
    }
    this.#attachmentPreviews.delete(threadId);
    this.#attachmentPreviews.set(threadId, previews);
    while (this.#attachmentPreviews.size > 5) {
      const oldest = this.#attachmentPreviews.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#attachmentPreviews.delete(oldest);
    }
  }

  async #attachmentPreview(threadId: string, itemId: string, attachmentIndex: number): Promise<{ imageUrl: string }> {
    const key = `${itemId}:${attachmentIndex}`;
    const cached = this.#attachmentPreviews.get(threadId)?.get(key);
    if (cached) return { imageUrl: cached };

    // The compact thread response deliberately strips image bytes. If the
    // bounded cache filled up with other images, read the requested message
    // from the official local rollout on demand instead of showing a broken
    // placeholder for an image that is still present on disk.
    const response = await this.options.codex.request('thread/read', { threadId, includeTurns: true, turnLimit: 24 });
    const imageUrl = attachmentImageUrl(response, itemId, attachmentIndex);
    if (!imageUrl) throw new Error('此图片预览不可用');
    let previews = this.#attachmentPreviews.get(threadId);
    if (!previews) {
      previews = new Map();
      this.#attachmentPreviews.set(threadId, previews);
    }
    previews.set(key, imageUrl);
    return { imageUrl };
  }

  async #startTurn(threadId: string, text: string, attachmentIds: string[] = [], mode: TurnMode = 'normal', deleteAttachmentsAfter = true): Promise<unknown> {
    const state = this.#queueState(threadId);
    state.starting = true;
    const attachments = this.#readyAttachments(attachmentIds);
    let started = false;
    try {
      await this.#assertUsageAvailableForSend();
      if (!this.#loadedThreadIds.has(threadId)) {
        await this.options.codex.request('thread/resume', { threadId });
        this.#loadedThreadIds.add(threadId);
      }
      const result = await this.options.codex.request('turn/start', {
        threadId,
        input: textInput(text),
        mode,
        ...(attachments.length ? { attachments: attachments.map(({ path: filePath, name, mimeType, size }) => ({ path: filePath, name, mimeType, size })) } : {}),
      });
      const canonicalThreadId = typeof asRecord(result)?.threadId === 'string' ? String(asRecord(result)?.threadId) : threadId;
      if (canonicalThreadId !== threadId) this.#migrateThreadState(threadId, canonicalThreadId);
      if (attachmentIds.length) this.#activeTurnAttachments.set(canonicalThreadId, [...attachmentIds]);
      started = true;
      const turnId = turnIdFromResponse(result);
      const activeState = this.#queueState(canonicalThreadId);
      if (turnId) activeState.activeTurnId = turnId;
      this.#broadcastQueue(canonicalThreadId);
      return result;
    } finally {
      if (!started && deleteAttachmentsAfter) await this.#deleteAttachments(attachmentIds);
      state.starting = false;
      if (!state.activeTurnId && !state.draining && state.items.length) void this.#drainQueue(threadId);
    }
  }

  async #steerTurn(threadId: string, turnId: string, text: string): Promise<unknown> {
    const state = this.#queueState(threadId);
    const previousTurnId = state.activeTurnId;
    state.activeTurnId = turnId;
    this.#broadcastQueue(threadId);
    try {
      return await this.options.codex.request('turn/steer', {
        threadId,
        expectedTurnId: turnId,
        input: textInput(text),
      });
    } catch (error) {
      state.activeTurnId = previousTurnId;
      this.#broadcastQueue(threadId);
      throw error;
    }
  }

  async #queueTurn(threadId: string, text: string, attachmentIds: string[] = [], mode: TurnMode = 'normal'): Promise<{ queued: true; item: QueuedTurn; queue: QueueSnapshot }> {
    try {
      await this.#assertUsageAvailableForSend();
    } catch (error) {
      if (attachmentIds.length) await this.#deleteAttachments(attachmentIds);
      throw error;
    }
    const state = this.#queueState(threadId);
    if (state.items.length >= MAX_QUEUED_TURNS_PER_THREAD) throw new Error(`每个任务最多排队 ${MAX_QUEUED_TURNS_PER_THREAD} 条消息`);
    const attachments = this.#readyAttachments(attachmentIds).map(toAttachmentDescriptor);
    const item: QueuedTurn = {
      id: randomBytes(12).toString('base64url'),
      threadId,
      text,
      createdAt: Date.now(),
      status: 'queued',
      ...(mode !== 'normal' ? { mode } : {}),
      ...(attachmentIds.length ? { attachmentIds: [...attachmentIds], attachments } : {}),
    };
    state.items.push(item);
    const queuedItem = { ...item };
    const queue = this.#queueSnapshot(threadId);
    this.#broadcastQueue(threadId);
    if (!state.activeTurnId && !state.starting && !state.draining) void this.#drainQueue(threadId);
    return { queued: true, item: queuedItem, queue };
  }

  #removeQueuedTurn(threadId: string, queueId: string): QueueSnapshot {
    const state = this.#queueState(threadId);
    const index = state.items.findIndex((item) => item.id === queueId);
    if (index < 0) throw new Error('排队消息不存在或已经开始执行');
    if (state.items[index]?.status === 'starting') throw new Error('消息已经开始发送，无法移除');
    const [removed] = state.items.splice(index, 1);
    if (removed?.attachmentIds?.length) void this.#deleteAttachments(removed.attachmentIds);
    state.blockedAfterError = false;
    const queue = this.#queueSnapshot(threadId);
    this.#broadcastQueue(threadId);
    if (!state.activeTurnId && !state.starting && !state.draining) void this.#drainQueue(threadId);
    return queue;
  }

  #updateQueuedTurn(threadId: string, queueId: string, textValue: unknown): QueueSnapshot {
    const state = this.#queueState(threadId);
    const item = state.items.find((candidate) => candidate.id === queueId);
    if (!item) throw new Error('排队消息不存在或已经开始执行');
    if (item.status === 'starting') throw new Error('消息已经开始发送，无法编辑');
    item.text = requiredTurnText(textValue, Boolean(item.attachmentIds?.length));
    state.blockedAfterError = false;
    const queue = this.#queueSnapshot(threadId);
    this.#broadcastQueue(threadId);
    if (!state.activeTurnId && !state.starting && !state.draining) void this.#drainQueue(threadId);
    return queue;
  }

  #reorderQueuedTurn(threadId: string, queueId: string, toIndex: unknown): QueueSnapshot {
    const state = this.#queueState(threadId);
    if (!Number.isInteger(toIndex) || (toIndex as number) < 0 || (toIndex as number) >= state.items.length) throw new Error('toIndex 超出排队范围');
    const fromIndex = state.items.findIndex((item) => item.id === queueId);
    if (fromIndex < 0) throw new Error('排队消息不存在或已经开始执行');
    if (state.items[fromIndex]?.status === 'starting') throw new Error('消息已经开始发送，无法调整顺序');
    const [item] = state.items.splice(fromIndex, 1);
    state.items.splice(toIndex as number, 0, item!);
    state.blockedAfterError = false;
    const queue = this.#queueSnapshot(threadId);
    this.#broadcastQueue(threadId);
    if (!state.activeTurnId && !state.starting && !state.draining) void this.#drainQueue(threadId);
    return queue;
  }

  #queueState(threadId: string): ThreadQueueState {
    let state = this.#turnQueues.get(threadId);
    if (!state) {
      state = { activeTurnId: null, items: [], starting: false, draining: false, blockedAfterError: false, polling: false };
      this.#turnQueues.set(threadId, state);
    }
    return state;
  }

  #migrateThreadState(previousThreadId: string, threadId: string): void {
    this.#loadedThreadIds.delete(previousThreadId);
    this.#loadedThreadIds.add(threadId);
    const attachments = this.#activeTurnAttachments.get(previousThreadId);
    if (attachments) {
      this.#activeTurnAttachments.delete(previousThreadId);
      this.#activeTurnAttachments.set(threadId, attachments);
    }
    const previous = this.#turnQueues.get(previousThreadId);
    if (!previous) return;
    this.#turnQueues.delete(previousThreadId);
    for (const item of previous.items) item.threadId = threadId;
    this.#turnQueues.set(threadId, previous);
  }

  #queueSnapshot(threadId: string): QueueSnapshot {
    const state = this.#turnQueues.get(threadId);
    return {
      threadId,
      activeTurnId: state?.activeTurnId ?? null,
      items: state?.items.map((item) => ({ ...item })) ?? [],
    };
  }

  #broadcastQueue(threadId: string): void {
    this.#refreshQueueWatcher(threadId);
    const snapshot = this.#queueSnapshot(threadId);
    this.#scheduleQueuePersistence();
    this.options.onPersistentStateChange?.('turn-queue', threadId, snapshot);
    this.#broadcast({ type: 'queue.updated', ...snapshot });
  }

  async #drainQueue(threadId: string): Promise<void> {
    const state = this.#queueState(threadId);
    if (state.activeTurnId || state.starting || state.draining || state.blockedAfterError || !state.items.length) return;
    const item = state.items[0]!;
    state.draining = true;
    item.status = 'starting';
    this.#broadcastQueue(threadId);
    try {
      await this.#startTurn(threadId, item.text, item.attachmentIds ?? [], item.mode ?? 'normal', false);
      const index = state.items.findIndex((candidate) => candidate.id === item.id);
      if (index >= 0) state.items.splice(index, 1);
      this.#broadcastQueue(threadId);
    } catch (error) {
      const index = state.items.findIndex((candidate) => candidate.id === item.id);
      if (index >= 0) state.items.splice(index, 1);
      item.status = 'queued';
      state.items.unshift(item);
      state.blockedAfterError = true;
      this.#broadcastQueue(threadId);
      this.#broadcast({
        type: 'queue.error',
        threadId,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      state.draining = false;
    }
  }

  #refreshQueueWatcher(threadId: string): void {
    const state = this.#turnQueues.get(threadId);
    if (!state) return;
    if (state.items.length || state.activeTurnId) {
      this.#ensureQueueWatcher(threadId);
      return;
    }
    if (state.watcher) clearInterval(state.watcher);
    state.watcher = undefined;
  }

  #ensureQueueWatcher(threadId: string): void {
    const state = this.#queueState(threadId);
    if (state.watcher || (!state.items.length && !state.activeTurnId) || !this.running) return;
    state.watcher = setInterval(() => void this.#pollQueue(threadId), QUEUE_WATCH_INTERVAL_MS);
  }

  async #pollQueue(threadId: string): Promise<void> {
    const state = this.#turnQueues.get(threadId);
    if (!state || state.polling || (!state.items.length && !state.activeTurnId)) return;
    state.polling = true;
    try {
      const result = await this.options.codex.request('thread/turns/list', {
        threadId,
        limit: 1,
        sortDirection: 'desc',
        itemsView: 'notLoaded',
      });
      const response = asRecord(result);
      const latest = Array.isArray(response?.data) ? asRecord(response.data[0]) : undefined;
      const latestTurnId = typeof latest?.id === 'string' ? latest.id : undefined;
      if (latest?.status === 'inProgress') {
        if (latestTurnId && state.activeTurnId !== latestTurnId) {
          state.activeTurnId = latestTurnId;
          this.#broadcastQueue(threadId);
        }
        return;
      }
      if (state.activeTurnId) {
        state.activeTurnId = null;
        void this.#releaseTurnAttachments(threadId);
        this.#broadcastQueue(threadId);
      }
      if (!state.blockedAfterError) await this.#drainQueue(threadId);
    } catch {
      await this.#pollQueueFromThreadStatus(threadId);
    } finally {
      state.polling = false;
    }
  }

  async #pollQueueFromThreadStatus(threadId: string): Promise<void> {
    const state = this.#turnQueues.get(threadId);
    if (!state || (!state.items.length && !state.activeTurnId)) return;
    try {
      const result = await this.options.codex.request('thread/read', { threadId, includeTurns: false });
      const status = asRecord(asRecord(asRecord(result)?.thread)?.status)?.type;
      if (status === 'active') return;
      if (status !== 'idle' && status !== 'systemError') return;
      if (state.activeTurnId) {
        state.activeTurnId = null;
        void this.#releaseTurnAttachments(threadId);
        this.#broadcastQueue(threadId);
      }
      if (!state.blockedAfterError) await this.#drainQueue(threadId);
    } catch {
      // A transient status check failure must not discard or duplicate queued work.
    }
  }

  #trackTurnNotification(notification: RpcNotification): void {
    if (notification.method !== 'turn/started' && notification.method !== 'turn/completed') return;
    const params = asRecord(notification.params);
    const threadId = typeof params?.threadId === 'string' ? params.threadId : undefined;
    if (!threadId) return;
    const turn = asRecord(params?.turn);
    const turnId = typeof turn?.id === 'string' ? turn.id : typeof params?.turnId === 'string' ? params.turnId : undefined;
    const state = this.#queueState(threadId);
    if (notification.method === 'turn/started') {
      if (turnId) state.activeTurnId = turnId;
      this.#broadcastQueue(threadId);
      return;
    }
    if (!turnId || !state.activeTurnId || state.activeTurnId === turnId) state.activeTurnId = null;
    void this.#releaseTurnAttachments(threadId);
    this.#broadcastQueue(threadId);
    if (!state.activeTurnId) void this.#drainQueue(threadId);
  }

  #synchronizeActiveTurn(threadId: string, result: unknown): void {
    const response = asRecord(result);
    const thread = asRecord(response?.thread);
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    const active = [...turns].reverse().map((turn) => asRecord(turn)).find((turn) => turn?.status === 'inProgress');
    const state = this.#queueState(threadId);
    state.activeTurnId = typeof active?.id === 'string' ? active.id : null;
    if (!state.activeTurnId) void this.#releaseTurnAttachments(threadId);
    this.#broadcastQueue(threadId);
    if (!state.activeTurnId && !state.starting && !state.draining && state.items.length) void this.#drainQueue(threadId);
  }

  async #startAttachmentUpload(nameValue: unknown, mimeTypeValue: unknown, sizeValue: unknown): Promise<{ uploadId: string }> {
    await this.#purgeExpiredUploads();
    if (this.#uploads.size >= MAX_UPLOADS) throw new Error(`最多同时保留 ${MAX_UPLOADS} 个待发送附件`);
    const name = safeAttachmentName(nameValue);
    const mimeType = typeof mimeTypeValue === 'string' ? mimeTypeValue.slice(0, 160) : '';
    if (!Number.isInteger(sizeValue) || (sizeValue as number) < 1 || (sizeValue as number) > MAX_ATTACHMENT_BYTES) {
      throw new Error(`单个附件大小必须在 1 字节到 ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB 之间`);
    }
    const reservedBytes = [...this.#uploads.values()].reduce((sum, upload) => sum + upload.size, 0);
    if (reservedBytes + (sizeValue as number) > 100 * 1024 * 1024) throw new Error('待发送附件总量超过 100MB，请先发送或移除已有附件');
    const id = randomBytes(18).toString('base64url');
    const filePath = path.join(this.#uploadDirectory(), `${id}-${name}`);
    await writeFile(filePath, Buffer.alloc(0), { mode: 0o600 });
    this.#uploads.set(id, {
      id,
      name,
      mimeType,
      size: sizeValue as number,
      path: filePath,
      received: 0,
      nextIndex: 0,
      ready: false,
      updatedAt: Date.now(),
    });
    return { uploadId: id };
  }

  async #appendAttachmentChunk(uploadIdValue: unknown, indexValue: unknown, dataValue: unknown): Promise<{ received: number }> {
    const uploadId = requiredString(uploadIdValue, 'uploadId');
    const upload = this.#uploads.get(uploadId);
    if (!upload || upload.ready) throw new Error('附件上传会话不存在或已经结束');
    if (!Number.isInteger(indexValue) || indexValue !== upload.nextIndex) throw new Error('附件分块顺序错误，请重新选择文件');
    if (typeof dataValue !== 'string' || !dataValue.length || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataValue)) throw new Error('附件分块格式无效');
    const chunk = Buffer.from(dataValue, 'base64');
    if (!chunk.length || chunk.byteLength > MAX_UPLOAD_CHUNK_BYTES) throw new Error('附件分块超过安全限制');
    if (upload.received + chunk.byteLength > upload.size) throw new Error('附件内容超过声明大小');
    await appendFile(upload.path, chunk);
    upload.received += chunk.byteLength;
    upload.nextIndex += 1;
    upload.updatedAt = Date.now();
    return { received: upload.received };
  }

  #finishAttachmentUpload(uploadIdValue: unknown): AttachmentDescriptor {
    const uploadId = requiredString(uploadIdValue, 'uploadId');
    const upload = this.#uploads.get(uploadId);
    if (!upload) throw new Error('附件上传会话不存在');
    if (upload.received !== upload.size) throw new Error(`附件上传不完整：收到 ${upload.received} / ${upload.size} 字节`);
    upload.ready = true;
    upload.updatedAt = Date.now();
    this.#scheduleQueuePersistence();
    return toAttachmentDescriptor(upload);
  }

  async #removeAttachment(uploadIdValue: unknown): Promise<{ removed: true }> {
    const uploadId = requiredString(uploadIdValue, 'uploadId');
    await this.#deleteAttachments([uploadId]);
    return { removed: true };
  }

  #validatedAttachmentIds(value: unknown): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error('attachmentIds 格式无效');
    const ids = [...new Set(value.map((item) => requiredString(item, 'attachmentId')))];
    if (ids.length > MAX_ATTACHMENTS_PER_TURN) throw new Error(`每条消息最多发送 ${MAX_ATTACHMENTS_PER_TURN} 个附件`);
    const attachments = this.#readyAttachments(ids);
    const total = attachments.reduce((sum, attachment) => sum + attachment.size, 0);
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) throw new Error(`每条消息的附件总量不能超过 ${Math.floor(MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024)}MB`);
    return ids;
  }

  #readyAttachments(ids: string[]): UploadedAttachment[] {
    return ids.map((id) => {
      const upload = this.#uploads.get(id);
      if (!upload?.ready) throw new Error('附件尚未上传完成或已经失效，请重新选择文件');
      return upload;
    });
  }

  async #deleteAttachments(ids: string[]): Promise<void> {
    await Promise.all(ids.map(async (id) => {
      const upload = this.#uploads.get(id);
      if (!upload) return;
      this.#uploads.delete(id);
      await rm(upload.path, { force: true });
    }));
    this.#scheduleQueuePersistence();
  }

  async #releaseTurnAttachments(threadId: string): Promise<void> {
    const ids = this.#activeTurnAttachments.get(threadId);
    if (!ids?.length) return;
    this.#activeTurnAttachments.delete(threadId);
    await this.#deleteAttachments(ids);
  }

  async #purgeExpiredUploads(): Promise<void> {
    const deadline = Date.now() - 30 * 60_000;
    const queuedIds = new Set([...this.#turnQueues.values()].flatMap((queue) => queue.items.flatMap((item) => item.attachmentIds ?? [])));
    await this.#deleteAttachments(
      [...this.#uploads.values()]
        .filter((upload) => upload.updatedAt < deadline && !queuedIds.has(upload.id))
        .map((upload) => upload.id),
    );
  }

  #scheduleQueuePersistence(): void {
    const snapshot = {
      version: 1,
      queues: [...this.#turnQueues.keys()].map((threadId) => this.#queueSnapshot(threadId)).filter((queue) => queue.items.length),
      uploads: [...this.#uploads.values()].filter((upload) => upload.ready).map(({ id, name, mimeType, size, received, nextIndex, ready, updatedAt }) => ({
        id, name, mimeType, size, received, nextIndex, ready, updatedAt,
      })),
    };
    this.#queuePersistChain = this.#queuePersistChain.then(async () => {
      const file = this.#queuePersistenceFile();
      const temporary = `${file}.next`;
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, file);
    }).catch((error) => console.warn(`Failed to persist remote queue: ${error instanceof Error ? error.message : String(error)}`));
  }

  async #loadQueuePersistence(): Promise<void> {
    let saved: Record<string, unknown>;
    try {
      saved = JSON.parse(await readFile(this.#queuePersistenceFile(), 'utf8')) as Record<string, unknown>;
    } catch {
      return;
    }
    for (const value of Array.isArray(saved.uploads) ? saved.uploads : []) {
      const upload = asRecord(value);
      const id = typeof upload?.id === 'string' && /^[A-Za-z0-9_-]{12,64}$/.test(upload.id) ? upload.id : '';
      let name;
      try { name = safeAttachmentName(upload?.name); } catch { continue; }
      const size = Number(upload?.size);
      if (!id || !Number.isInteger(size) || size < 1 || size > MAX_ATTACHMENT_BYTES) continue;
      const filePath = path.join(this.#uploadDirectory(), `${id}-${name}`);
      try {
        const file = await stat(filePath);
        if (!file.isFile() || file.size !== size) continue;
      } catch {
        continue;
      }
      const nextIndex = typeof upload?.nextIndex === 'number' && Number.isInteger(upload.nextIndex) ? upload.nextIndex : 0;
      this.#uploads.set(id, {
        id,
        name,
        mimeType: typeof upload?.mimeType === 'string' ? upload.mimeType.slice(0, 160) : '',
        size,
        path: filePath,
        received: size,
        nextIndex,
        ready: true,
        updatedAt: Number(upload?.updatedAt) || Date.now(),
      });
    }
    for (const value of Array.isArray(saved.queues) ? saved.queues : []) {
      const queue = asRecord(value);
      if (typeof queue?.threadId !== 'string' || !Array.isArray(queue.items)) continue;
      const state = this.#queueState(queue.threadId);
      for (const item of queue.items) {
        const restored = this.#restoreQueuedTurn(queue.threadId, item);
        if (restored && !state.items.some((candidate) => candidate.id === restored.id)) state.items.push(restored);
      }
    }
  }

  #restoreQueuedTurn(threadId: string, value: unknown): QueuedTurn | undefined {
    const item = asRecord(value);
    const id = typeof item?.id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(item.id) ? item.id : '';
    const text = typeof item?.text === 'string' ? item.text.slice(0, MAX_TURN_TEXT_LENGTH) : '';
    const attachmentIds = Array.isArray(item?.attachmentIds)
      ? item.attachmentIds.filter((entry): entry is string => typeof entry === 'string' && this.#uploads.get(entry)?.ready === true)
      : [];
    if (!id || (!text.trim() && !attachmentIds.length)) return undefined;
    return {
      id,
      threadId,
      text,
      createdAt: Number(item?.createdAt) || Date.now(),
      status: 'queued',
      ...(item?.mode === 'plan' || item?.mode === 'goal' ? { mode: item.mode } : {}),
      ...(attachmentIds.length ? { attachmentIds, attachments: attachmentIds.map((attachmentId) => toAttachmentDescriptor(this.#uploads.get(attachmentId)!)) } : {}),
    };
  }

  #queuePersistenceFile(): string {
    return path.join(this.options.stateDirectory, 'remote-turn-queues.json');
  }

  #threadIndexCacheFile(): string {
    return path.join(this.options.stateDirectory, 'remote-thread-index.json');
  }

  async #loadThreadIndexCache(): Promise<void> {
    try {
      const encoded = await readFile(this.#threadIndexCacheFile(), 'utf8');
      if (Buffer.byteLength(encoded, 'utf8') > 512 * 1024) return;
      const value = JSON.parse(encoded) as unknown;
      const record = asRecord(value);
      if (!Array.isArray(record?.data)) return;
      this.#threadIndexSnapshot = value;
    } catch {
      // The official local database remains the source of truth.
    }
  }

  async #writeThreadIndexCache(value: unknown): Promise<void> {
    try {
      const encoded = JSON.stringify(value);
      if (Buffer.byteLength(encoded, 'utf8') > 512 * 1024) return;
      await mkdir(this.options.stateDirectory, { recursive: true });
      const temporary = `${this.#threadIndexCacheFile()}.${process.pid}.tmp`;
      await writeFile(temporary, encoded, { mode: 0o600 });
      await rename(temporary, this.#threadIndexCacheFile());
    } catch {
      // Cache writes must not delay or block the task list.
    }
  }

  #uploadDirectory(): string {
    return path.join(this.options.stateDirectory, 'remote-uploads');
  }

  #authenticated(request: IncomingMessage): boolean {
    const cookie = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('astergate_session='));
    return this.#tokenMatches(cookie?.slice('astergate_session='.length) ?? '');
  }

  #tokenMatches(candidate: string): boolean {
    const expected = createHash('sha256').update(this.#token).digest();
    const received = createHash('sha256').update(candidate).digest();
    return timingSafeEqual(expected, received);
  }

  #send(client: WebSocket, value: unknown): void {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(value));
  }

  #broadcast(value: unknown): void {
    const json = JSON.stringify(value);
    for (const client of this.#webSockets?.clients ?? []) if (client.readyState === WebSocket.OPEN) client.send(json);
  }

  #setSecurityHeaders(response: ServerResponse): void {
    response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self'; script-src 'self'; img-src 'self' data: blob:");
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
  }

  async #loadOrCreateToken(): Promise<string> {
    const file = path.join(this.options.stateDirectory, 'remote-access-token');
    try {
      const saved = (await readFile(file, 'utf8')).trim();
      if (saved.length >= 32) return saved;
    } catch { /* create below */ }
    const token = randomBytes(24).toString('base64url');
    await mkdir(this.options.stateDirectory, { recursive: true });
    await writeFile(file, `${token}\n`, { mode: 0o600 });
    return token;
  }

  async #loadAutoApprovalPreference(): Promise<boolean> {
    try {
      const value = JSON.parse(await readFile(path.join(this.options.stateDirectory, 'remote-preferences.json'), 'utf8')) as { autoApprovalEnabled?: unknown };
      return value.autoApprovalEnabled === true;
    } catch {
      return false;
    }
  }

  async #setAutoApproval(enabled: boolean): Promise<{ enabled: boolean }> {
    await this.options.codex.request('approval/auto/set', { enabled });
    await mkdir(this.options.stateDirectory, { recursive: true });
    await writeFile(
      path.join(this.options.stateDirectory, 'remote-preferences.json'),
      `${JSON.stringify({ autoApprovalEnabled: enabled }, null, 2)}\n`,
      { mode: 0o600 },
    );
    this.#autoApprovalEnabled = enabled;
    this.options.onPersistentStateChange?.('preferences', 'approval', { autoApprovalEnabled: enabled });
    this.#broadcast({ type: 'approval.auto.updated', enabled });
    return { enabled };
  }

  async #composerPreferences(): Promise<unknown> {
    if (this.#composerSnapshot) {
      void this.#refreshComposerPreferences().catch(() => undefined);
      return { ...(asRecord(this.#composerSnapshot) ?? {}), cached: true };
    }
    return this.#refreshComposerPreferences();
  }

  async #setComposerPreferences(model?: string, effort?: string): Promise<unknown> {
    const result = await this.#withOfficialSettings(() =>
      this.options.codex.request('composer/preferences/set', { model, effort }));
    this.#storeComposerPreferences(result);
    return result;
  }

  async #accountUsage(): Promise<unknown> {
    // An explicit request is a freshness boundary. Returning the persisted
    // snapshot first can leave a long-lived mobile page showing the previous
    // quota cycle even though the official client has already reset.
    return this.#readAccountUsage(true);
  }

  async #readAccountUsage(force = false): Promise<AccountUsageSnapshot> {
    if (!force && this.#usageSnapshot && Date.now() - this.#usageCheckedAt < 5_000) return this.#usageSnapshot;
    if (this.#usageRefresh) return this.#usageRefresh;
    const refresh = this.#withOfficialSettings(async () => {
      const result = normalizeAccountUsage(await this.options.codex.request('account/usage/get'))
        ?? { available: false, enforced: true, message: '官方客户端暂时没有显示剩余额度' };
      this.#usageCheckedAt = Date.now();
      if (result.enforced && !result.available && this.#usageSnapshot?.available) {
        const cached = { ...this.#usageSnapshot, cached: true, stale: true, message: result.message };
        this.#broadcast({ type: 'usage.updated', ...cached });
        return this.#usageSnapshot;
      }
      this.#usageSnapshot = result;
      this.options.onPersistentStateChange?.('usage-snapshot', 'latest', result);
      this.#broadcast({ type: 'usage.updated', ...result });
      return result;
    });
    this.#usageRefresh = refresh;
    try {
      return await refresh;
    } finally {
      if (this.#usageRefresh === refresh) this.#usageRefresh = undefined;
    }
  }

  async #refreshComposerPreferences(): Promise<unknown> {
    if (this.#composerRefresh) return this.#composerRefresh;
    const refresh = this.#withOfficialSettings(async () => {
      const result = await this.options.codex.request('composer/preferences/get');
      this.#storeComposerPreferences(result);
      return result;
    });
    this.#composerRefresh = refresh;
    try {
      return await refresh;
    } finally {
      if (this.#composerRefresh === refresh) this.#composerRefresh = undefined;
    }
  }

  #storeComposerPreferences(result: unknown): void {
    if (!isComposerPreferences(result)) return;
    this.#composerSnapshot = result;
    this.options.onPersistentStateChange?.('preferences', 'composer', result);
    this.#broadcast({ type: 'preferences.updated', result });
  }

  #withOfficialSettings<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#officialSettingsChain.then(operation, operation);
    this.#officialSettingsChain = result.then(() => undefined, () => undefined);
    return result;
  }

  async #assertUsageAvailableForSend(): Promise<void> {
    let usage: AccountUsageSnapshot;
    try {
      usage = await this.#readAccountUsage();
    } catch {
      // A temporarily unreadable usage panel is not proof that quota is empty.
      // CDP still checks the official composer before it accepts the turn.
      return;
    }
    if (!usage.enforced || !usage.available || usage.percentage === undefined || usage.percentage > 0) return;
    const reset = usage.resetAt ? `，预计 ${usage.resetAt} 重置` : '';
    throw new Error(`Codex 剩余额度已用完${reset}。官方客户端已阻止执行，排队消息会保留，额度恢复后再继续。`);
  }
}

function compactThreadReadResponse(value: unknown, offset = 0, limit = 120): unknown {
  if (!value || typeof value !== 'object') return value;
  const response = value as Record<string, unknown>;
  if (!response.thread || typeof response.thread !== 'object') return value;
  const thread = response.thread as Record<string, unknown>;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const end = Math.max(0, turns.length - offset);
  const start = Math.max(0, end - limit);
  const page = turns.slice(start, end);
  return {
    ...response,
    thread: {
      ...thread,
      turns: page.map((turn) => compactTurn(turn)),
    },
    history: {
      offset,
      nextOffset: offset + page.length,
      hasMore: start > 0 || turns.length >= offset + limit + 1,
    },
  };
}

function attachmentImageUrl(value: unknown, itemId: string, attachmentIndex: number): string {
  if (!value || typeof value !== 'object') return '';
  const response = value as Record<string, unknown>;
  const thread = response.thread && typeof response.thread === 'object' ? response.thread as Record<string, unknown> : {};
  for (const turnValue of Array.isArray(thread.turns) ? thread.turns : []) {
    const turn = turnValue && typeof turnValue === 'object' ? turnValue as Record<string, unknown> : {};
    for (const itemValue of Array.isArray(turn.items) ? turn.items : []) {
      const item = itemValue && typeof itemValue === 'object' ? itemValue as Record<string, unknown> : {};
      if (item.id !== itemId || item.type !== 'userMessage') continue;
      const attachments = (Array.isArray(item.content) ? item.content : []).filter((part) => {
        const record = part && typeof part === 'object' ? part as Record<string, unknown> : {};
        return record.type === 'attachment';
      });
      const attachment = attachments[attachmentIndex] as Record<string, unknown> | undefined;
      const imageUrl = attachment?.imageUrl;
      return typeof imageUrl === 'string' && imageUrl.length <= 2_800_000 && /^data:image\//i.test(imageUrl) ? imageUrl : '';
    }
  }
  return '';
}

function compactTurn(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const turn = value as Record<string, unknown>;
  const items = Array.isArray(turn.items) ? turn.items.map((item) => compactHistoryItem(item)).filter(Boolean) : [];
  return { ...turn, items };
}

function compactHistoryItem(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  const base = { id: item.id, type: item.type, status: item.status };
  if (item.type === 'userMessage') {
    const content = Array.isArray(item.content)
      ? item.content.map((part) => {
        const record = part && typeof part === 'object' ? part as Record<string, unknown> : {};
        if (record.type === 'text') return { type: 'text', text: truncateText(record.text, 120_000) };
        if (record.type !== 'attachment') return undefined;
        const hasPreview = typeof record.imageUrl === 'string'
          && record.imageUrl.length <= 2_800_000
          && /^data:image\//i.test(record.imageUrl);
        return {
          type: 'attachment',
          name: truncateText(record.name, 300),
          mimeType: truncateText(record.mimeType, 200),
          ...(hasPreview ? { hasPreview: true } : {}),
        };
      }).filter(Boolean)
      : [];
    return { ...base, content };
  }
  if (item.type === 'agentMessage') return { ...base, text: truncateText(item.text, 120_000) };
  if (item.type === 'reasoning') {
    return { ...base, summary: Array.isArray(item.summary) ? item.summary.map((part) => truncateText(part, 4_000)) : [] };
  }
  if (item.type === 'commandExecution') {
    return { ...base, command: truncateText(item.command, 4_000), aggregatedOutput: truncateText(item.aggregatedOutput, 8_000), exitCode: item.exitCode };
  }
  if (item.type === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes.map((change) => {
      const record = change && typeof change === 'object' ? change as Record<string, unknown> : {};
      return { path: record.path, file: record.file };
    }) : [];
    return { ...base, changes };
  }
  if (item.type === 'mcpToolCall') {
    if (!item.kind && !item.input) return { ...base, server: item.server, tool: item.tool };
    return {
      ...base,
      server: item.server,
      tool: item.tool,
      kind: item.kind,
      input: truncateText(item.input, 2_000),
      result: truncateText(item.result, 4_000),
    };
  }
  return undefined;
}

function truncateText(value: unknown, limit: number): string {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[内容过长，已在远程页面截断 ${text.length - limit} 个字符]`;
}

function compactPersistentSnapshot(value: unknown): unknown {
  const compact = JSON.parse(JSON.stringify(value, (_key, entry) => {
    if (typeof entry === 'string' && entry.length > 8_000) return `${entry.slice(0, 8_000)}\n[服务端快照已截断]`;
    if (Array.isArray(entry) && entry.length > 40) return entry.slice(-40);
    return entry;
  })) as unknown;
  const encoded = JSON.stringify(compact);
  if (Buffer.byteLength(encoded, 'utf8') <= 320 * 1024) return compact;
  const record = compact && typeof compact === 'object' ? compact as Record<string, unknown> : {};
  const thread = record.thread && typeof record.thread === 'object' ? record.thread as Record<string, unknown> : {};
  return {
    thread: {
      id: thread.id,
      name: thread.name,
      title: thread.title,
      cwd: thread.cwd,
      updatedAt: thread.updatedAt,
    },
    history: record.history,
    oversized: true,
    synchronizedAt: Date.now(),
  };
}

function boundedHistoryLimit(value: unknown): number {
  const limit = typeof value === 'number' && Number.isInteger(value) ? value : 12;
  return Math.max(1, Math.min(24, limit));
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 不能为空`);
  return value.trim();
}

function requiredDisplayName(value: unknown, label: string): string {
  const name = requiredString(value, label).replace(/\s+/g, ' ');
  if (name.length > 200) throw new Error(`${label}不能超过 200 个字符`);
  return name;
}

function requiredNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${name} 格式无效`);
  return Number(value);
}

function requiredTurnText(value: unknown, allowEmpty = false): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text && !allowEmpty) throw new Error('text 不能为空');
  if (text.length > MAX_TURN_TEXT_LENGTH) throw new Error(`消息不能超过 ${MAX_TURN_TEXT_LENGTH} 个字符`);
  return text;
}

function requiredTurnMode(value: unknown): TurnMode {
  if (value === undefined || value === null || value === '' || value === 'normal') return 'normal';
  if (value === 'plan' || value === 'goal') return value;
  throw new Error('不支持的任务模式');
}

function optionalClientRequestId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) throw new Error('clientRequestId 格式无效');
  return value;
}

function textInput(text: string): Array<{ type: 'text'; text: string; text_elements: [] }> {
  return text ? [{ type: 'text', text, text_elements: [] }] : [];
}

function safeAttachmentName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('附件名称不能为空');
  const name = path.basename(value.replaceAll('\0', '')).trim().slice(0, 180);
  if (!name || name === '.' || name === '..') throw new Error('附件名称无效');
  return name.replace(/[\\/:*?"<>|]/g, '_');
}

function toAttachmentDescriptor(upload: UploadedAttachment): AttachmentDescriptor {
  return { id: upload.id, name: upload.name, mimeType: upload.mimeType, size: upload.size };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function normalizeAccountUsage(value: unknown): AccountUsageSnapshot | undefined {
  const record = asRecord(value);
  if (!record || typeof record.available !== 'boolean') return undefined;
  const percentageValue = Number(record.percentage);
  const percentage = Number.isFinite(percentageValue)
    ? Math.max(0, Math.min(100, Math.round(percentageValue)))
    : undefined;
  return {
    available: record.available && percentage !== undefined,
    enforced: record.enforced !== false,
    ...(typeof record.provider === 'string' && record.provider.trim() ? { provider: record.provider.trim().slice(0, 80) } : {}),
    ...(percentage !== undefined ? { percentage } : {}),
    ...(typeof record.period === 'string' && record.period.trim() ? { period: record.period.trim().slice(0, 40) } : {}),
    ...(typeof record.resetAt === 'string' && record.resetAt.trim() ? { resetAt: record.resetAt.trim().slice(0, 80) } : {}),
    message: typeof record.message === 'string' && record.message.trim()
      ? record.message.trim().slice(0, 240)
      : record.available ? '已读取官方客户端剩余额度' : '官方客户端暂时没有显示剩余额度',
  };
}

function isComposerPreferences(value: unknown): value is Record<string, unknown> {
  const record = asRecord(value);
  return Boolean(
    record
    && typeof record.model === 'string'
    && typeof record.effort === 'string'
    && Array.isArray(record.models)
    && Array.isArray(record.efforts),
  );
}

function turnIdFromResponse(value: unknown): string | undefined {
  const turn = asRecord(asRecord(value)?.turn);
  return typeof turn?.id === 'string' ? turn.id : undefined;
}

function privateIpv4Addresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address)) addresses.push(entry.address);
    }
  }
  return addresses;
}
