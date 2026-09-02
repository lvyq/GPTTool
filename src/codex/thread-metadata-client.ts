import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { LineRpcClient, RpcResponseError, type RpcNotification, type RpcServerRequest } from '../runtime/line-rpc-client.ts';

export interface SetThreadNameOptions {
  executable: string;
  env?: NodeJS.ProcessEnv;
  clientVersion?: string;
  threadId: string;
  name: string;
}

export interface CreateDirectoryOptions {
  executable: string;
  env?: NodeJS.ProcessEnv;
  clientVersion?: string;
  path: string;
}

export interface ReadDirectoryOptions {
  executable: string;
  env?: NodeJS.ProcessEnv;
  clientVersion?: string;
  path: string;
}

export interface OfficialDirectoryEntry {
  fileName: string;
  isDirectory: boolean;
  isFile: boolean;
}

export interface OfficialAppServerCompatibility {
  runtimeVersion?: string;
  initialized: boolean;
  threads: boolean;
  models: boolean;
  usage: boolean;
  directories: boolean;
}

export interface OfficialAppServerTransport {
  connect(): Promise<void>;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  respond(id: number, result: unknown): void;
  onNotification(listener: (notification: RpcNotification) => void): () => void;
  onServerRequest(listener: (request: RpcServerRequest) => void): () => void;
  probe(directory: string): Promise<OfficialAppServerCompatibility>;
  close(): Promise<void>;
}

export interface OfficialAppServerClientOptions {
  executable: string;
  env?: NodeJS.ProcessEnv;
  clientVersion?: string;
}

/**
 * One background app-server session for metadata, models, usage and filesystem
 * operations. Keeping it alive avoids visible renderer automation and removes
 * the process-start delay from every Web request.
 */
export class OfficialAppServerClient implements OfficialAppServerTransport {
  #child?: ChildProcessWithoutNullStreams;
  #rpc?: LineRpcClient;
  #connecting?: Promise<void>;
  #closed = false;
  #stderrTail = '';
  readonly #notificationListeners = new Set<(notification: RpcNotification) => void>();
  readonly #requestListeners = new Set<(request: RpcServerRequest) => void>();

  constructor(private readonly options: OfficialAppServerClientOptions) {}

