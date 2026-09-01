import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { RpcNotification } from '../src/runtime/line-rpc-client.ts';
import { CodexService } from '../src/codex/codex-service.ts';
import type { CodexThread } from '../src/codex/codex-session-store.ts';

class FakeCdpClient extends EventEmitter {
  connected = false;
  connectCalls = 0;
  submitted: string[] = [];
  attachedFiles: string[][] = [];
  interrupted = false;
  composerWaits: Array<number | undefined> = [];
  failComposerWaits = 0;
  titles: Record<string, string> = {};
  openedThreads: string[] = [];
  openedNewThreads = 0;
  approvalReady = false;
  approvalClicks = 0;
  usageReads = 0;
  failPreferences = false;
  preferences = {
    model: '5.6 Sol',
    effort: 'medium',
    effortLabel: '中',
    models: [
      {
        value: '5.6 Sol',
        label: '5.6 Sol',
        effort: 'medium',
        effortLabel: '中',
        efforts: [{ value: 'medium', label: '中' }, { value: 'ultra', label: '极高（更快消耗额度）' }],
      },
      {
        value: '5.6 Luna',
        label: '5.6 Luna',
        effort: 'medium',
        effortLabel: '中',
        efforts: [{ value: 'medium', label: '中' }, { value: 'xhigh', label: '极高' }],
      },
    ],
    efforts: [{ value: 'medium', label: '中' }, { value: 'ultra', label: '极高（更快消耗额度）' }],
  };
  onSubmit?: (text: string) => void;
  preparedModes: string[] = [];
  async connect(): Promise<void> { this.connectCalls += 1; this.connected = true; }
  async close(): Promise<void> { this.connected = false; }
  async waitForComposer(timeoutMs?: number): Promise<void> {
    this.composerWaits.push(timeoutMs);
    if (this.failComposerWaits > 0) {
      this.failComposerWaits -= 1;
      throw new Error('composer not ready');
    }
  }
  async submitText(text: string): Promise<void> { this.submitted.push(text); this.onSubmit?.(text); }
  async prepareTurnMode(mode: string): Promise<void> { this.preparedModes.push(mode); }
  async attachFiles(filePaths: string[]): Promise<void> { this.attachedFiles.push([...filePaths]); }
  async interrupt(): Promise<void> { this.interrupted = true; }
  async threadTitles(): Promise<Record<string, string>> { return this.titles; }
  async openThread(threadId: string): Promise<boolean> { this.openedThreads.push(threadId); return true; }
  async openNewThread(): Promise<boolean> { this.openedNewThreads += 1; return true; }
  async approveVisibleRequest(): Promise<{ approved: boolean; label?: string }> {
    if (!this.approvalReady) return { approved: false };
    this.approvalReady = false;
    this.approvalClicks += 1;
    return { approved: true, label: '批准' };
  }
  async composerPreferences(): Promise<typeof this.preferences> {
    if (this.failPreferences) throw new Error('official picker unavailable');
    return this.preferences;
  }
  async visibleComposerPreference(): Promise<typeof this.preferences> {
    return { ...this.preferences, models: [], efforts: [] };
  }
  async setComposerPreferences(input: { model?: string; effort?: string }): Promise<typeof this.preferences> {
    const model = input.model ?? this.preferences.model;
    const modelOption = this.preferences.models.find((item) => item.value === model) ?? this.preferences.models[0]!;
    const effort = input.effort ?? modelOption.effort;
    this.preferences = {
      ...this.preferences,
      model,
      effort,
      effortLabel: modelOption.efforts.find((item) => item.value === effort)?.label ?? effort,
      efforts: modelOption.efforts,
    };
    return this.preferences;
  }
  async usageInfo(): Promise<{ available: true; percentage: number; period: string; resetAt: string; message: string }> {
    this.usageReads += 1;
    return { available: true, percentage: 47, period: '1 周', resetAt: '8月2日', message: '1 周剩余 47%，8月2日重置' };
  }
  async compatibilitySnapshot(): Promise<Record<string, unknown>> {
    return {
      runtimeVersion: 'FakeChrome/1', mainWindow: true, runtime: true,
      composer: false, submitControl: false, modelControl: false,
      usageControl: false, taskMetadata: false,
    };
  }
}

