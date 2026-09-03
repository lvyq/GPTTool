import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { RemoteCodexServer, type CodexBridge } from '../src/remote/remote-codex-server.ts';
import type { RpcNotification, RpcServerRequest } from '../src/runtime/line-rpc-client.ts';

class FakeCodex implements CodexBridge {
  calls: Array<{ method: string; params: unknown }> = [];
  responses: Array<{ id: number; result: unknown }> = [];
  notificationListeners = new Set<(value: RpcNotification) => void>();
  requestListeners = new Set<(value: RpcServerRequest) => void>();
  turnSequence = 0;
  failNextTurnStart?: Error;
  usagePercentage = 100;
  request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'account/usage/get') {
      return Promise.resolve({
        available: true,
        percentage: this.usagePercentage,
        period: '1 周',
        resetAt: '8月4日',
        message: `1 周剩余 ${this.usagePercentage}%，8月4日重置`,
      } as T);
    }
    if (method === 'thread/read' && (params as { threadId?: string } | undefined)?.threadId === 'preview-thread') {
      return Promise.resolve({
        thread: {
          id: 'preview-thread',
          turns: [{
            id: 'preview-turn',
            status: 'completed',
            items: [{
              id: 'preview-message',
              type: 'userMessage',
              status: 'completed',
              content: [
                { type: 'text', text: '查看图片' },
                { type: 'attachment', name: 'screen.png', mimeType: 'image/png', imageUrl: 'data:image/png;base64,dGh1bWI=' },
              ],
            }],
          }],
        },
      } as T);
    }
    if (method === 'thread/read' && (params as { threadId?: string } | undefined)?.threadId === 'large-thread') {
      return Promise.resolve({
        thread: {
          id: 'large-thread',
          name: 'Large thread',
          turns: [{
            id: 'turn-large',
            status: 'completed',
            items: [
              { id: 'tool-1', type: 'mcpToolCall', status: 'completed', server: 'example', tool: 'lookup', arguments: 'x'.repeat(300_000), result: 'y'.repeat(300_000) },
              { id: 'file-1', type: 'fileChange', status: 'completed', changes: [{ path: '/tmp/example.ts', diff: 'z'.repeat(300_000) }] },
              { id: 'message-1', type: 'agentMessage', text: '任务已完成' },
            ],
          }],
        },
      } as T);
    }
    if (method === 'thread/read' && (params as { threadId?: string } | undefined)?.threadId === 'paged-thread') {
      const limit = (params as { turnLimit?: number }).turnLimit ?? 120;
      const turns = Array.from({ length: 30 }, (_, index) => ({
        id: `turn-${index}`,
        status: 'completed',
        items: [{ id: `message-${index}`, type: 'agentMessage', status: 'completed', text: `reply-${index}` }],
      }));
      return Promise.resolve({ thread: { id: 'paged-thread', turns: turns.slice(-limit) } } as T);
    }
    if (method === 'thread/read' || method === 'thread/resume') return Promise.resolve({ thread: { id: 'old-thread', turns: [] } } as T);
    if (method === 'thread/start') return Promise.resolve({ thread: { id: 'new-thread', turns: [] } } as T);
    if (method === 'fs/readDirectory') return Promise.resolve({ entries: [
      { fileName: 'Beta', isDirectory: true, isFile: false },
      { fileName: 'notes.txt', isDirectory: false, isFile: true },
      { fileName: '.hidden', isDirectory: true, isFile: false },
      { fileName: 'Alpha', isDirectory: true, isFile: false },
    ] } as T);
    if (method === 'turn/start') {
      if (this.failNextTurnStart) {
        const error = this.failNextTurnStart;
        this.failNextTurnStart = undefined;
        return Promise.reject(error);
      }
      this.turnSequence += 1;
      return Promise.resolve({ turn: { id: `turn-${this.turnSequence}` } } as T);
    }
    if (method === 'turn/steer') return Promise.resolve({ turnId: (params as { expectedTurnId?: string })?.expectedTurnId } as T);
    if (method === 'turn/interrupt') return Promise.resolve({} as T);
    return Promise.resolve({ data: [], nextCursor: null } as T);
  }
  respond(id: number, result: unknown): void { this.responses.push({ id, result }); }
  onNotification(listener: (value: RpcNotification) => void): () => void { this.notificationListeners.add(listener); return () => this.notificationListeners.delete(listener); }
  onServerRequest(listener: (value: RpcServerRequest) => void): () => void { this.requestListeners.add(listener); return () => this.requestListeners.delete(listener); }
  notify(method: string, params: unknown): void {
    for (const listener of this.notificationListeners) listener({ method, params });
  }
}

class PollingCodex extends FakeCodex {
  latestStatus: 'inProgress' | 'completed' = 'inProgress';

  override request<T>(method: string, params?: unknown): Promise<T> {
    const threadId = (params as { threadId?: string } | undefined)?.threadId;
    if (method === 'thread/read' && threadId === 'watched-thread') {
      this.calls.push({ method, params });
      return Promise.resolve({
        thread: {
          id: 'watched-thread',
          turns: [{ id: 'official-turn', status: this.latestStatus, items: [] }],
        },
      } as T);
    }
    if (method === 'thread/turns/list' && threadId === 'watched-thread') {
      this.calls.push({ method, params });
      return Promise.resolve({ data: [{ id: 'official-turn', status: this.latestStatus, items: [] }], nextCursor: null } as T);
    }
    return super.request(method, params);
  }
}

class SlowPreferenceCodex extends FakeCodex {
  override request<T>(method: string, params?: unknown): Promise<T> {
    if (method !== 'composer/preferences/get') return super.request(method, params);
    this.calls.push({ method, params });
    return new Promise((resolve) => setTimeout(() => resolve({
      model: '5.6 Sol',
      effort: 'medium',
      effortLabel: '中',
      efforts: [{ value: 'medium', label: '中' }],
      models: [{ value: '5.6 Sol', label: '5.6 Sol', efforts: [{ value: 'medium', label: '中' }] }],
    } as T), 300));
  }
}

