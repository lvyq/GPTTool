import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readdir, rm, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { clearRolloutCache, CodexSessionStore, parseRollout } from '../src/codex/codex-session-store.ts';

test('reads the official Codex thread database and rollout history without starting app-server', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gpttool-codex-state-'));
  const databasePath = path.join(directory, 'state_5.sqlite');
  const rolloutPath = path.join(directory, 'sessions', 'rollout-thread-1.jsonl');
  const records = [
    { type: 'session_meta', payload: { id: 'thread-1', cwd: '/project', timestamp: new Date().toISOString() } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    {
      type: 'response_item',
      payload: {
        type: 'message', role: 'user', id: 'internal-context',
        content: [{ type: 'input_text', text: '<environment_context><current_date>2026-07-26</current_date><filesystem><root>/private/workspace</root></filesystem></environment_context>' }],
      },
    },
    { type: 'response_item', payload: { type: 'message', role: 'user', id: 'user-1', content: [{ type: 'input_text', text: 'hello' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'agent-1', content: [{ type: 'output_text', text: 'world' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
  ];
  await mkdir(path.dirname(rolloutPath), { recursive: true });
  await writeFile(rolloutPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  const sqlite = await initSqlJs();
  const database = new sqlite.Database();
  database.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    created_at_ms INTEGER, updated_at_ms INTEGER, cwd TEXT NOT NULL, title TEXT NOT NULL,
    first_user_message TEXT NOT NULL, preview TEXT NOT NULL, archived INTEGER NOT NULL,
    has_user_event INTEGER NOT NULL, recency_at_ms INTEGER NOT NULL
  )`);
  database.run('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    'thread-1', rolloutPath, 1, 2, 1_000, 2_000, '/project', 'Demo', 'hello', 'preview', 0, 1, 2_000,
  ]);
  await writeFile(databasePath, database.export());
  database.close();

  try {
    const store = new CodexSessionStore({ databasePath });
    const listed = await store.listThreads();
    assert.equal(listed[0]?.id, 'thread-1');
    assert.equal(listed[0]?.name, 'Demo', 'session scanning must not replace the official database title');
    const thread = await store.readThread('thread-1');
    assert.equal(thread.status.type, 'idle');
    assert.deepEqual(thread.turns, [{
      id: 'turn-1', status: 'completed', items: [
        { id: 'user-1', type: 'userMessage', status: 'completed', content: [{ type: 'text', text: 'hello' }] },
        { id: 'agent-1', type: 'agentMessage', status: 'completed', text: 'world' },
      ],
    }]);
    assert.deepEqual(parseRollout('/missing/rollout.jsonl'), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('falls back to official session files when the state database is temporarily unreadable', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gpttool-codex-fallback-'));
  const databasePath = path.join(directory, 'state_5.sqlite');
  const rolloutPath = path.join(directory, 'sessions', 'rollout-fallback.jsonl');
  const records = [
    {
      type: 'session_meta',
      payload: { id: 'fallback-thread', cwd: '/fallback-project', timestamp: new Date().toISOString() },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message', role: 'user', id: 'fallback-user',
        content: [{ type: 'input_text', text: '休眠恢复任务' }],
      },
    },
  ];
  await mkdir(path.dirname(rolloutPath), { recursive: true });
  await writeFile(rolloutPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  await writeFile(databasePath, 'not a sqlite database');

  try {
    const store = new CodexSessionStore({ databasePath });
    const listed = await store.listThreads();
    assert.equal(listed[0]?.id, 'fallback-thread');
    assert.equal(listed[0]?.name, '休眠恢复任务');
    const thread = await store.readThread('fallback-thread');
    assert.equal(thread.cwd, '/fallback-project');
    assert.equal(thread.turns?.[0]?.items[0]?.content?.[0]?.text, '休眠恢复任务');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('releases an abandoned in-progress rollout so the composer is usable again', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gpttool-stale-turn-'));
  const rolloutPath = path.join(directory, 'rollout.jsonl');
  try {
    await writeFile(rolloutPath, `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'stale-turn' } })}\n`);
    const old = new Date(Date.now() - 20 * 60 * 1000);
    await utimes(rolloutPath, old, old);
    assert.equal(parseRollout(rolloutPath)[0]?.status, 'failed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reads only the requested newest rollout turns while preserving their order', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gpttool-rollout-window-'));
  const rolloutPath = path.join(directory, 'rollout.jsonl');
  const records = Array.from({ length: 30 }, (_, index) => ([
    { type: 'event_msg', payload: { type: 'task_started', turn_id: `turn-${index}` } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: `agent-${index}`, content: [{ type: 'output_text', text: `reply-${index}` }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: `turn-${index}` } },
  ])).flat();
  try {
    await writeFile(rolloutPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    assert.deepEqual(parseRollout(rolloutPath, 5).map((turn) => turn.id), [
      'turn-25', 'turn-26', 'turn-27', 'turn-28', 'turn-29',
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reads a sparse rollout larger than the V8 string limit from a bounded tail window', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gpttool-oversized-rollout-'));
  const rolloutPath = path.join(directory, 'rollout.jsonl');
  const records = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'older-turn-1' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'older-turn-1' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'older-turn-2' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'older-turn-2' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'recent-turn' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', id: 'recent-user', content: [{ type: 'input_text', text: '继续执行' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'recent-agent', content: [{ type: 'output_text', text: '可以继续' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'recent-turn' } },
  ];
  try {
    await writeFile(rolloutPath, '');
    await truncate(rolloutPath, 600 * 1024 * 1024);
    await appendFile(rolloutPath, `\n${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const turns = parseRollout(rolloutPath, 2);
    assert.equal(turns.at(-1)?.id, 'recent-turn');
    assert.equal(turns.at(-1)?.items.at(-1)?.text, '可以继续');
  } finally {
    clearRolloutCache();
    await rm(directory, { recursive: true, force: true });
  }
});

test('reuses rollout parsing safely and invalidates the cache when the official history changes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gpttool-rollout-cache-'));
  const rolloutPath = path.join(directory, 'rollout.jsonl');
  const firstTurn = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'agent-1', content: [{ type: 'output_text', text: 'first' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
  ];
  const secondTurn = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'agent-2', content: [{ type: 'output_text', text: 'second' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-2' } },
  ];
  try {
    clearRolloutCache();
    await writeFile(rolloutPath, `${firstTurn.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const firstRead = parseRollout(rolloutPath, 12);
    firstRead[0]!.items[0]!.text = 'mutated outside the cache';
    assert.equal(parseRollout(rolloutPath, 12)[0]?.items[0]?.text, 'first');

    await appendFile(rolloutPath, `${secondTurn.map((record) => JSON.stringify(record)).join('\n')}\n`);
    assert.deepEqual(parseRollout(rolloutPath, 12).map((turn) => turn.id), ['turn-1', 'turn-2']);
  } finally {
    clearRolloutCache();
    await rm(directory, { recursive: true, force: true });
  }
});

test('persists recent rollout parsing for fast reads after the desktop service restarts', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gpttool-rollout-disk-cache-'));
  const databasePath = path.join(directory, 'missing-state.sqlite');
  const cacheDirectory = path.join(directory, 'cache');
  const rolloutPath = path.join(directory, 'sessions', 'rollout-cache-thread.jsonl');
  const records = [
    { type: 'session_meta', payload: { id: 'cache-thread', cwd: '/project', timestamp: new Date().toISOString() } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'cached-turn' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'cached-agent', content: [{ type: 'output_text', text: 'cached reply' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'cached-turn' } },
  ];
  try {
    await mkdir(path.dirname(rolloutPath), { recursive: true });
    await writeFile(rolloutPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const store = new CodexSessionStore({ databasePath, cacheDirectory });
    assert.equal((await store.readThread('cache-thread', true, 6)).turns?.[0]?.id, 'cached-turn');
    await waitForFiles(cacheDirectory);
    assert.equal((await readdir(cacheDirectory)).filter((name) => name.endsWith('.json')).length, 1);
    clearRolloutCache();
    const restarted = new CodexSessionStore({ databasePath, cacheDirectory });
    assert.equal((await restarted.readThread('cache-thread', true, 6)).turns?.[0]?.items[0]?.text, 'cached reply');
    await appendFile(rolloutPath, `${[
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'new-turn' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'new-agent', content: [{ type: 'output_text', text: 'new reply' }] } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'new-turn' } },
    ].map((record) => JSON.stringify(record)).join('\n')}\n`);
    clearRolloutCache();
    assert.equal((await restarted.readThread('cache-thread', true, 1)).turns?.[0]?.id, 'new-turn');
    await new Promise((resolve) => setTimeout(resolve, 20));
    clearRolloutCache();
    assert.deepEqual((await restarted.readThread('cache-thread', true, 6)).turns?.map((turn) => turn.id), ['cached-turn', 'new-turn']);
  } finally {
    clearRolloutCache();
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitForFiles(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { if ((await readdir(directory)).length) return; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('rollout disk cache was not written');
}

test('restores official execution steps and user attachments from rollout history', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gpttool-rich-history-'));
  const rolloutPath = path.join(directory, 'rollout.jsonl');
  const imageUrl = `data:image/png;base64,${Buffer.from('thumbnail').toString('base64')}`;
  const records = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-rich' } },
    {
      type: 'response_item',
      payload: {
        type: 'message', role: 'user', id: 'user-rich',
        content: [
          { type: 'input_text', text: '# Files mentioned by the user:\n\n## screenshot.png: /tmp/screenshot.png\n## report.pdf: /tmp/report.pdf\n\n## My request for Codex:\n\n检查这些文件' },
          { type: 'input_image', image_url: imageUrl },
          { type: 'input_text', text: '<image name=[Image #1]></image>' },
        ],
      },
    },
    { type: 'response_item', payload: { type: 'function_call', id: 'call-item', call_id: 'call-1', name: 'exec_command', arguments: '{"cmd":"npm test"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'Process exited with code 0\nAll tests passed' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', id: 'patch-item', call_id: 'call-2', name: 'apply_patch', input: '*** Update File: src/app.ts\n@@\n-old\n+new\n' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-2', output: 'Done!' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'agent-rich', content: [{ type: 'output_text', text: '已经完成' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-rich' } },
  ];
  try {
    await writeFile(rolloutPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const [turn] = parseRollout(rolloutPath);
    assert.equal(turn?.status, 'completed');
    assert.deepEqual(turn?.items[0], {
      id: 'user-rich', type: 'userMessage', status: 'completed',
      content: [
        { type: 'text', text: '检查这些文件' },
        { type: 'attachment', name: 'screenshot.png', mimeType: 'image/png', imageUrl },
        { type: 'attachment', name: 'report.pdf', mimeType: 'application/pdf' },
      ],
    });
    assert.deepEqual(turn?.items[1], {
      id: 'call-1', type: 'commandExecution', kind: 'command', status: 'completed',
      command: 'npm test', aggregatedOutput: 'Process exited with code 0\nAll tests passed',
      result: 'Process exited with code 0\nAll tests passed', exitCode: 0,
    });
    assert.deepEqual(turn?.items[2], {
      id: 'call-2', type: 'fileChange', kind: 'file', status: 'completed',
      changes: [{ path: 'src/app.ts' }],
      input: '*** Update File: src/app.ts\n@@\n-old\n+new\n',
      result: 'Done!',
    });
    assert.equal(turn?.items[3]?.type, 'agentMessage');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('normalizes the short attachment request wrapper used by newer Codex builds', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gpttool-short-attachment-wrapper-'));
  const rolloutPath = path.join(directory, 'rollout.jsonl');
  const records = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-short-wrapper' } },
    {
      type: 'response_item',
      payload: {
        type: 'message', role: 'user', id: 'user-short-wrapper',
        content: [{
          type: 'input_text',
          text: '# Files mentioned by the user:\n\n## screenshot.png: /tmp/private/screenshot.png\n\n## My request:\n\n修复重复消息气泡',
        }],
      },
    },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-short-wrapper' } },
  ];
  try {
    await writeFile(rolloutPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const [turn] = parseRollout(rolloutPath);
    assert.deepEqual(turn?.items[0], {
      id: 'user-short-wrapper', type: 'userMessage', status: 'completed',
      content: [
        { type: 'text', text: '修复重复消息气泡' },
        { type: 'attachment', name: 'screenshot.png', mimeType: 'image/png' },
      ],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('hides internal subagent sessions from both the database and JSONL fallback scan', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gpttool-subagent-filter-'));
  const databasePath = path.join(directory, 'state_5.sqlite');
  const sessionsDirectory = path.join(directory, 'sessions');
  const userRollout = path.join(sessionsDirectory, 'rollout-user.jsonl');
  const databaseSubagentRollout = path.join(sessionsDirectory, 'rollout-database-subagent.jsonl');
  const scanSubagentRollout = path.join(sessionsDirectory, 'rollout-scan-subagent.jsonl');
  await mkdir(sessionsDirectory, { recursive: true });
  await writeFile(userRollout, `${JSON.stringify({
    type: 'session_meta',
    payload: { id: 'user-thread', cwd: '/project', thread_source: 'user', timestamp: new Date().toISOString() },
  })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '同一个任务标题' } })}\n`);
  await writeFile(databaseSubagentRollout, `${JSON.stringify({
    type: 'session_meta',
    payload: {
      id: 'database-subagent', cwd: '/project', thread_source: 'subagent',
      parent_thread_id: 'user-thread', timestamp: new Date().toISOString(),
    },
  })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '同一个任务标题' } })}\n`);
  await writeFile(scanSubagentRollout, `${JSON.stringify({
    type: 'session_meta',
    payload: {
      id: 'scan-subagent', cwd: '/project',
      source: { subagent: { thread_spawn: { parent_thread_id: 'user-thread' } } },
      timestamp: new Date().toISOString(),
    },
  })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '同一个任务标题' } })}\n`);

  const sqlite = await initSqlJs();
  const database = new sqlite.Database();
  database.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    created_at_ms INTEGER, updated_at_ms INTEGER, cwd TEXT NOT NULL, title TEXT NOT NULL,
    first_user_message TEXT NOT NULL, preview TEXT NOT NULL, archived INTEGER NOT NULL,
    has_user_event INTEGER NOT NULL, recency_at_ms INTEGER NOT NULL, thread_source TEXT
  )`);
  const insert = `INSERT INTO threads (
    id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms, cwd, title,
    first_user_message, preview, archived, has_user_event, recency_at_ms, thread_source
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  database.run(insert, [
    'user-thread', userRollout, 1, 3, 1_000, 3_000, '/project', '同一个任务标题',
    '同一个任务标题', '同一个任务标题', 0, 1, 3_000, 'user',
  ]);
  database.run(insert, [
    'database-subagent', databaseSubagentRollout, 1, 2, 1_000, 2_000, '/project', '同一个任务标题',
    '同一个任务标题', '同一个任务标题', 0, 1, 2_000, 'subagent',
  ]);
  await writeFile(databasePath, database.export());
  database.close();

  try {
    const store = new CodexSessionStore({ databasePath });
    assert.deepEqual((await store.listThreads()).map((thread) => thread.id), ['user-thread']);
    await assert.rejects(store.readThread('database-subagent'), /本地会话记录不存在/);
    await assert.rejects(store.readThread('scan-subagent'), /本地会话记录不存在/);
    assert.equal((await store.readThread('database-subagent', true, 12, true)).id, 'database-subagent');
    assert.equal((await store.readThread('scan-subagent', true, 12, true)).id, 'scan-subagent');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