test('reconnects CDP transparently when a remote request arrives after a transient disconnect', async () => {
  const cdp = new FakeCdpClient();
  const service = new CodexService({
    executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
    cdpClient: cdp as never,
    sessionStore: new FakeSessionStore() as never,
    pollIntervalMs: 10,
  });
  await service.start();
  cdp.connected = false;
  cdp.emit('disconnect');

  try {
    const list = await service.request<{ data: CodexThread[] }>('thread/list', { limit: 50 });
    assert.equal(list.data[0]?.id, 'thread-1');
    assert.equal(cdp.connectCalls, 2);
    assert.equal(service.running, true);
  } finally {
    await service.stop();
  }
});

class FakeAppServerClient {
  connected = false;
  closed = false;
  requests: string[] = [];
  calls: Array<{ method: string; params?: unknown }> = [];
  threadListResponse: unknown = { data: [{ id: 'thread-1', name: 'App Server 标题' }] };
  threadListPages?: Record<string, unknown>;
  async connect(): Promise<void> { this.connected = true; }
  async close(): Promise<void> { this.closed = true; }
  respond(): void {}
  onNotification(): () => void { return () => undefined; }
  onServerRequest(): () => void { return () => undefined; }
  async probe(): Promise<{ initialized: true; threads: true; models: true; usage: true; directories: true }> {
    return { initialized: true, threads: true, models: true, usage: true, directories: true };
  }
  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push(method);
    this.calls.push({ method, params });
    if (method === 'thread/list') {
      const cursor = String((params as { cursor?: string } | undefined)?.cursor ?? '');
      return (this.threadListPages?.[cursor] ?? this.threadListResponse) as T;
    }
    if (method === 'model/list') return { data: [{
      id: 'gpt-5.6-sol', displayName: '5.6 Sol', isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
      defaultReasoningEffort: 'high',
    }] } as T;
    if (method === 'account/rateLimits/read') return { rateLimits: { primary: {
      usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_900_000_000,
    } } } as T;
    if (method === 'turn/start') return { turn: { id: 'app-server-turn' } } as T;
    return {} as T;
  }
}

class FakeSessionStore {
  thread: CodexThread = {
    id: 'thread-1', name: 'Demo', preview: 'Demo', cwd: '/project', createdAt: Date.now(), updatedAt: Date.now(),
    status: { type: 'idle' }, turns: [{ id: 'turn-old', status: 'completed', items: [] }],
  };
  newestCandidate?: CodexThread;
  listThreads(): CodexThread[] { return [this.thread]; }
  readThread(threadId: string): CodexThread {
    if (threadId === this.newestCandidate?.id) return structuredClone(this.newestCandidate);
    if (threadId !== this.thread.id) throw new Error('missing');
    return structuredClone(this.thread);
  }
  newestThreadAfter(_afterMs: number, excludeId = ''): CodexThread | undefined {
    const candidate = this.newestCandidate ?? this.thread;
    return candidate.id === excludeId ? undefined : candidate;
  }
}

class OfficialWorktreeSessionStore extends FakeSessionStore {
  listThreads(): CodexThread[] { return []; }
  readThread(threadId: string, _includeTurns = true, _turnLimit = 120, allowOfficialSubagent = false): CodexThread {
    if (threadId !== this.thread.id || !allowOfficialSubagent) throw new Error('此任务的本地会话记录不存在');
    return structuredClone(this.thread);
  }
}

test('reads an official-visible worktree task while keeping unlisted subagents hidden', async () => {
  const appServer = new FakeAppServerClient();
  const sessions = new OfficialWorktreeSessionStore();
  const service = new CodexService({
    executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
    cdpClient: new FakeCdpClient() as never,
    sessionStore: sessions as never,
    appServerClient: appServer,
  });
  await service.start();
  try {
    const listed = await service.request<{ data: CodexThread[] }>('thread/list');
    assert.deepEqual(listed.data.map((thread) => thread.id), ['thread-1']);
    const opened = await service.request<{ thread: CodexThread }>('thread/read', {
      threadId: 'thread-1', includeTurns: true,
    });
    assert.equal(opened.thread.id, 'thread-1');
    await assert.rejects(service.request('thread/read', { threadId: 'internal-subagent', includeTurns: true }), /本地会话记录不存在/);
  } finally {
    await service.stop();
  }
});