class SlowUsageCodex extends FakeCodex {
  override request<T>(method: string, params?: unknown): Promise<T> {
    if (method !== 'account/usage/get') return super.request(method, params);
    this.calls.push({ method, params });
    return new Promise((resolve) => setTimeout(() => resolve({
      available: true,
      percentage: this.usagePercentage,
      period: '1 周',
      resetAt: '8月5日',
      message: `1 周剩余 ${this.usagePercentage}%，8月5日重置`,
    } as T), 120));
  }
}

class ExternalProviderCodex extends FakeCodex {
  override request<T>(method: string, params?: unknown): Promise<T> {
    if (method !== 'account/usage/get') return super.request(method, params);
    this.calls.push({ method, params });
    return Promise.resolve({
      available: false,
      enforced: false,
      provider: 'Kimi via CC Switch',
      message: '第三方服务自行管理用量',
    } as T);
  }
}

class OverflowPreviewCodex extends FakeCodex {
  readonly imageUrl = `data:image/png;base64,${'A'.repeat(1_000_000)}`;

  override request<T>(method: string, params?: unknown): Promise<T> {
    if (method !== 'thread/read' || (params as { threadId?: string } | undefined)?.threadId !== 'overflow-preview-thread') {
      return super.request(method, params);
    }
    this.calls.push({ method, params });
    const imageTurn = (index: number) => ({
      id: `preview-turn-${index}`,
      status: 'completed',
      items: [{
        id: index === 0 ? 'wanted-message' : `other-message-${index}`,
        type: 'userMessage',
        status: 'completed',
        content: [{ type: 'attachment', name: `screen-${index}.png`, mimeType: 'image/png', imageUrl: this.imageUrl }],
      }],
    });
    return Promise.resolve({
      thread: { id: 'overflow-preview-thread', turns: Array.from({ length: 10 }, (_, index) => imageTurn(index)) },
    } as T);
  }
}

