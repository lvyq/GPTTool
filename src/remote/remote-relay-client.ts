import { WebSocket } from 'ws';

interface RelayMessage {
  type: string;
  connectionId?: string;
  data?: string;
  messageId?: string;
  index?: number;
  total?: number;
  publicUrl?: string;
  message?: string;
  kind?: string;
  key?: string;
  value?: unknown;
  updatedAt?: number;
  records?: PersistentRelayRecord[];
  requestId?: string;
  command?: string;
  serviceState?: string;
}

export interface PersistentRelayRecord {
  kind: string;
  key: string;
  value: unknown;
  updatedAt: number;
}

const DIRECT_MESSAGE_BYTES = 64 * 1024;
const CHUNK_BYTES = 96 * 1024;
const MAX_RELAY_MESSAGE_BYTES = 16 * 1024 * 1024;

export interface RemoteRelayClientOptions {
  relayUrl: string;
  deviceToken: string;
  deviceId: string;
  localPort?: number;
  localToken?: string;
  resolveLocalEndpoint?: () => { port: number; token: string } | undefined;
  onCommand?: (command: string) => Promise<void>;
  onPublicUrl?: (url: string) => void;
  onState?: (state: 'connecting' | 'connected' | 'disconnected', message?: string) => void;
  onPersistentState?: (records: PersistentRelayRecord[]) => void;
  reconnectDelayMs?: number;
}

export class RemoteRelayClient {
  #relay?: WebSocket;
  #locals = new Map<string, WebSocket>();
  #pendingLocalMessages = new Map<string, string[]>();
  #stopped = true;
  #reconnectTimer?: NodeJS.Timeout;
  #messageSequence = 0;
  #pendingState = new Map<string, RelayMessage>();
  #serviceStatus: RelayMessage = { type: 'device.status', serviceState: 'standby', message: 'GPTTool 后台在线，可远程启动' };

  constructor(private readonly options: RemoteRelayClientOptions) {}

  get running(): boolean { return !this.#stopped; }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    for (const socket of this.#locals.values()) socket.close(1001, 'Relay stopped');
    this.#locals.clear();
    this.#pendingLocalMessages.clear();
    this.#relay?.close(1000, 'Client stopped');
    this.#relay = undefined;
  }