test('uses CDP for official-client sends and exposes the existing local thread state', async () => {
  const cdp = new FakeCdpClient();
  cdp.titles['thread-1'] = 'Official Demo';
  const sessions = new FakeSessionStore();
  const navigated: string[] = [];
  const service = new CodexService({
    executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
    cdpClient: cdp as never,
    sessionStore: sessions as never,
    navigate: async (url) => { navigated.push(url); },
    pollIntervalMs: 10,
  });
  const notifications: RpcNotification[] = [];
  service.onNotification((notification) => notifications.push(notification));
  await service.start();
  try {
    const list = await service.request<{ data: CodexThread[] }>('thread/list', { limit: 50 });
    assert.equal(list.data[0]?.id, 'thread-1');
    assert.equal(list.data[0]?.name, 'Official Demo');
    const resultPromise = service.request<{ turn: { id: string } }>('turn/start', {
      threadId: 'thread-1', input: [{ type: 'text', text: 'sent through official client' }], mode: 'plan',
    });
    sessions.thread = {
      ...sessions.thread, status: { type: 'active' },
      turns: [...(sessions.thread.turns ?? []), { id: 'turn-live', status: 'inProgress', items: [] }],
    };
    const result = await resultPromise;
    assert.equal(result.turn.id, 'turn-live');
    assert.deepEqual(cdp.submitted, ['sent through official client']);
    assert.deepEqual(cdp.preparedModes, ['plan']);
    assert.match(navigated[0] ?? '', /^codex:\/\/threads\/thread-1/);
    assert.ok(notifications.some((notification) => notification.method === 'turn/started'));
    await service.request('turn/interrupt', { threadId: 'thread-1', turnId: 'turn-live' });
    assert.equal(cdp.interrupted, true);
  } finally {
    await service.stop();
  }
});

test('renames an official Codex task through the metadata bridge and refreshes its title immediately', async () => {
  const cdp = new FakeCdpClient();
  const sessions = new FakeSessionStore();
  const renamed: Array<{ threadId: string; name: string }> = [];
  const service = new CodexService({
    executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
    cdpClient: cdp as never,
    sessionStore: sessions as never,
    setThreadName: async (threadId, name) => { renamed.push({ threadId, name }); },
  });
  await service.start();
  try {
    assert.deepEqual(await service.request('thread/name/set', { threadId: 'thread-1', name: '新的官方任务名称' }), {
      threadId: 'thread-1', name: '新的官方任务名称',
    });
    assert.deepEqual(renamed, [{ threadId: 'thread-1', name: '新的官方任务名称' }]);
    const list = await service.request<{ data: CodexThread[] }>('thread/list');
    assert.equal(list.data[0]?.name, '新的官方任务名称');
  } finally {
    await service.stop();
  }
});

test('creates a project directory through the official Codex filesystem bridge', async () => {
  const created: string[] = [];
  const read: string[] = [];
  const service = new CodexService({
    executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
    cdpClient: new FakeCdpClient() as never,
    sessionStore: new FakeSessionStore() as never,
    createDirectory: async (directoryPath) => { created.push(directoryPath); },
    readDirectory: async (directoryPath) => {
      read.push(directoryPath);
      return { entries: [{ fileName: 'Child', isDirectory: true, isFile: false }] };
    },
  });
  await service.start();
  try {
    assert.deepEqual(await service.request('fs/createDirectory', { path: '/Users/test/NewProject' }), {
      path: '/Users/test/NewProject',
    });
    assert.deepEqual(created, ['/Users/test/NewProject']);
    assert.deepEqual(await service.request('fs/readDirectory', { path: '/Users/test' }), {
      entries: [{ fileName: 'Child', isDirectory: true, isFile: false }],
    });
    assert.deepEqual(read, ['/Users/test']);
    await assert.rejects(() => service.request('fs/createDirectory', { path: 'relative/path' }), /绝对路径/);
  } finally {
    await service.stop();
  }
});

test('starts while ChatGPT is on a page without a Codex composer', async () => {
  const cdp = new FakeCdpClient();
  cdp.failComposerWaits = 1;
  const navigated: string[] = [];
  const service = new CodexService({
    executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
    cdpClient: cdp as never,
    sessionStore: new FakeSessionStore() as never,
    navigate: async (url) => { navigated.push(url); },
  });
  await service.start();
  try {
    assert.equal(service.running, true);
    assert.deepEqual(cdp.composerWaits, []);
    assert.deepEqual(navigated, []);
  } finally {
    await service.stop();
  }
});