  async connect(): Promise<void> {
    if (this.#rpc) return;
    if (this.#closed) throw new Error('官方 app-server 客户端已关闭');
    this.#connecting ??= this.#spawnAndInitialize().finally(() => { this.#connecting = undefined; });
    return this.#connecting;
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.#closed) throw new Error('官方 app-server 客户端已关闭');
    if (method === 'fs/readDirectory') {
      return await readHostDirectory((params as { path?: unknown } | undefined)?.path) as T;
    }
    await this.connect();
    const rpc = this.#rpc!;
    try {
      return await rpc.request<T>(method, params);
    } catch (error) {
      if (error instanceof RpcResponseError || this.#closed) throw error;
      // A second concurrent request may already have replaced this transport.
      // Never let a late failure tear down that newer healthy connection.
      this.#reset(undefined, rpc);
      await this.connect();
      return this.#rpc!.request<T>(method, params);
    }
  }

  respond(id: number, result: unknown): void {
    if (!this.#rpc) throw new Error('官方 app-server 尚未连接');
    this.#rpc.respond(id, result);
  }

  onNotification(listener: (notification: RpcNotification) => void): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  onServerRequest(listener: (request: RpcServerRequest) => void): () => void {
    this.#requestListeners.add(listener);
    return () => this.#requestListeners.delete(listener);
  }

  async probe(directory: string): Promise<OfficialAppServerCompatibility> {
    const result: OfficialAppServerCompatibility = {
      initialized: false, threads: false, models: false, usage: false, directories: false,
    };
    try {
      await this.connect();
      result.initialized = true;
      const [threads, models, usage, directories] = await Promise.all([
        this.request('thread/list', { limit: 1 }).then(() => true, () => false),
        this.request('model/list', {}).then(() => true, () => false),
        this.request('account/rateLimits/read', {}).then(() => true, () => false),
        this.request('fs/readDirectory', { path: homedir() }).then(() => true, () => false),
      ]);
      Object.assign(result, { threads, models, usage, directories });
    } catch {
      // A failed app-server is an optional compatibility loss. CDP messaging
      // remains available and the caller reports the reduced feature set.
    }
    return result;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#reset();
  }

  async #spawnAndInitialize(): Promise<void> {
    const child = spawn(this.options.executable, ['app-server', '--listen', 'stdio://'], {
      env: this.options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#child = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Always drain stderr. Leaving this pipe unread eventually blocks the
      // long-lived app-server and used to make reconnects race stale streams.
      this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-8_000);
    });
    const rpc = new LineRpcClient(child.stdin, child.stdout, 15_000);
    this.#rpc = rpc;
    rpc.on('notification', (notification: RpcNotification) => {
      for (const listener of this.#notificationListeners) listener(notification);
    });
    rpc.on('serverRequest', (request: RpcServerRequest) => {
      for (const listener of this.#requestListeners) listener(request);
    });
    child.once('error', () => this.#reset(child));
    child.once('exit', () => this.#reset(child));
    rpc.once('close', () => this.#reset(child, rpc));
    try {
      await rpc.request('initialize', {
        clientInfo: {
          name: 'gpttool', title: 'GPTTool', version: this.options.clientVersion ?? '0.1.5',
        },
        capabilities: { experimentalApi: false },
      });
      rpc.notify('initialized', {});
    } catch (error) {
      const detail = this.#stderrTail.trim();
      this.#reset(child);
      throw detail && error instanceof Error ? new Error(`${error.message}: ${detail}`) : error;
    }
  }

  #reset(expectedChild?: ChildProcessWithoutNullStreams, expectedRpc?: LineRpcClient): void {
    if (expectedChild && this.#child !== expectedChild) return;
    if (expectedRpc && this.#rpc !== expectedRpc) return;
    const rpc = this.#rpc;
    const child = this.#child;
    this.#rpc = undefined;
    this.#child = undefined;
    rpc?.close();
    if (child) {
      // Detach every old stream before spawning a replacement. This prevents
      // libuv callbacks belonging to a dead app-server from reaching the new
      // connection after a sleep/wake or relay reconnect cycle.
      child.stdout.pause();
      child.stderr.pause();
      if (child.exitCode === null && !child.killed) child.kill();
      // Destroy the native pipe handles before a replacement is spawned. The
      // remaining idempotent error listeners deliberately absorb late libuv
      // errors from the old transport.
      if (!child.stdin.destroyed) child.stdin.destroy();
      if (!child.stdout.destroyed) child.stdout.destroy();
      if (!child.stderr.destroyed) child.stderr.destroy();
    }
    this.#stderrTail = '';
  }
}

/**
 * Uses a short-lived official Codex app-server connection for metadata only.
 * Chat execution remains attached to the official desktop renderer through CDP.
 */
export async function setOfficialThreadName(options: SetThreadNameOptions): Promise<void> {
  await requestOfficialAppServer(options, 'thread/name/set', { threadId: options.threadId, name: options.name });
}

/** Creates a folder through the official app-server filesystem API. */
export async function createOfficialDirectory(options: CreateDirectoryOptions): Promise<void> {
  await requestOfficialAppServer(options, 'fs/createDirectory', { path: options.path, recursive: true });
}

/** Lists direct children on the same local host as the official app-server. */
export async function readOfficialDirectory(options: ReadDirectoryOptions): Promise<{ entries: OfficialDirectoryEntry[] }> {
  return readHostDirectory(options.path);
}

const pendingDirectoryReads = new Map<string, Promise<{ entries: OfficialDirectoryEntry[] }>>();

/** The app-server process and GPTTool share this host; browsing needs no RPC. */
export async function readHostDirectory(directory: unknown): Promise<{ entries: OfficialDirectoryEntry[] }> {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('目录必须是绝对路径');
  const target = path.resolve(directory);
  let pending = pendingDirectoryReads.get(target);
  if (!pending) {
    if (pendingDirectoryReads.size >= 3) throw new Error('目录读取仍在等待系统响应，请稍后重试');
    pending = readdir(target, { withFileTypes: true }).then((entries) => ({
      entries: entries.map((entry) => ({ fileName: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() })),
    }));
    pendingDirectoryReads.set(target, pending);
    const clear = () => { pendingDirectoryReads.delete(target); };
    void pending.then(clear, clear);
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('目录读取超时，请在电脑上检查文件夹访问权限或云盘状态后重试')), 3000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Probes stable app-server methods without changing tasks or account state. */
export async function probeOfficialAppServerCompatibility(options: {
  executable: string;
  env?: NodeJS.ProcessEnv;
  clientVersion?: string;
  directory: string;
}): Promise<OfficialAppServerCompatibility> {
  const child = spawn(options.executable, ['app-server', '--listen', 'stdio://'], {
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const rpc = new LineRpcClient(child.stdin, child.stdout, 12_000);
  // The probe is short lived, but stderr still has to be consumed. A child
  // that writes enough diagnostics can otherwise leave a native pipe pending
  // while the next probe is already being created.
  child.stderr.resume();
  const result: OfficialAppServerCompatibility = {
    initialized: false, threads: false, models: false, usage: false, directories: false,
  };
  try {
    const initialized = await rpc.request<Record<string, unknown>>('initialize', {
      clientInfo: { name: 'gpttool', title: 'GPTTool', version: options.clientVersion ?? '0.1.5' },
      capabilities: { experimentalApi: false },
    });
    result.initialized = true;
    result.runtimeVersion = String(initialized?.userAgent || initialized?.serverInfo || '').trim() || undefined;
    rpc.notify('initialized', {});
    result.threads = await rpc.request('thread/list', { limit: 1 }).then(() => true, () => false);
    result.models = await rpc.request('model/list', {}).then(() => true, () => false);
    result.usage = await rpc.request('account/rateLimits/read', {}).then(() => true, () => false);
    result.directories = await readHostDirectory(homedir()).then(() => true, () => false);
    return result;
  } finally {
    disposeAppServerChild(child, rpc);
  }
}

async function requestOfficialAppServer<T = unknown>(
  options: Pick<SetThreadNameOptions, 'executable' | 'env' | 'clientVersion'>,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const child = spawn(options.executable, ['app-server', '--listen', 'stdio://'], {
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const rpc = new LineRpcClient(child.stdin, child.stdout, 15_000);
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_000); });

  try {
    await rpc.request('initialize', {
      clientInfo: {
        name: 'gpttool',
        title: 'GPTTool',
        version: options.clientVersion ?? '0.1.5',
      },
      capabilities: { experimentalApi: false },
    });
    rpc.notify('initialized', {});
    return await rpc.request<T>(method, params);
  } catch (error) {
    const detail = stderr.trim();
    throw new Error(detail ? `${error instanceof Error ? error.message : String(error)}: ${detail}` : String(error));
  } finally {
    disposeAppServerChild(child, rpc);
  }
}

function disposeAppServerChild(child: ChildProcessWithoutNullStreams, rpc: LineRpcClient): void {
  rpc.close();
  child.stdout.pause();
  child.stderr.pause();
  if (child.exitCode === null && !child.killed) child.kill();
  // Destroy all native pipe handles synchronously. Calling stdin.end() and
  // immediately spawning another app-server left libuv allocation callbacks
  // alive after the owning Node stream had already been released.
  if (!child.stdin.destroyed) child.stdin.destroy();
  if (!child.stdout.destroyed) child.stdout.destroy();
  if (!child.stderr.destroyed) child.stderr.destroy();
}
