import { spawn } from 'node:child_process';
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
    await this.connect();
    try {
      return await this.#rpc!.request<T>(method, params);
    } catch (error) {
      if (error instanceof RpcResponseError || this.#closed) throw error;
      this.#reset();
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
        this.request('fs/readDirectory', { path: directory }).then(() => true, () => false),
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
    const rpc = new LineRpcClient(child.stdin, child.stdout, 15_000);
    this.#rpc = rpc;
    rpc.on('notification', (notification: RpcNotification) => {
      for (const listener of this.#notificationListeners) listener(notification);
    });
    rpc.on('serverRequest', (request: RpcServerRequest) => {
      for (const listener of this.#requestListeners) listener(request);
    });
    child.once('exit', () => this.#reset(child));
    rpc.once('close', () => this.#reset(child));
    try {
      await rpc.request('initialize', {
        clientInfo: {
          name: 'gpttool', title: 'GPTTool', version: this.options.clientVersion ?? '0.1.5',
        },
        capabilities: { experimentalApi: false },
      });
      rpc.notify('initialized', {});
    } catch (error) {
      this.#reset(child);
      throw error;
    }
  }

  #reset(expectedChild?: ChildProcessWithoutNullStreams): void {
    if (expectedChild && this.#child !== expectedChild) return;
    const rpc = this.#rpc;
    const child = this.#child;
    this.#rpc = undefined;
    this.#child = undefined;
    rpc?.close();
    if (child?.exitCode === null && !child.killed) child.kill();
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

/** Lists direct children through the official app-server filesystem API. */
export async function readOfficialDirectory(options: ReadDirectoryOptions): Promise<{ entries: OfficialDirectoryEntry[] }> {
  return requestOfficialAppServer(options, 'fs/readDirectory', { path: options.path });
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
    result.directories = await rpc.request('fs/readDirectory', { path: options.directory }).then(() => true, () => false);
    return result;
  } finally {
    rpc.close();
    child.stdin.end();
    if (child.exitCode === null) child.kill();
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
    rpc.close();
    child.stdin.end();
    if (child.exitCode === null) child.kill();
  }
}