test('uses a passive app-server handshake and never navigates the official client at startup', async () => {
  const cdp = new FakeCdpClient();
  const appServer = new FakeAppServerClient();
  const navigated: string[] = [];
  const service = new CodexService({
    executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
    cdpClient: cdp as never,
    appServerClient: appServer,
    sessionStore: new FakeSessionStore() as never,
    navigate: async (url) => { navigated.push(url); },
    officialAppVersion: '26.803.41515',
  });
  await service.start();
  try {
    const report = await service.verifyCompatibility('/project');
    assert.equal(report.state, 'compatible');
    assert.deepEqual(navigated, []);
    assert.deepEqual(cdp.composerWaits, []);
  } finally {
    await service.stop();
  }
  assert.equal(appServer.closed, true);
});

test('reads titles, model capabilities and quota from app-server while keeping CDP for the active composer', async () => {
  const cdp = new FakeCdpClient();
  const appServer = new FakeAppServerClient();
  const service = new CodexService({
    executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
    cdpClient: cdp as never,
    appServerClient: appServer,
    sessionStore: new FakeSessionStore() as never,
  });
  await service.start();
  try {
    const list = await service.request<{ data: CodexThread[] }>('thread/list');
    assert.equal(list.data[0]?.name, 'App Server 标题');
    const preferences = await service.request<{ models: Array<{ value: string }>; efforts: Array<{ value: string }> }>('composer/preferences/get');
    assert.equal(preferences.models[0]?.value, '5.6 Sol');
    assert.deepEqual(preferences.efforts.map((item) => item.value), ['low', 'high']);
    const usage = await service.request<{ percentage: number }>('account/usage/get');
    assert.equal(usage.percentage, 88);
    assert.equal(cdp.usageReads, 0);
  } finally {
    await service.stop();
  }
});

test('filters retained local rollouts that are absent from the official app-server task list', async () => {
  const cdp = new FakeCdpClient();
  const appServer = new FakeAppServerClient();
  const sessions = new FakeSessionStore();
  const hiddenThread: CodexThread = {
    ...structuredClone(sessions.thread),
    id: 'local-only-thread',
    name: '仅本地残留任务',
    updatedAt: sessions.thread.updatedAt + 10_000,
  };
  const sessionStore = {
    ...sessions,
    listThreads: () => [hiddenThread, structuredClone(sessions.thread)],
    readThread: (threadId: string) => threadId === hiddenThread.id ? structuredClone(hiddenThread) : sessions.readThread(threadId),
  };
  const service = new CodexService({
    executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
    cdpClient: cdp as never,
    appServerClient: appServer,
    sessionStore: sessionStore as never,
  });
  await service.start();
  try {
    const list = await service.request<{ data: CodexThread[] }>('thread/list');
    assert.deepEqual(list.data.map((thread) => thread.id), ['thread-1']);
  } finally {
    await service.stop();
  }
});

