import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';

export type RpcId = number;

export interface RpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

export interface RpcServerRequest extends RpcNotification {
  id: RpcId;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class RpcResponseError extends Error {
  constructor(readonly rpcError: RpcErrorShape) {
    super(`RPC ${rpcError.code}: ${rpcError.message}`);
    this.name = 'RpcResponseError';
  }
}

export class LineRpcClient extends EventEmitter {
  #nextId = 1;
  #buffer = '';
  #closed = false;
  #pending = new Map<RpcId, PendingRequest>();

  constructor(
    private readonly input: Writable,
    output: Readable,
    private readonly timeoutMs = 30_000,
  ) {
    super();
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => this.#consume(chunk));
    output.on('end', () => this.close(new Error('RPC output ended')));
    output.on('error', (error) => this.close(error));
    input.on('error', (error) => this.close(error));
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('RPC client is closed'));
    const id = this.#nextId++;
    const payload = params === undefined ? { id, method } : { id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`RPC request timed out: ${method}`));
      }, this.timeoutMs);

      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.input.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        const pending = this.#pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        pending.reject(error);
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.#closed) throw new Error('RPC client is closed');
    const payload = params === undefined ? { method } : { method, params };
    this.input.write(`${JSON.stringify(payload)}\n`);
  }

  respond(id: RpcId, result: unknown): void {
    if (this.#closed) throw new Error('RPC client is closed');
    this.input.write(`${JSON.stringify({ id, result })}\n`);
  }

  close(reason = new Error('RPC client closed')): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.#pending.clear();
    this.emit('close', reason);
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line) this.#handleLine(line);
    }
  }

  #handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.emit('protocolError', new Error('RPC peer returned invalid JSON'));
      return;
    }

    if (typeof message.id === 'number' && typeof message.method === 'string') {
      this.emit('serverRequest', { id: message.id, method: message.method, params: message.params } satisfies RpcServerRequest);
      return;
    }

    if (typeof message.id === 'number') {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.error && typeof message.error === 'object') {
        pending.reject(new RpcResponseError(message.error as unknown as RpcErrorShape));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === 'string') {
      const notification: RpcNotification = { method: message.method, params: message.params };
      this.emit('notification', notification);
      this.emit(`notification:${message.method}`, message.params);
    }
  }
}