  #connect(): void {
    if (this.#stopped) return;
    this.options.onState?.('connecting');
    const relay = new WebSocket(this.options.relayUrl, {
      headers: { Authorization: `Bearer ${this.options.deviceToken}`, 'X-GPTTool-Device-Id': this.options.deviceId },
      handshakeTimeout: 15_000,
      maxPayload: 512 * 1024,
    });
    this.#relay = relay;
    relay.on('open', () => {
      this.options.onState?.('connected');
      this.#send(this.#serviceStatus);
      for (const message of this.#pendingState.values()) this.#send(message);
      this.#pendingState.clear();
    });
    relay.on('message', (raw) => this.#handleRelayMessage(raw.toString()));
    relay.on('error', (error) => this.options.onState?.('disconnected', error.message));
    relay.on('close', (code, reason) => {
      if (this.#relay !== relay) return;
      this.#relay = undefined;
      for (const socket of this.#locals.values()) socket.close(1012, 'Relay disconnected');
      this.#locals.clear();
      this.#pendingLocalMessages.clear();
      if (this.#stopped) return;
      if (code === 4009) {
        this.#stopped = true;
        this.options.onState?.('disconnected', reason.toString() || '同一设备已在另一个 GPTTool 实例中连接');
        return;
      }
      this.options.onState?.('disconnected', '公网中继已断开，正在重连');
      this.#reconnectTimer = setTimeout(() => this.#connect(), this.options.reconnectDelayMs ?? 3_000);
    });
  }

  persistState(kind: string, key: string, value: unknown): void {
    const message: RelayMessage = { type: 'device.state.put', kind, key, value, updatedAt: Date.now() };
    if (this.#relay?.readyState === WebSocket.OPEN) this.#send(message);
    else this.#pendingState.set(`${kind}:${key}`, message);
  }

  deleteState(kind: string, key: string): void {
    const message: RelayMessage = { type: 'device.state.delete', kind, key };
    if (this.#relay?.readyState === WebSocket.OPEN) this.#send(message);
    else this.#pendingState.set(`${kind}:${key}`, message);
  }

  updateServiceState(serviceState: string, message?: string): void {
    this.#serviceStatus = { type: 'device.status', serviceState, message };
    this.#send(this.#serviceStatus);
  }

  #handleRelayMessage(raw: string): void {
    let message: RelayMessage;
    try { message = JSON.parse(raw) as RelayMessage; } catch { return; }
    if (message.type === 'relay.ready' && message.publicUrl) {
      this.options.onPublicUrl?.(message.publicUrl);
      return;
    }
    if (message.type === 'device.state.snapshot' && Array.isArray(message.records)) {
      this.options.onPersistentState?.(message.records);
      return;
    }
    if (message.type === 'device.command' && message.command) {
      void this.#handleCommand(message);
      return;
    }
    if (!message.connectionId) return;
    if (message.type === 'browser.open') this.#openLocal(message.connectionId);
    else if (message.type === 'browser.message' && typeof message.data === 'string') {
      const local = this.#locals.get(message.connectionId);
      if (local?.readyState === WebSocket.OPEN) local.send(message.data);
      else if (local?.readyState === WebSocket.CONNECTING) this.#pendingLocalMessages.get(message.connectionId)?.push(message.data);
    }
    else if (message.type === 'browser.close') this.#closeLocal(message.connectionId);
  }

  #openLocal(connectionId: string): void {
    if (this.#locals.has(connectionId)) return;
    const endpoint = this.options.resolveLocalEndpoint?.()
      ?? (this.options.localPort && this.options.localToken ? { port: this.options.localPort, token: this.options.localToken } : undefined);
    if (!endpoint) {
      this.#send({ type: 'browser.error', connectionId, message: '远程控制尚未启动，请先在设备页点击启动' });
      return;
    }
    const local = new WebSocket(`ws://127.0.0.1:${endpoint.port}/ws`, {
      headers: { Cookie: `astergate_session=${endpoint.token}` },
      maxPayload: MAX_RELAY_MESSAGE_BYTES,
    });
    this.#locals.set(connectionId, local);
    this.#pendingLocalMessages.set(connectionId, []);
    local.on('message', (data) => this.#forwardLocalMessage(connectionId, data.toString()));
    local.on('open', () => {
      for (const data of this.#pendingLocalMessages.get(connectionId) ?? []) local.send(data);
      this.#pendingLocalMessages.delete(connectionId);
      this.#send({ type: 'browser.ready', connectionId });
    });
    local.on('error', (error) => this.#send({ type: 'browser.error', connectionId, message: error.message }));
    local.on('close', () => {
      this.#locals.delete(connectionId);
      this.#pendingLocalMessages.delete(connectionId);
      this.#send({ type: 'browser.close', connectionId });
    });
  }

  async #handleCommand(message: RelayMessage): Promise<void> {
    try {
      await this.options.onCommand?.(message.command!);
      this.#send({ type: 'device.command.result', requestId: message.requestId, command: message.command, serviceState: 'running' });
    } catch (error) {
      this.#send({
        type: 'device.command.result', requestId: message.requestId, command: message.command,
        serviceState: 'failed', message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #closeLocal(connectionId: string): void {
    this.#locals.get(connectionId)?.close(1000, 'Browser closed');
    this.#locals.delete(connectionId);
    this.#pendingLocalMessages.delete(connectionId);
  }

  #send(message: RelayMessage): void {
    if (this.#relay?.readyState === WebSocket.OPEN) this.#relay.send(JSON.stringify(message));
  }

  #forwardLocalMessage(connectionId: string, data: string): void {
    const payload = Buffer.from(data, 'utf8');
    if (payload.byteLength > MAX_RELAY_MESSAGE_BYTES) {
      this.#send({ type: 'browser.error', connectionId, message: '远程响应超过 16MB 安全限制' });
      this.#closeLocal(connectionId);
      return;
    }
    if (payload.byteLength <= DIRECT_MESSAGE_BYTES) {
      this.#send({ type: 'browser.message', connectionId, data });
      return;
    }
    const messageId = `${Date.now().toString(36)}-${(++this.#messageSequence).toString(36)}`;
    const total = Math.ceil(payload.byteLength / CHUNK_BYTES);
    for (let index = 0; index < total; index += 1) {
      const start = index * CHUNK_BYTES;
      this.#send({
        type: 'browser.message.chunk', connectionId, messageId, index, total,
        data: payload.subarray(start, Math.min(start + CHUNK_BYTES, payload.byteLength)).toString('base64'),
      });
    }
  }
}