test('uses official project assignments to group handoff tasks while preserving worktree paths', async () => {
  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), 'gpttool-project-assignment-'));
  const assignedRoot = '/Users/demo/CodexWork/volt2ai';
  const legacyCwd = '/Users/demo/Documents/Codex/2026-08-24/handoff-output';
  const worktreeCwd = '/Users/demo/.codex/worktrees/abc123/volt2ai';
  const sessions = new FakeSessionStore();
  const handoff = { ...structuredClone(sessions.thread), id: 'handoff-thread', cwd: legacyCwd, name: '闪电兔' };
  const worktree = { ...structuredClone(sessions.thread), id: 'worktree-thread', cwd: worktreeCwd, name: 'Worktree 任务' };
  const appServer = new FakeAppServerClient();
  appServer.threadListResponse = { data: [
    { id: handoff.id, name: handoff.name, cwd: legacyCwd },
    { id: worktree.id, name: worktree.name, cwd: worktreeCwd },
  ] };
  await mkdir(path.join(homeDirectory, '.codex'), { recursive: true });
  await writeFile(path.join(homeDirectory, '.codex', '.codex-global-state.json'), JSON.stringify({
    'local-projects': {
      'volt-project': { id: 'volt-project', rootPaths: [assignedRoot] },
    },
    'thread-project-assignments': {
      [handoff.id]: { projectKind: 'local', projectId: 'volt-project' },
      [worktree.id]: { projectKind: 'local', projectId: 'volt-project' },
    },
  }));
  const service = new CodexService({
    executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
    homeDirectory,
    cdpClient: new FakeCdpClient() as never,
    appServerClient: appServer,
    sessionStore: {
      ...sessions,
      listThreads: () => [handoff, worktree],
      readThread: (id: string) => structuredClone(id === handoff.id ? handoff : worktree),
    } as never,
  });
  await service.start();
  try {
    const list = await service.request<{ data: CodexThread[] }>('thread/list');
    assert.equal(list.data.find(({ id }) => id === handoff.id)?.cwd, assignedRoot);
    assert.equal(list.data.find(({ id }) => id === worktree.id)?.cwd, worktreeCwd);
  } finally {
    await service.stop();
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test('normalizes nested app-server task lists after an official client protocol update', async () => {
  const appServer = new FakeAppServerClient();
  appServer.threadListResponse = { result: { threads: [{ threadId: 'thread-1', title: '新版官方标题' }] } };
  const sessions = new FakeSessionStore();
  const localOnly = { ...structuredClone(sessions.thread), id: 'local-only', name: '旧缓存' };
  const service = new CodexService({
    executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
    cdpClient: new FakeCdpClient() as never,
    appServerClient: appServer,
    sessionStore: {
      ...sessions,
      listThreads: () => [localOnly, structuredClone(sessions.thread)],
      readThread: (id: string) => id === localOnly.id ? structuredClone(localOnly) : sessions.readThread(id),
    } as never,
  });
  await service.start();
  try {
    const list = await service.request<{ data: CodexThread[] }>('thread/list');
    assert.deepEqual(list.data.map(({ id, name }) => ({ id, name })), [{ id: 'thread-1', name: '新版官方标题' }]);
  } finally {
    await service.stop();
  }
});

test('uses visible CDP tasks as an ordered prefix without filtering local fallbacks', async () => {
  const cdp = new FakeCdpClient();
  cdp.titles = { 'thread-1': 'CDP 当前标题' };
  const appServer = new FakeAppServerClient();
  appServer.threadListResponse = { incompatible: true };
  const sessions = new FakeSessionStore();
  const localOnly = { ...structuredClone(sessions.thread), id: 'local-only', name: '旧缓存' };
  const service = new CodexService({
    executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
    cdpClient: cdp as never,
    appServerClient: appServer,
    sessionStore: {
      ...sessions,
      listThreads: () => [localOnly, structuredClone(sessions.thread)],
      readThread: (id: string) => id === localOnly.id ? structuredClone(localOnly) : sessions.readThread(id),
    } as never,
  });
  await service.start();
  try {
    const list = await service.request<{ data: CodexThread[] }>('thread/list');
    assert.deepEqual(list.data.map(({ id, name }) => ({ id, name })), [
      { id: 'thread-1', name: 'CDP 当前标题' },
      { id: 'local-only', name: '旧缓存' },
    ]);
  } finally {
    await service.stop();
  }
});

test('keeps a renderer-visible task while the official app-server index is behind', async () => {
  const cdp = new FakeCdpClient();
  cdp.titles = { 'renderer-only': '刚在官方客户端创建', 'thread-1': '现有任务' };
  const appServer = new FakeAppServerClient();
  appServer.threadListResponse = { data: [{ id: 'thread-1', name: '现有任务' }] };
  const sessions = new FakeSessionStore();
  const rendererOnly = { ...structuredClone(sessions.thread), id: 'renderer-only', name: '本地旧标题' };
  const service = new CodexService({
    executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
    cdpClient: cdp as never,
    appServerClient: appServer,
    sessionStore: {
      ...sessions,
      listThreads: () => [structuredClone(sessions.thread), rendererOnly],
      readThread: (id: string) => id === rendererOnly.id ? structuredClone(rendererOnly) : sessions.readThread(id),
    } as never,
  });
  await service.start();
  try {
    const list = await service.request<{ data: CodexThread[] }>('thread/list');
    assert.deepEqual(list.data.map(({ id, name }) => ({ id, name })), [
      { id: 'renderer-only', name: '刚在官方客户端创建' },
      { id: 'thread-1', name: '现有任务' },
    ]);
  } finally {
    await service.stop();
  }
});

test('reads every app-server cursor page and builds the list from official task identities', async () => {
  const appServer = new FakeAppServerClient();
  appServer.threadListPages = {
    '': { data: [{ id: 'official-new', name: '最新官方任务', cwd: '/new', updatedAt: 200 }], nextCursor: 'page-2' },
    'page-2': { data: [{ id: 'thread-1', name: '第二页官方任务', cwd: '/project', updatedAt: 100 }] },
  };
  const sessions = new FakeSessionStore();
  const service = new CodexService({
    executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
    cdpClient: new FakeCdpClient() as never,
    appServerClient: appServer,
    sessionStore: sessions as never,
  });
  await service.start();
  try {
    const list = await service.request<{ data: CodexThread[] }>('thread/list');
    assert.deepEqual(list.data.map(({ id, name }) => ({ id, name })), [
      { id: 'official-new', name: '最新官方任务' },
      { id: 'thread-1', name: '第二页官方任务' },
    ]);
    assert.deepEqual(appServer.calls.filter(({ method }) => method === 'thread/list').map(({ params }) => params), [
      { limit: 100, sortKey: 'recency_at', sortDirection: 'desc' },
      { limit: 100, cursor: 'page-2', sortKey: 'recency_at', sortDirection: 'desc' },
    ]);
  } finally {
    await service.stop();
  }
});

test('keeps the last complete official snapshot during a transient empty response', async () => {
  const appServer = new FakeAppServerClient();
  const service = new CodexService({
    executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
    cdpClient: new FakeCdpClient() as never,
    appServerClient: appServer,
    sessionStore: new FakeSessionStore() as never,
  });
  await service.start();
  try {
    const first = await service.request<{ data: CodexThread[] }>('thread/list');
    assert.equal(first.data[0]?.id, 'thread-1');
    appServer.threadListResponse = { data: [] };
    await new Promise((resolve) => setTimeout(resolve, 5_050));
    const second = await service.request<{ data: CodexThread[] }>('thread/list');
    assert.equal(second.data[0]?.id, 'thread-1');
  } finally {
    await service.stop();
  }
});

test('injects uploaded attachments before submitting an attachment-only turn', async () => {
  const cdp = new FakeCdpClient();
  const sessions = new FakeSessionStore();
  const service = new CodexService({
    executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
    cdpClient: cdp as never,
    sessionStore: sessions as never,
    navigate: async () => undefined,
  });
  await service.start();
  try {
    const resultPromise = service.request('turn/start', {
      threadId: 'thread-1',
      input: [],
      mode: 'goal',
      attachments: [{ path: '/private/tmp/remote-image.png', name: 'remote-image.png', mimeType: 'image/png', size: 4 }],
    });
    sessions.thread = {
      ...sessions.thread, updatedAt: Date.now(), status: { type: 'active' },
      turns: [...(sessions.thread.turns ?? []), { id: 'turn-file', status: 'inProgress', items: [] }],
    };
    await resultPromise;
    assert.deepEqual(cdp.attachedFiles, [['/private/tmp/remote-image.png']]);
    assert.deepEqual(cdp.preparedModes, ['goal']);
    assert.deepEqual(cdp.submitted, ['']);
  } finally {
    await service.stop();
  }
});

test('falls back to app-server before submission when the updated official renderer is unavailable', async () => {
  const cdp = new FakeCdpClient();
  cdp.failComposerWaits = 1;
  const appServer = new FakeAppServerClient();
  const service = new CodexService({
    executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
    cdpClient: cdp as never,
    sessionStore: new FakeSessionStore() as never,
    appServerClient: appServer as never,
    navigate: async () => undefined,
  });
  await service.start();
  try {
    const result = await service.request<{ threadId: string; turn: { id: string } }>('turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'send through safe fallback' }],
      attachments: [{ path: '/private/tmp/report.md', name: 'report.md', mimeType: 'text/markdown' }],
    });
    assert.equal(result.threadId, 'thread-1');
    assert.equal(result.turn.id, 'app-server-turn');
    assert.deepEqual(cdp.submitted, [], 'must not retry an ambiguous renderer submit');
    const start = appServer.calls.find((call) => call.method === 'turn/start');
    assert.deepEqual(start?.params, {
      threadId: 'thread-1',
      input: [
        { type: 'text', text: 'send through safe fallback' },
        { type: 'mention', name: 'report.md', path: '/private/tmp/report.md' },
      ],
      mode: 'normal',
    });
  } finally {
    await service.stop();
  }
});