test('reports a clear error instead of silently changing the fixed port', async () => {
  const blocker = createServer((_request, response) => response.end('occupied'));
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const blockerAddress = blocker.address();
  const occupiedPort = typeof blockerAddress === 'object' && blockerAddress ? blockerAddress.port : 0;
  const directory = await mkdtemp(path.join(tmpdir(), 'astergate-port-fallback-'));
  const server = new RemoteCodexServer({
    codex: new FakeCodex(),
    assetsDirectory: path.resolve('frontend/src/remote'),
    stateDirectory: directory,
    port: occupiedPort,
    allowLan: false,
  });
  try {
    await assert.rejects(() => server.start(), new RegExp(`固定端口 ${occupiedPort} 已被其他程序占用`));
    const blockerResponse = await fetch(`http://127.0.0.1:${occupiedPort}`);
    assert.equal(await blockerResponse.text(), 'occupied');
  } finally {
    await server.stop();
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('protects the remote UI with a token and forwards allowed RPC calls', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astergate-remote-'));
  const codex = new FakeCodex();
  const persisted: Array<{ kind: string; key: string; value: unknown }> = [];
  const server = new RemoteCodexServer({ codex, assetsDirectory: path.resolve('frontend/src/remote'), stateDirectory: directory, port: 0, allowLan: false, defaultCwd: '/safe/project', directoryRoot: '/Safe', onPersistentStateChange: (kind, key, value) => persisted.push({ kind, key, value }) });
  try {
    await server.start();
    const base = `http://127.0.0.1:${server.port}`;
    const denied = await fetch(base);
    assert.equal(denied.status, 401);

    const authorized = await fetch(`${base}/?token=${encodeURIComponent(server.token)}`, { redirect: 'manual' });
    assert.equal(authorized.status, 302);
    const cookie = authorized.headers.get('set-cookie');
    assert.match(cookie ?? '', /HttpOnly/);

    const page = await fetch(base, { headers: { cookie: cookie!.split(';')[0]! } });
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /Remote Codex/);
    assert.match(pageHtml, /rel="apple-touch-icon"[^>]+apple-touch-icon\.png/);
    assert.match(pageHtml, /apple-mobile-web-app-title" content="GPTTool"/);

    const touchIcon = await fetch(`${base}/apple-touch-icon.png`, { headers: { cookie: cookie!.split(';')[0]! } });
    assert.equal(touchIcon.status, 200);
    assert.equal(touchIcon.headers.get('content-type'), 'image/png');
    assert.deepEqual([...new Uint8Array(await touchIcon.arrayBuffer()).slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

    const result = await websocketRequest(`ws://127.0.0.1:${server.port}/ws`, cookie!.split(';')[0]!);
    assert.deepEqual(result.result, { data: [], nextCursor: null });
    assert.ok(codex.calls.some((call) => call.method === 'thread/list'));

    await websocketRequest(`ws://127.0.0.1:${server.port}/ws`, cookie!.split(';')[0]!, { id: 71, type: 'project.directory.create', path: '/Safe/NewProject' });
    assert.ok(codex.calls.some((call) => call.method === 'fs/createDirectory'
      && (call.params as { path?: string })?.path === '/Safe/NewProject'));

    const directoryList = await websocketRequest(`ws://127.0.0.1:${server.port}/ws`, cookie!.split(';')[0]!, { id: 73, type: 'project.directory.list', path: '/Safe' });
    assert.deepEqual(directoryList.result, { path: '/Safe', root: '/Safe', entries: [{ name: 'Alpha' }, { name: 'Beta' }] });
    const directoryRoot = await websocketRequest(`ws://127.0.0.1:${server.port}/ws`, cookie!.split(';')[0]!, { id: 74, type: 'project.directory.root' });
    assert.deepEqual(directoryRoot.result, { path: '/Safe' });
    const outsideDirectory = await websocketRequest(`ws://127.0.0.1:${server.port}/ws`, cookie!.split(';')[0]!, { id: 75, type: 'project.directory.list', path: '/Outside' });
    assert.equal(outsideDirectory.ok, false);
    assert.match(String(outsideDirectory.error ?? ''), /当前用户目录/);

    await websocketRequest(`ws://127.0.0.1:${server.port}/ws`, cookie!.split(';')[0]!, { id: 72, type: 'thread.rename', threadId: 'old-thread', name: '新的任务名称' });
    assert.ok(codex.calls.some((call) => call.method === 'thread/name/set'
      && (call.params as { threadId?: string; name?: string })?.threadId === 'old-thread'
      && (call.params as { name?: string })?.name === '新的任务名称'));

    const opened = await websocketRequest(`ws://127.0.0.1:${server.port}/ws`, cookie!.split(';')[0]!, { id: 8, type: 'thread.open', threadId: 'old-thread' });
    assert.deepEqual(opened.result, {
      thread: { id: 'old-thread', turns: [] },
      history: { offset: 0, nextOffset: 0, hasMore: false },
    });
    assert.ok(codex.calls.some((call) => call.method === 'thread/read'
      && (call.params as { threadId?: string })?.threadId === 'old-thread'));

    await websocketRequest(`ws://127.0.0.1:${server.port}/ws`, cookie!.split(';')[0]!, { id: 9, type: 'thread.create' });
    assert.ok(codex.calls.some((call) => call.method === 'thread/start'
      && (call.params as { cwd?: string })?.cwd === '/safe/project'));

    await websocketRequest(`ws://127.0.0.1:${server.port}/ws`, cookie!.split(';')[0]!, { id: 10, type: 'turn.start', threadId: 'new-thread', text: 'first turn' });
    assert.ok(codex.calls.some((call) => call.method === 'account/usage/get'));
    assert.ok(codex.calls.some((call) => call.method === 'turn/start'
      && (call.params as { threadId?: string })?.threadId === 'new-thread'));

    await websocketRequest(`ws://127.0.0.1:${server.port}/ws`, cookie!.split(';')[0]!, { id: 10, type: 'turn.start', threadId: 'old-thread', text: 'hello' });
    assert.ok(codex.calls.some((call) => call.method === 'thread/resume'
      && (call.params as { threadId?: string })?.threadId === 'old-thread'));
    assert.ok(codex.calls.some((call) => call.method === 'turn/start'
      && (call.params as { threadId?: string })?.threadId === 'old-thread'));

    const startsBeforeDuplicate = codex.calls.filter((call) => call.method === 'turn/start').length;
    const firstDelivery = await websocketRequest(`ws://127.0.0.1:${server.port}/ws`, cookie!.split(';')[0]!, {
      id: 101, type: 'turn.start', threadId: 'old-thread', text: 'weak network delivery', clientRequestId: 'weak-network-send-001',
    });
    const repeatedDelivery = await websocketRequest(`ws://127.0.0.1:${server.port}/ws`, cookie!.split(';')[0]!, {
      id: 102, type: 'turn.start', threadId: 'old-thread', text: 'weak network delivery', clientRequestId: 'weak-network-send-001',
    });
    assert.deepEqual(repeatedDelivery.result, firstDelivery.result);
    assert.equal(codex.calls.filter((call) => call.method === 'turn/start').length, startsBeforeDuplicate + 1);

    await websocketRequest(`ws://127.0.0.1:${server.port}/ws`, cookie!.split(';')[0]!, { id: 11, type: 'turn.interrupt', threadId: 'old-thread', turnId: 'turn-1' });
    assert.ok(codex.calls.some((call) => call.method === 'turn/interrupt'
      && (call.params as { turnId?: string })?.turnId === 'turn-1'));
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('serves persisted model settings immediately while refreshing official capabilities in the background', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astergate-preferences-cache-'));
  const codex = new SlowPreferenceCodex();
  const server = new RemoteCodexServer({
    codex,
    assetsDirectory: path.resolve('frontend/src/remote'),
    stateDirectory: directory,
    port: 0,
    allowLan: false,
  });
  server.restorePersistentState([{
    kind: 'preferences',
    key: 'composer',
    value: {
      model: '5.6 Luna',
      effort: 'high',
      effortLabel: '高',
      efforts: [{ value: 'high', label: '高' }],
      models: [{ value: '5.6 Luna', label: '5.6 Luna', efforts: [{ value: 'high', label: '高' }] }],
    },
  }]);
  try {
    await server.start();
    const cookie = await authorize(server);
    const startedAt = Date.now();
    const response = await websocketRequest(
      `ws://127.0.0.1:${server.port}/ws`,
      cookie,
      { id: 71, type: 'composer.preferences.get' },
    );
    assert.ok(Date.now() - startedAt < 200, 'cached preferences should not wait for the slow official-client probe');
    assert.equal((response.result as { model?: string }).model, '5.6 Luna');
    assert.equal((response.result as { cached?: boolean }).cached, true);
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an explicit quota request waits for the official value instead of returning a stale persisted snapshot', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astergate-usage-refresh-'));
  const codex = new SlowUsageCodex();
  codex.usagePercentage = 100;
  const server = new RemoteCodexServer({
    codex,
    assetsDirectory: path.resolve('frontend/src/remote'),
    stateDirectory: directory,
    port: 0,
    allowLan: false,
  });
  server.restorePersistentState([{
    kind: 'usage-snapshot',
    key: 'latest',
    value: {
      available: true,
      percentage: 58,
      period: '1 周',
      resetAt: '7月29日',
      message: '1 周剩余 58%，7月29日重置',
    },
  }]);
  try {
    await server.start();
    const cookie = await authorize(server);
    const response = await websocketRequest(
      `ws://127.0.0.1:${server.port}/ws`,
      cookie,
      { id: 72, type: 'account.usage.get' },
    );
    assert.equal((response.result as { percentage?: number }).percentage, 100);
    assert.equal((response.result as { cached?: boolean }).cached, undefined);
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('external providers replace a stale zero official quota and remain sendable', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astergate-external-provider-'));
  const codex = new ExternalProviderCodex();
  const server = new RemoteCodexServer({
    codex,
    assetsDirectory: path.resolve('frontend/src/remote'),
    stateDirectory: directory,
    port: 0,
    allowLan: false,
  });
  server.restorePersistentState([{
    kind: 'usage-snapshot',
    key: 'latest',
    value: {
      available: true,
      percentage: 0,
      period: '1 周',
      message: '官方额度已用完',
    },
  }]);
  try {
    await server.start();
    const cookie = await authorize(server);
    const usage = await websocketRequest(
      `ws://127.0.0.1:${server.port}/ws`,
      cookie,
      { id: 73, type: 'account.usage.get' },
    );
    assert.equal((usage.result as { enforced?: boolean }).enforced, false);
    await websocketRequest(
      `ws://127.0.0.1:${server.port}/ws`,
      cookie,
      { id: 74, type: 'turn.start', threadId: 'old-thread', text: 'use external provider' },
    );
    assert.ok(codex.calls.some((call) => call.method === 'turn/start'));
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('uploads attachment chunks, forwards a safe local file to Codex, and removes it after sending', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astergate-remote-file-'));
  const codex = new FakeCodex();
  const server = new RemoteCodexServer({ codex, assetsDirectory: path.resolve('frontend/src/remote'), stateDirectory: directory, port: 0, allowLan: false });
  try {
    await server.start();
    const cookie = await authorize(server);
    const url = `ws://127.0.0.1:${server.port}/ws`;
    await websocketRequest(url, cookie, { id: 60, type: 'thread.create' });
    const bytes = Buffer.from('remote attachment');
    const started = await websocketRequest(url, cookie, { id: 61, type: 'attachment.upload.start', name: '../sample.txt', mimeType: 'text/plain', size: bytes.length });
    const uploadId = (started.result as { uploadId: string }).uploadId;
    await websocketRequest(url, cookie, { id: 62, type: 'attachment.upload.chunk', uploadId, index: 0, data: bytes.subarray(0, 7).toString('base64') });
    await websocketRequest(url, cookie, { id: 63, type: 'attachment.upload.chunk', uploadId, index: 1, data: bytes.subarray(7).toString('base64') });
    const finished = await websocketRequest(url, cookie, { id: 64, type: 'attachment.upload.finish', uploadId });
    assert.deepEqual(finished.result, { id: uploadId, name: 'sample.txt', mimeType: 'text/plain', size: bytes.length });

    await websocketRequest(url, cookie, { id: 65, type: 'turn.start', threadId: 'new-thread', text: '', attachmentIds: [uploadId] });
    const start = codex.calls.filter((call) => call.method === 'turn/start').at(-1);
    const attachment = (start?.params as { attachments?: Array<{ path: string; name: string }> }).attachments?.[0];
    assert.equal(attachment?.name, 'sample.txt');
    assert.equal((await readFile(attachment!.path)).toString(), 'remote attachment', 'attachment must remain readable while Codex is running');
    codex.notify('turn/completed', { threadId: 'new-thread', turn: { id: 'turn-1', status: 'completed' } });
    await waitFor(async () => {
      try { await readFile(attachment!.path); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
    });
    await assert.rejects(readFile(attachment!.path), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('blocks direct and queued messages when the official Codex quota is exhausted', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astergate-remote-quota-'));
  const codex = new FakeCodex();
  codex.usagePercentage = 0;
  const server = new RemoteCodexServer({
    codex,
    assetsDirectory: path.resolve('frontend/src/remote'),
    stateDirectory: directory,
    port: 0,
    allowLan: false,
  });
  try {
    await server.start();
    const cookie = await authorize(server);
    const url = `ws://127.0.0.1:${server.port}/ws`;
    const direct = await websocketRequest(url, cookie, {
      id: 66,
      type: 'turn.start',
      threadId: 'old-thread',
      text: 'must not be sent',
    });
    assert.equal(direct.ok, false);
    assert.match(String(direct.error), /剩余额度已用完/);

    codex.notify('turn/started', { threadId: 'old-thread', turn: { id: 'active-turn', status: 'inProgress' } });
    const queued = await websocketRequest(url, cookie, {
      id: 67,
      type: 'turn.queue',
      threadId: 'old-thread',
      text: 'must not be queued',
    });
    assert.equal(queued.ok, false);
    assert.match(String(queued.error), /剩余额度已用完/);
    assert.equal(codex.calls.filter((call) => call.method === 'turn/start').length, 0);
    const snapshot = await websocketRequest(url, cookie, { id: 68, type: 'turn.queue.list', threadId: 'old-thread' });
    assert.deepEqual((snapshot.result as { items: unknown[] }).items, []);
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('loads history image previews separately from the initial thread response', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astergate-remote-preview-'));
  const codex = new FakeCodex();
  const server = new RemoteCodexServer({ codex, assetsDirectory: path.resolve('frontend/src/remote'), stateDirectory: directory, port: 0, allowLan: false });
  try {
    await server.start();
    const cookie = await authorize(server);
    const url = `ws://127.0.0.1:${server.port}/ws`;
    const opened = await websocketRequest(url, cookie, { id: 70, type: 'thread.open', threadId: 'preview-thread' });
    const content = (opened.result as { thread: { turns: Array<{ items: Array<{ content: Array<Record<string, unknown>> }> }> } })
      .thread.turns[0]!.items[0]!.content;
    assert.deepEqual(content[1], { type: 'attachment', name: 'screen.png', mimeType: 'image/png', hasPreview: true });
    assert.equal(JSON.stringify(opened).includes('dGh1bWI='), false, 'initial response must not inline image bytes');

    const preview = await websocketRequest(url, cookie, {
      id: 71, type: 'attachment.preview', threadId: 'preview-thread', itemId: 'preview-message', attachmentIndex: 0,
    });
    assert.deepEqual(preview.result, { imageUrl: 'data:image/png;base64,dGh1bWI=' });
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('loads an older image on demand when the bounded preview cache is full', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astergate-remote-preview-overflow-'));
  const codex = new OverflowPreviewCodex();
  const server = new RemoteCodexServer({ codex, assetsDirectory: path.resolve('frontend/src/remote'), stateDirectory: directory, port: 0, allowLan: false });
  try {
    await server.start();
    const cookie = await authorize(server);
    const url = `ws://127.0.0.1:${server.port}/ws`;
    const opened = await websocketRequest(url, cookie, { id: 72, type: 'thread.open', threadId: 'overflow-preview-thread' });
    assert.equal(JSON.stringify(opened).includes(codex.imageUrl), false, 'initial response must remain compact');

    const preview = await websocketRequest(url, cookie, {
      id: 73, type: 'attachment.preview', threadId: 'overflow-preview-thread', itemId: 'wanted-message', attachmentIndex: 0,
    });
    assert.deepEqual(preview.result, { imageUrl: codex.imageUrl });
    assert.equal(codex.calls.filter((call) => call.method === 'thread/read').length, 2, 'cache miss should re-read the official rollout once');
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('compacts large thread history before sending it to the remote UI', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astergate-remote-large-'));
  const codex = new FakeCodex();
  const server = new RemoteCodexServer({ codex, assetsDirectory: path.resolve('frontend/src/remote'), stateDirectory: directory, port: 0, allowLan: false });
  try {
    await server.start();
    const base = `http://127.0.0.1:${server.port}`;
    const authorized = await fetch(`${base}/?token=${encodeURIComponent(server.token)}`, { redirect: 'manual' });
    const cookie = authorized.headers.get('set-cookie')!.split(';')[0]!;
    const opened = await websocketRequest(`ws://127.0.0.1:${server.port}/ws`, cookie, { id: 12, type: 'thread.open', threadId: 'large-thread' });
    const result = opened.result as { thread: { turns: Array<{ items: Array<Record<string, unknown>> }> } };
    const [tool, fileChange, message] = result.thread.turns[0]!.items;

    assert.deepEqual(tool, { id: 'tool-1', type: 'mcpToolCall', status: 'completed', server: 'example', tool: 'lookup' });
    assert.deepEqual(fileChange, { id: 'file-1', type: 'fileChange', status: 'completed', changes: [{ path: '/tmp/example.ts' }] });
    assert.equal(message?.text, '任务已完成');
    assert.ok(JSON.stringify(opened).length < 2_000, 'compacted response should remain small');
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('pages older thread history without changing chronological turn order', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astergate-remote-history-'));
  const server = new RemoteCodexServer({
    codex: new FakeCodex(),
    assetsDirectory: path.resolve('frontend/src/remote'),
    stateDirectory: directory,
    port: 0,
    allowLan: false,
  });
  try {
    await server.start();
    const base = `http://127.0.0.1:${server.port}`;
    const authorized = await fetch(`${base}/?token=${encodeURIComponent(server.token)}`, { redirect: 'manual' });
    const cookie = authorized.headers.get('set-cookie')!.split(';')[0]!;
    const socketUrl = `ws://127.0.0.1:${server.port}/ws`;
    const newest = await websocketRequest(socketUrl, cookie, { id: 80, type: 'thread.open', threadId: 'paged-thread' });
    const older = await websocketRequest(socketUrl, cookie, { id: 81, type: 'thread.history', threadId: 'paged-thread', offset: 6, limit: 12 });
    const oldest = await websocketRequest(socketUrl, cookie, { id: 82, type: 'thread.history', threadId: 'paged-thread', offset: 18, limit: 12 });
    const turnIds = [oldest, older, newest].flatMap((page) => (
      (page.result as { thread: { turns: Array<{ id: string }> } }).thread.turns.map((turn) => turn.id)
    ));
    assert.deepEqual(turnIds, Array.from({ length: 30 }, (_, index) => `turn-${index}`));
    assert.equal(new Set(turnIds).size, 30, 'pagination must not duplicate turns');
    assert.deepEqual((oldest.result as { history: unknown }).history, { offset: 18, nextOffset: 30, hasMore: false });
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('queues, reorders, removes and steers turns, then dispatches queued work in order', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astergate-remote-queue-'));
  const codex = new FakeCodex();
  const server = new RemoteCodexServer({ codex, assetsDirectory: path.resolve('frontend/src/remote'), stateDirectory: directory, port: 0, allowLan: false });
  let observer: WebSocket | undefined;
  try {
    await server.start();
    const cookie = await authorize(server);
    const url = `ws://127.0.0.1:${server.port}/ws`;
    const observed: Array<Record<string, unknown>> = [];
    observer = await openWebSocket(url, cookie, (message) => observed.push(message));

    codex.notify('turn/started', { threadId: 'queue-thread', turn: { id: 'external-turn', status: 'inProgress' } });
    const first = await websocketRequest(url, cookie, { id: 20, type: 'turn.queue', threadId: 'queue-thread', text: 'first queued', mode: 'plan' });
    const second = await websocketRequest(url, cookie, { id: 21, type: 'turn.queue', threadId: 'queue-thread', text: 'second queued', mode: 'goal' });
    const removable = await websocketRequest(url, cookie, { id: 22, type: 'turn.queue', threadId: 'queue-thread', text: 'remove me' });
    const firstItem = (first.result as { item: { id: string } }).item;
    const secondItem = (second.result as { item: { id: string } }).item;
    const removableItem = (removable.result as { item: { id: string } }).item;

    const reordered = await websocketRequest(url, cookie, { id: 23, type: 'turn.queue.reorder', threadId: 'queue-thread', queueId: secondItem.id, toIndex: 0 });
    assert.deepEqual((reordered.result as { items: Array<{ id: string }> }).items.map((item) => item.id), [secondItem.id, firstItem.id, removableItem.id]);
    const updated = await websocketRequest(url, cookie, { id: 24, type: 'turn.queue.update', threadId: 'queue-thread', queueId: secondItem.id, text: 'edited second queued' });
    assert.equal((updated.result as { items: Array<{ id: string; text: string }> }).items[0]?.text, 'edited second queued');
    const removed = await websocketRequest(url, cookie, { id: 25, type: 'turn.queue.remove', threadId: 'queue-thread', queueId: removableItem.id });
    assert.deepEqual((removed.result as { items: Array<{ id: string }> }).items.map((item) => item.id), [secondItem.id, firstItem.id]);

    const steer = await websocketRequest(url, cookie, { id: 26, type: 'turn.steer', threadId: 'queue-thread', turnId: 'external-turn', text: 'adjust the active turn' });
    assert.deepEqual(steer.result, { turnId: 'external-turn' });
    assert.deepEqual(codex.calls.find((call) => call.method === 'turn/steer'), {
      method: 'turn/steer',
      params: { threadId: 'queue-thread', expectedTurnId: 'external-turn', input: [{ type: 'text', text: 'adjust the active turn', text_elements: [] }] },
    });

    assert.equal(codex.calls.filter((call) => call.method === 'turn/start').length, 0, 'queued work must wait for the active turn');
    codex.notify('turn/completed', { threadId: 'queue-thread', turn: { id: 'external-turn', status: 'completed' } });
    await waitFor(() => codex.calls.filter((call) => call.method === 'turn/start').length === 1);
    assert.equal(turnText(codex.calls.filter((call) => call.method === 'turn/start')[0]), 'edited second queued');
    assert.equal((codex.calls.filter((call) => call.method === 'turn/start')[0]?.params as { mode?: string }).mode, 'goal');

    codex.notify('turn/completed', { threadId: 'queue-thread', turn: { id: 'turn-1', status: 'completed' } });
    await waitFor(() => codex.calls.filter((call) => call.method === 'turn/start').length === 2);
    assert.equal(turnText(codex.calls.filter((call) => call.method === 'turn/start')[1]), 'first queued');
    assert.equal((codex.calls.filter((call) => call.method === 'turn/start')[1]?.params as { mode?: string }).mode, 'plan');

    const recovered = await websocketRequest(url, cookie, { id: 27, type: 'turn.queue.list', threadId: 'queue-thread' });
    assert.deepEqual(recovered.result, { threadId: 'queue-thread', activeTurnId: 'turn-2', items: [] });
    assert.ok(observed.some((message) => message.type === 'queue.updated' && message.threadId === 'queue-thread'), 'queue changes should be broadcast');

    const invalid = await websocketRequest(url, cookie, { id: 28, type: 'turn.queue.reorder', threadId: 'queue-thread', queueId: firstItem.id, toIndex: -1 });
    assert.equal(invalid.ok, false);
    assert.match(String(invalid.error), /toIndex/);
  } finally {
    observer?.close();
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('polls turns started by another app-server and dispatches after they become idle', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astergate-remote-queue-watch-'));
  const codex = new PollingCodex();
  const server = new RemoteCodexServer({ codex, assetsDirectory: path.resolve('frontend/src/remote'), stateDirectory: directory, port: 0, allowLan: false });
  try {
    await server.start();
    const cookie = await authorize(server);
    const url = `ws://127.0.0.1:${server.port}/ws`;
    await websocketRequest(url, cookie, { id: 30, type: 'thread.open', threadId: 'watched-thread' });
    await websocketRequest(url, cookie, { id: 31, type: 'turn.queue', threadId: 'watched-thread', text: 'run after official client' });
    assert.equal(codex.calls.filter((call) => call.method === 'turn/start').length, 0);

    codex.latestStatus = 'completed';
    await waitFor(() => codex.calls.some((call) => call.method === 'turn/start'), 3_500);
    const start = codex.calls.find((call) => call.method === 'turn/start');
    assert.equal(turnText(start), 'run after official client');
    assert.ok(codex.calls.some((call) => call.method === 'thread/turns/list'));
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('restores queued work after a client restart and waits until the official turn is idle', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astergate-remote-queue-restart-'));
  const firstCodex = new PollingCodex();
  const firstServer = new RemoteCodexServer({
    codex: firstCodex,
    assetsDirectory: path.resolve('frontend/src/remote'),
    stateDirectory: directory,
    port: 0,
    allowLan: false,
  });
  try {
    await firstServer.start();
    const firstCookie = await authorize(firstServer);
    const firstUrl = `ws://127.0.0.1:${firstServer.port}/ws`;
    firstCodex.notify('turn/started', { threadId: 'watched-thread', turn: { id: 'official-turn', status: 'inProgress' } });
    const queued = await websocketRequest(firstUrl, firstCookie, {
      id: 32,
      type: 'turn.queue',
      threadId: 'watched-thread',
      text: 'survive the application update',
    });
    const queuedId = (queued.result as { item: { id: string } }).item.id;
    assert.equal(firstCodex.calls.filter((call) => call.method === 'turn/start').length, 0);
    await firstServer.stop();

    const restoredCodex = new PollingCodex();
    const restoredServer = new RemoteCodexServer({
      codex: restoredCodex,
      assetsDirectory: path.resolve('frontend/src/remote'),
      stateDirectory: directory,
      port: 0,
      allowLan: false,
    });
    try {
      await restoredServer.start();
      const restoredCookie = await authorize(restoredServer);
      const restoredUrl = `ws://127.0.0.1:${restoredServer.port}/ws`;
      const snapshot = await websocketRequest(restoredUrl, restoredCookie, {
        id: 33,
        type: 'turn.queue.list',
        threadId: 'watched-thread',
      });
      assert.equal((snapshot.result as { items: Array<{ id: string }> }).items[0]?.id, queuedId);
      assert.equal((snapshot.result as { items: Array<{ text: string }> }).items[0]?.text, 'survive the application update');
      await waitFor(() => restoredCodex.calls.some((call) => call.method === 'thread/turns/list'), 3_500);
      assert.equal(restoredCodex.calls.filter((call) => call.method === 'turn/start').length, 0, 'restored work must not duplicate an active official turn');

      restoredCodex.latestStatus = 'completed';
      await waitFor(() => restoredCodex.calls.filter((call) => call.method === 'turn/start').length === 1, 3_500);
      assert.equal(turnText(restoredCodex.calls.find((call) => call.method === 'turn/start')), 'survive the application update');
      assert.equal(restoredCodex.calls.filter((call) => call.method === 'turn/start').length, 1);
    } finally {
      await restoredServer.stop();
    }
  } finally {
    await firstServer.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('restores a server-side queue snapshot when the local queue file is unavailable', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astergate-remote-queue-relay-'));
  const codex = new PollingCodex();
  const server = new RemoteCodexServer({
    codex,
    assetsDirectory: path.resolve('frontend/src/remote'),
    stateDirectory: directory,
    port: 0,
    allowLan: false,
  });
  try {
    await server.start();
    server.restorePersistentState([{
      kind: 'turn-queue',
      key: 'watched-thread',
      value: {
        items: [{
          id: 'relay-queue-item',
          threadId: 'watched-thread',
          text: 'restore from PostgreSQL',
          createdAt: 1_700_000_000_000,
          status: 'queued',
        }],
      },
    }]);
    const cookie = await authorize(server);
    const url = `ws://127.0.0.1:${server.port}/ws`;
    const snapshot = await websocketRequest(url, cookie, { id: 34, type: 'turn.queue.list', threadId: 'watched-thread' });
    assert.equal((snapshot.result as { items: Array<{ text: string }> }).items[0]?.text, 'restore from PostgreSQL');
    await waitFor(() => codex.calls.some((call) => call.method === 'thread/turns/list'), 3_500);
    assert.equal(codex.calls.filter((call) => call.method === 'turn/start').length, 0);

    codex.latestStatus = 'completed';
    await waitFor(() => codex.calls.filter((call) => call.method === 'turn/start').length === 1, 3_500);
    assert.equal(turnText(codex.calls.find((call) => call.method === 'turn/start')), 'restore from PostgreSQL');
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('clears a completed active turn even when there are no queued messages', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astergate-remote-active-watch-'));
  const codex = new PollingCodex();
  const server = new RemoteCodexServer({ codex, assetsDirectory: path.resolve('frontend/src/remote'), stateDirectory: directory, port: 0, allowLan: false });
  try {
    await server.start();
    const cookie = await authorize(server);
    const url = `ws://127.0.0.1:${server.port}/ws`;
    codex.notify('turn/started', { threadId: 'watched-thread', turn: { id: 'official-turn', status: 'inProgress' } });
    const active = await websocketRequest(url, cookie, { id: 35, type: 'turn.queue.list', threadId: 'watched-thread' });
    assert.equal((active.result as { activeTurnId: string | null }).activeTurnId, 'official-turn');

    codex.latestStatus = 'completed';
    await waitFor(
      () => codex.calls.some((call) => call.method === 'thread/turns/list'),
      3_500,
    );
    await waitForQueueIdle(url, cookie, 'watched-thread', 3_500);
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('keeps a failed automatic start at the front and does not retry in a loop', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astergate-remote-queue-error-'));
  const codex = new FakeCodex();
  const server = new RemoteCodexServer({ codex, assetsDirectory: path.resolve('frontend/src/remote'), stateDirectory: directory, port: 0, allowLan: false });
  let observer: WebSocket | undefined;
  try {
    await server.start();
    const cookie = await authorize(server);
    const url = `ws://127.0.0.1:${server.port}/ws`;
    const observed: Array<Record<string, unknown>> = [];
    observer = await openWebSocket(url, cookie, (message) => observed.push(message));
    codex.notify('turn/started', { threadId: 'failure-thread', turn: { id: 'active-turn', status: 'inProgress' } });
    const queued = await websocketRequest(url, cookie, { id: 40, type: 'turn.queue', threadId: 'failure-thread', text: 'do not lose me' });
    const queueId = (queued.result as { item: { id: string } }).item.id;
    codex.failNextTurnStart = new Error('app-server temporarily unavailable');
    codex.notify('turn/completed', { threadId: 'failure-thread', turn: { id: 'active-turn', status: 'completed' } });

    await waitFor(() => observed.some((message) => message.type === 'queue.error'));
    const snapshot = await websocketRequest(url, cookie, { id: 41, type: 'turn.queue.list', threadId: 'failure-thread' });
    assert.deepEqual((snapshot.result as { items: Array<{ id: string; status: string }> }).items, [{
      id: queueId,
      threadId: 'failure-thread',
      text: 'do not lose me',
      createdAt: (snapshot.result as { items: Array<{ createdAt: number }> }).items[0]!.createdAt,
      status: 'queued',
    }]);
    await new Promise((resolve) => setTimeout(resolve, 1_900));
    assert.equal(codex.calls.filter((call) => call.method === 'turn/start').length, 1, 'failed queued work must not retry without user action');
    assert.ok(observed.some((message) => message.type === 'queue.error' && message.threadId === 'failure-thread' && /temporarily unavailable/.test(String(message.message))));
  } finally {
    observer?.close();
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('keeps automatic approval opt-in disabled by default and restores the saved preference', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astergate-remote-approval-'));
  const firstCodex = new FakeCodex();
  const firstServer = new RemoteCodexServer({ codex: firstCodex, assetsDirectory: path.resolve('frontend/src/remote'), stateDirectory: directory, port: 0, allowLan: false });
  try {
    await firstServer.start();
    const firstCookie = await authorize(firstServer);
    const firstUrl = `ws://127.0.0.1:${firstServer.port}/ws`;
    const initial = await websocketRequest(firstUrl, firstCookie, { id: 50, type: 'approval.auto.get' });
    assert.deepEqual(initial.result, { enabled: false });

    const enabled = await websocketRequest(firstUrl, firstCookie, { id: 51, type: 'approval.auto.set', enabled: true });
    assert.deepEqual(enabled.result, { enabled: true });
    assert.deepEqual(firstCodex.calls.at(-1), { method: 'approval/auto/set', params: { enabled: true } });
    await firstServer.stop();

    const restoredCodex = new FakeCodex();
    const restoredServer = new RemoteCodexServer({ codex: restoredCodex, assetsDirectory: path.resolve('frontend/src/remote'), stateDirectory: directory, port: 0, allowLan: false });
    try {
      await restoredServer.start();
      assert.deepEqual(restoredCodex.calls[0], { method: 'approval/auto/set', params: { enabled: true } });
      const restoredCookie = await authorize(restoredServer);
      const restored = await websocketRequest(`ws://127.0.0.1:${restoredServer.port}/ws`, restoredCookie, { id: 52, type: 'approval.auto.get' });
      assert.deepEqual(restored.result, { enabled: true });
    } finally {
      await restoredServer.stop();
    }
  } finally {
    await firstServer.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('unified model settings serialize application and distinguish a speed failure from full success', async () => {
  class SettingsCodex extends FakeCodex {
    currentModel = 'Sol';
    currentSpeed = 'standard';
    supported = true;
    override async request<T>(method: string, params?: unknown): Promise<T> {
      const input = params as { model?: string; speed?: string; effort?: string } | undefined;
      if (method === 'composer/preferences/set') {
        this.calls.push({ method, params });
        this.currentModel = input!.model!;
        await new Promise(resolve => setTimeout(resolve, 10));
        return { model: this.currentModel, effort: input!.effort, models: [], efforts: [] } as T;
      }
      if (method === 'composer/speed/get' || method === 'composer/speed/set') {
        this.calls.push({ method, params });
        if (method.endsWith('/set')) {
          assert.equal(input!.model, this.currentModel);
          this.currentSpeed = input!.speed!;
        }
        return { model: this.currentModel, available: this.supported, current: this.currentSpeed,
          options: this.supported ? [{ value: 'standard' }, { value: 'fast' }] : [] } as T;
      }
      return super.request(method, params);
    }
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'gpttool-settings-'));
  const codex = new SettingsCodex();
  const server = new RemoteCodexServer({ codex, assetsDirectory: path.resolve('frontend/src/remote'), stateDirectory: directory, port: 0 });
  try {
    await server.start();
    const cookie = await authorize(server);
    const url = `ws://127.0.0.1:${server.port}/ws`;
    const [first, second] = await Promise.all([
      websocketRequest(url, cookie, { id: 91, type: 'composer.settings.apply', model: 'Terra', effort: 'medium', speed: 'fast' }),
      websocketRequest(url, cookie, { id: 92, type: 'composer.settings.apply', model: 'Sol', effort: 'high', speed: 'standard' }),
    ]);
    assert.equal((first.result as { applied: boolean }).applied, true);
    assert.equal((second.result as { applied: boolean }).applied, true);
    assert.deepEqual(codex.calls.filter(call => call.method === 'composer/preferences/set' || call.method.startsWith('composer/speed')).map(call => call.method), [
      'composer/preferences/set', 'composer/speed/get', 'composer/speed/set',
      'composer/preferences/set', 'composer/speed/get', 'composer/speed/set',
    ]);
    codex.supported = false;
    const partial = await websocketRequest(url, cookie, { id: 93, type: 'composer.settings.apply', model: 'Luna', effort: 'medium', speed: 'fast' });
    assert.equal((partial.result as { applied: boolean }).applied, false);
    assert.match((partial.result as { message: string }).message, /模型与强度已应用，但速度未完成/);
    const noSpeed = await websocketRequest(url, cookie, { id: 94, type: 'composer.settings.apply', model: 'Luna', effort: 'medium' });
    assert.equal((noSpeed.result as { applied: boolean }).applied, true);
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

function websocketRequest(url: string, cookie: string, request: Record<string, unknown> = { id: 7, type: 'thread.list' }): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie } });
    socket.once('error', reject);
    socket.once('open', () => socket.send(JSON.stringify(request)));
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.id !== request.id) return;
      socket.close();
      resolve(message);
    });
  });
}

async function authorize(server: RemoteCodexServer): Promise<string> {
  const base = `http://127.0.0.1:${server.port}`;
  const response = await fetch(`${base}/?token=${encodeURIComponent(server.token)}`, { redirect: 'manual' });
  return response.headers.get('set-cookie')!.split(';')[0]!;
}

function openWebSocket(url: string, cookie: string, onMessage: (message: Record<string, unknown>) => void): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie } });
    socket.once('error', reject);
    socket.on('message', (data) => onMessage(JSON.parse(data.toString()) as Record<string, unknown>));
    socket.once('open', () => resolve(socket));
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForQueueIdle(url: string, cookie: string, threadId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let requestId = 5_000;
  while (Date.now() < deadline) {
    const snapshot = await websocketRequest(url, cookie, { id: requestId++, type: 'turn.queue.list', threadId });
    if ((snapshot.result as { activeTurnId: string | null }).activeTurnId === null) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for queue to become idle');
}

function turnText(call: { method: string; params: unknown } | undefined): string | undefined {
  const params = call?.params as { input?: Array<{ text?: string }> } | undefined;
  return params?.input?.[0]?.text;
}