test('associates an attachment turn with the newly created official thread instead of the currently updating thread', async () => {
  const cdp = new FakeCdpClient();
  const sessions = new FakeSessionStore();
  const service = new CodexService({
    executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
    cdpClient: cdp as never,
    sessionStore: sessions as never,
    navigate: async () => undefined,
  });
  await service.start();
  try {
    const pending = await service.request<{ thread: CodexThread }>('thread/start', { cwd: '/project' });
    cdp.onSubmit = () => {
      sessions.newestCandidate = {
        id: 'thread-created-by-attachment',
        name: 'Attachment task',
        preview: 'Attachment task',
        cwd: '/project',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: { type: 'active' },
        turns: [{ id: 'turn-created-by-attachment', status: 'inProgress', items: [] }],
      };
    };
    const result = await service.request<{ threadId: string; turn: { id: string } }>('turn/start', {
      threadId: pending.thread.id,
      input: [{ type: 'text', text: 'inspect both attachments' }],
      attachments: [
        { path: '/private/tmp/image.png', name: 'image.png', mimeType: 'image/png', size: 4 },
        { path: '/private/tmp/report.md', name: 'report.md', mimeType: 'text/markdown', size: 8 },
      ],
    });
    assert.equal(result.threadId, 'thread-created-by-attachment');
    assert.equal(result.turn.id, 'turn-created-by-attachment');
    assert.deepEqual(cdp.attachedFiles, [['/private/tmp/image.png', '/private/tmp/report.md']]);
  } finally {
    await service.stop();
  }
});

test('navigates and approves through background CDP without opening the desktop app in front', async () => {
  const cdp = new FakeCdpClient();
  const service = new CodexService({
    executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
    cdpClient: cdp as never,
    sessionStore: new FakeSessionStore() as never,
    pollIntervalMs: 10,
  });
  const approved = new Promise<void>((resolve) => {
    service.onNotification((notification) => {
      if (notification.method === 'approval/auto/approved') resolve();
    });
  });
  await service.start();
  try {
    await service.request('thread/resume', { threadId: 'thread-1' });
    assert.deepEqual(cdp.openedThreads, ['thread-1']);
    assert.equal(cdp.openedNewThreads, 0);

    assert.deepEqual(await service.request('approval/auto/set', { enabled: true }), { enabled: true });
    cdp.approvalReady = true;
    await Promise.race([
      approved,
      new Promise((_, reject) => setTimeout(() => reject(new Error('automatic approval timed out')), 500)),
    ]);
    assert.equal(cdp.approvalClicks, 1);
  } finally {
    await service.stop();
  }
});

test('publishes live reasoning and command updates from the official rollout', async () => {
  const cdp = new FakeCdpClient();
  const sessions = new FakeSessionStore();
  sessions.thread.turns = [{ id: 'turn-live', status: 'inProgress', items: [] }];
  sessions.thread.status = { type: 'active' };
  const service = new CodexService({
    executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
    cdpClient: cdp as never,
    sessionStore: sessions as never,
    pollIntervalMs: 10,
  });
  const notifications: RpcNotification[] = [];
  service.onNotification((notification) => notifications.push(notification));
  await service.start();
  try {
    await service.request('thread/read', { threadId: 'thread-1', includeTurns: true });
    sessions.thread.turns![0]!.items.push({
      id: 'reason-1', type: 'reasoning', status: 'inProgress', summary: ['正在检查项目结构'],
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    sessions.thread.turns![0]!.items[0] = {
      id: 'reason-1', type: 'reasoning', status: 'completed', summary: ['项目结构检查完成'],
    };
    sessions.thread.turns![0]!.items.push({
      id: 'command-1', type: 'commandExecution', status: 'inProgress', command: 'npm test',
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.ok(notifications.some((notification) => notification.method === 'item/started'
      && (notification.params as { item?: { id?: string } }).item?.id === 'reason-1'));
    assert.ok(notifications.some((notification) => notification.method === 'item/completed'
      && (notification.params as { item?: { id?: string } }).item?.id === 'reason-1'));
    assert.ok(notifications.some((notification) => notification.method === 'item/started'
      && (notification.params as { item?: { id?: string } }).item?.id === 'command-1'));
  } finally {
    await service.stop();
  }
});

test('publishes official desktop queued messages with text and attachment metadata', async () => {
  const cdp = new FakeCdpClient();
  const sessions = new FakeSessionStore();
  sessions.thread.turns = [{ id: 'turn-live', status: 'inProgress', items: [{
    id: 'active-user', type: 'userMessage', content: [{ type: 'text', text: '正在执行的任务' }],
  }] }];
  sessions.thread.status = { type: 'active' };
  const service = new CodexService({
    executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
    cdpClient: cdp as never,
    sessionStore: sessions as never,
    pollIntervalMs: 10,
  });
  const notifications: RpcNotification[] = [];
  service.onNotification((notification) => notifications.push(notification));
  await service.start();
  try {
    await service.request('thread/read', { threadId: 'thread-1', includeTurns: true });
    sessions.thread.turns![0]!.items.push({
      id: 'official-queued-1',
      type: 'userMessage',
      content: [
        { type: 'text', text: '继续检查这张截图' },
        { type: 'attachment', name: 'screen.png', mimeType: 'image/png', imageUrl: 'data:image/png;base64,AA==' },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const notification = notifications.find((entry) => entry.method === 'official/queue/updated');
    const items = (notification?.params as { items?: Array<{ text?: string; attachments?: Array<{ name?: string }> }> })?.items ?? [];
    assert.equal(items[0]?.text, '继续检查这张截图');
    assert.equal(items[0]?.attachments?.[0]?.name, 'screen.png');
    assert.equal(notifications.some((entry) => entry.method === 'item/completed'
      && (entry.params as { item?: { id?: string } }).item?.id === 'official-queued-1'), false,
    'a queued official prompt must not also be broadcast as a completed chat bubble');
  } finally {
    await service.stop();
  }
});

test('does not mistake a delayed first user item for an official queued message', async () => {
  const cdp = new FakeCdpClient();
  const sessions = new FakeSessionStore();
  sessions.thread.turns = [{ id: 'turn-live', status: 'inProgress', items: [] }];
  sessions.thread.status = { type: 'active' };
  const service = new CodexService({
    executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
    cdpClient: cdp as never,
    sessionStore: sessions as never,
    pollIntervalMs: 10,
  });
  const notifications: RpcNotification[] = [];
  service.onNotification((notification) => notifications.push(notification));
  await service.start();
  try {
    await service.request('thread/read', { threadId: 'thread-1', includeTurns: true });
    sessions.thread.turns![0]!.items.push({
      id: 'delayed-active-user', type: 'userMessage', content: [{ type: 'text', text: '当前正在执行的消息' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(notifications.some((entry) => entry.method === 'official/queue/updated'), false);
    assert.equal(notifications.some((entry) => entry.method === 'item/completed'
      && (entry.params as { item?: { id?: string } }).item?.id === 'delayed-active-user'), true);
  } finally {
    await service.stop();
  }
});

test('reads official model-specific efforts and updates model with a compatible reasoning effort', async () => {
  const cdp = new FakeCdpClient();
  const service = new CodexService({
    executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
    cdpClient: cdp as never,
    sessionStore: new FakeSessionStore() as never,
  });
  await service.start();
  try {
    const current = await service.request<typeof cdp.preferences>('composer/preferences/get');
    assert.equal(current.model, '5.6 Sol');
    assert.equal(current.models[0]?.efforts.some((item) => item.value === 'ultra'), true);
    assert.equal(current.models[1]?.efforts.some((item) => item.value === 'ultra'), false);
    const updated = await service.request<typeof cdp.preferences>('composer/preferences/set', { model: '5.6 Luna', effort: 'xhigh' });
    assert.equal(updated.model, '5.6 Luna');
    assert.equal(updated.effort, 'xhigh');
    assert.deepEqual(await service.request('account/usage/get'), {
      available: true,
      percentage: 47,
      period: '1 周',
      resetAt: '8月2日',
      message: '1 周剩余 47%，8月2日重置',
    });
  } finally {
    await service.stop();
  }
});

test('does not enforce official ChatGPT quota for an external Responses provider', async () => {
  const cdp = new FakeCdpClient();
  cdp.failPreferences = true;
  const service = new CodexService({
    executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
    cdpClient: cdp as never,
    sessionStore: new FakeSessionStore() as never,
    inspectProvider: async () => ({
      id: 'kimi-proxy',
      name: 'Kimi via CC Switch',
      model: 'k3-256k',
      baseUrl: 'http://127.0.0.1:8787/v1',
      wireApi: 'responses',
      mode: 'external-responses',
      external: true,
      officialUsageApplies: false,
      message: '正在使用第三方模型服务 Kimi via CC Switch，任务由该服务计费和限额',
    }),
  });
  await service.start();
  try {
    const usage = await service.request<{ available: boolean; enforced: boolean; provider: string }>('account/usage/get');
    assert.deepEqual(usage, {
      available: false,
      enforced: false,
      provider: 'Kimi via CC Switch',
      message: '正在使用第三方模型服务 Kimi via CC Switch，任务由该服务计费和限额',
    });
    assert.equal(cdp.usageReads, 0);
    const preferences = await service.request<{ readOnly: boolean; model: string }>('composer/preferences/get');
    assert.equal(preferences.readOnly, true);
    assert.equal(preferences.model, 'k3-256k');
  } finally {
    await service.stop();
  }
});
