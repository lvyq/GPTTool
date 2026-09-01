import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';

const require = createRequire(import.meta.url);
const STALE_IN_PROGRESS_AFTER_MS = 10 * 60 * 1000;
const MAX_ROLLOUT_CACHE_FILES = 6;
const ROLLOUT_READ_BLOCK_BYTES = 1024 * 1024;
const MAX_ROLLOUT_RECORD_BYTES = 24 * 1024 * 1024;
// Version 2 re-parses attachment prompts written by newer Codex builds that
// use the shorter "My request" transport marker. Older cached turns may still
// contain the internal file-path wrapper and must not be reused.
const DISK_CACHE_VERSION = 2;
const MAX_DISK_CACHE_FILES = 12;
const MAX_DISK_CACHE_BYTES = 8 * 1024 * 1024;
let sqlitePromise: Promise<SqlJsStatic> | undefined;
const rolloutCache = new Map<string, {
  size: number;
  mtimeMs: number;
  stale: boolean;
  turnLimit: number;
  turns: CodexTurn[];
}>();

export interface CodexHistoryItem {
  id: string;
  type: 'userMessage' | 'agentMessage' | 'reasoning' | 'commandExecution' | 'fileChange' | 'mcpToolCall';
  status?: string;
  content?: Array<{
    type: 'text' | 'attachment';
    text?: string;
    name?: string;
    mimeType?: string;
    imageUrl?: string;
  }>;
  text?: string;
  summary?: string[];
  command?: string;
  aggregatedOutput?: string;
  exitCode?: number;
  changes?: Array<{ path?: string; file?: string }>;
  server?: string;
  tool?: string;
  kind?: string;
  input?: string;
  result?: string;
}

export interface CodexTurn {
  id: string;
  status: 'inProgress' | 'completed' | 'failed';
  items: CodexHistoryItem[];
}

export interface CodexThread {
  id: string;
  name: string;
  preview: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  status: { type: 'active' | 'idle' | 'systemError' };
  turns?: CodexTurn[];
  rolloutPath?: string;
}

export interface CodexSessionStoreOptions {
  databasePath: string;
  cacheDirectory?: string;
}

interface RolloutDiskCache {
  version: number;
  sourcePath: string;
  size: number;
  mtimeMs: number;
  stale: boolean;
  turnLimit: number;
  turns: CodexTurn[];
}

interface ThreadRow {
  id: string;
  rollout_path: string;
  created_at: number;
  updated_at: number;
  created_at_ms: number | null;
  updated_at_ms: number | null;
  cwd: string;
  title: string;
  first_user_message: string;
  preview: string;
}

export class CodexSessionStore {
  readonly #sessionsDirectory: string;

  constructor(private readonly options: CodexSessionStoreOptions) {
    this.#sessionsDirectory = path.join(path.dirname(options.databasePath), 'sessions');
  }

  async listThreads(limit = 50): Promise<CodexThread[]> {
    const merged = new Map<string, CodexThread>();
    let database: Database | undefined;
    let databaseError: unknown;
    try {
      database = await this.#open();
      const sourceFilter = tableHasColumn(database, 'threads', 'thread_source')
        ? ` AND COALESCE(thread_source, '') <> 'subagent'`
        : '';
      const rows = queryRows(database, `
        SELECT id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,
               cwd, title, first_user_message, preview
        FROM threads
        WHERE archived = 0${sourceFilter}
        ORDER BY CASE WHEN recency_at_ms > 0 THEN recency_at_ms ELSE updated_at_ms END DESC,
                 updated_at DESC
        LIMIT ?
      `, [Math.max(1, Math.min(limit, 200))]) as unknown as ThreadRow[];
      for (const [id, thread] of rows.map((row) => {
        const thread = this.#threadFromRow(row, false);
        return [thread.id, thread] as const;
      })) merged.set(id, thread);
    } catch (error) {
      databaseError = error;
    } finally {
      database?.close();
    }
    for (const thread of scanSessionThreads(this.#sessionsDirectory, Math.max(limit * 3, 100))) {
      const existing = merged.get(thread.id);
      if (!existing) {
        merged.set(thread.id, thread);
        continue;
      }
      // The official state database owns the generated task title. Session
      // JSONL files are newer while a turn is running, but their first "user"
      // record can be injected environment/XML context rather than the title
      // displayed by the official client.
      merged.set(thread.id, {
        ...thread,
        ...existing,
        name: existing.name === '未命名任务' ? thread.name : existing.name,
        preview: existing.preview === '未命名任务' ? thread.preview : existing.preview,
        createdAt: Math.min(existing.createdAt, thread.createdAt),
        updatedAt: Math.max(existing.updatedAt, thread.updatedAt),
        status: existing.status.type === 'active' || thread.status.type === 'active' ? { type: 'active' } : existing.status,
        rolloutPath: existing.rolloutPath || thread.rolloutPath,
      });
    }
    const result = [...merged.values()].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit);
    if (!result.length && databaseError) throw readableDatabaseError(databaseError);
    return result;
  }

  async readThread(threadId: string, includeTurns = true, turnLimit = 120, allowOfficialSubagent = false): Promise<CodexThread> {
    let database: Database | undefined;
    let databaseError: unknown;
    let row: ThreadRow | undefined;
    try {
      database = await this.#open();
      const sourceFilter = !allowOfficialSubagent && tableHasColumn(database, 'threads', 'thread_source')
        ? ` AND COALESCE(thread_source, '') <> 'subagent'`
        : '';
      row = queryRows(database, `
        SELECT id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,
               cwd, title, first_user_message, preview
        FROM threads WHERE id = ?${sourceFilter} LIMIT 1
      `, [threadId])[0] as unknown as ThreadRow | undefined;
    } catch (error) {
      databaseError = error;
    } finally {
      database?.close();
    }
    if (!row) {
      const scanned = scanSessionThreads(this.#sessionsDirectory, 500, allowOfficialSubagent)
        .find((thread) => thread.id === threadId);
      if (!scanned) {
        if (databaseError) throw readableDatabaseError(databaseError);
        throw new Error('此任务的本地会话记录不存在');
      }
      if (!includeTurns) return scanned;
      const turns = await this.#readRollout(scanned.rolloutPath ?? '', turnLimit);
      return { ...scanned, status: { type: turns.some((turn) => turn.status === 'inProgress') ? 'active' : 'idle' }, turns };
    }
    const thread = this.#threadFromRow(row, false);
    if (!includeTurns) return thread;
    const turns = await this.#readRollout(thread.rolloutPath ?? '', turnLimit);
    return {
      ...thread,
      status: { type: turns.some((turn) => turn.status === 'inProgress') ? 'active' : 'idle' },
      turns,
    };
  }

  async newestThreadAfter(updatedAfterMs: number, excludeId = ''): Promise<CodexThread | undefined> {
    return (await this.listThreads(30)).find((thread) => thread.id !== excludeId && normalizeEpochMs(thread.updatedAt) >= updatedAfterMs);
  }

  #threadFromRow(row: ThreadRow, includeTurns: boolean, turnLimit = 120): CodexThread {
    const rolloutPath = expandHome(row.rollout_path);
    const turns = includeTurns ? parseRollout(rolloutPath, turnLimit) : undefined;
    const active = turns?.some((turn) => turn.status === 'inProgress') ?? rolloutActive(rolloutPath);
    const createdAt = epochValue(row.created_at_ms, row.created_at);
    const updatedAt = epochValue(row.updated_at_ms, row.updated_at);
    const name = cleanTitle(row.title) || cleanTitle(row.first_user_message) || '未命名任务';
    return {
      id: row.id,
      name,
      preview: cleanTitle(row.preview) || name,
      cwd: row.cwd,
      createdAt,
      updatedAt,
      status: { type: active ? 'active' : 'idle' },
      turns,
      rolloutPath,
    };
  }

  async #readRollout(filePath: string, turnLimit: number): Promise<CodexTurn[]> {
    const boundedTurnLimit = Math.max(1, Math.min(120, Math.floor(turnLimit)));
    const source = await safeAsyncStat(filePath);
    if (!source) return [];
    const stale = source.mtimeMs < Date.now() - STALE_IN_PROGRESS_AFTER_MS;
    const cachePath = this.#rolloutCachePath(filePath);
    if (cachePath) {
      const cached = await readDiskRolloutCache(cachePath);
      if (
        cached
        && cached.sourcePath === filePath
        && cached.size === source.size
        && cached.mtimeMs === source.mtimeMs
        && cached.stale === stale
        && cached.turnLimit >= boundedTurnLimit
      ) {
        return cloneTurns(cached.turns.slice(-boundedTurnLimit));
      }
      if (
        cached
        && cached.sourcePath === filePath
        && cached.size < source.size
        && cached.turnLimit >= boundedTurnLimit
      ) {
        const retainedTurnLimit = Math.max(boundedTurnLimit, cached.turnLimit);
        const addedTurns = countTaskStartsAfter(filePath, cached.size, source.size, retainedTurnLimit);
        const recent = parseRollout(filePath, Math.min(retainedTurnLimit, addedTurns + 1));
        const merged = mergeRolloutTurns(cached.turns, recent, retainedTurnLimit);
        void this.#writeRolloutCache(cachePath, {
          version: DISK_CACHE_VERSION,
          sourcePath: filePath,
          size: source.size,
          mtimeMs: source.mtimeMs,
          stale,
          turnLimit: retainedTurnLimit,
          turns: merged,
        });
        return cloneTurns(merged.slice(-boundedTurnLimit));
      }
    }
    const turns = parseRollout(filePath, boundedTurnLimit);
    if (cachePath) {
      void this.#writeRolloutCache(cachePath, {
        version: DISK_CACHE_VERSION,
        sourcePath: filePath,
        size: source.size,
        mtimeMs: source.mtimeMs,
        stale,
        turnLimit: boundedTurnLimit,
        turns,
      });
    }
    return turns;
  }

  #rolloutCachePath(filePath: string): string | undefined {
    if (!this.options.cacheDirectory || !filePath) return undefined;
    const key = createHash('sha256').update(filePath).digest('hex');
    return path.join(this.options.cacheDirectory, `${key}.json`);
  }

  async #writeRolloutCache(cachePath: string, value: RolloutDiskCache): Promise<void> {
    try {
      const encoded = JSON.stringify(value);
      if (Buffer.byteLength(encoded, 'utf8') > MAX_DISK_CACHE_BYTES) return;
      await mkdir(path.dirname(cachePath), { recursive: true });
      const temporary = `${cachePath}.${process.pid}.tmp`;
      await writeFile(temporary, encoded, { mode: 0o600 });
      await rename(temporary, cachePath);
      await trimDiskRolloutCache(path.dirname(cachePath));
    } catch {
      // A cache failure must never make the official Codex history unreadable.
    }
  }

  async #open(): Promise<Database> {
    if (!existsSync(this.options.databasePath)) throw new Error(`没有找到 Codex 本地状态库：${this.options.databasePath}`);
    const sqlite = await loadSqlite();
    let lastError: unknown;
    for (const retryDelay of [0, 80, 240]) {
      if (retryDelay) await delay(retryDelay);
      try {
        return new sqlite.Database(new Uint8Array(await readFile(this.options.databasePath)));
      } catch (error) {
        lastError = error;
        if (!isTransientDatabaseError(error)) break;
      }
    }
    throw lastError;
  }
}

function isTransientDatabaseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /disk I\/O|SQLITE_IOERR|resource busy|temporarily unavailable|EBUSY|EIO/i.test(message);
}

function readableDatabaseError(error: unknown): Error {
  if (isTransientDatabaseError(error)) return new Error('本机 Codex 正在恢复会话数据，请稍后重试');
  return error instanceof Error ? error : new Error(String(error));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function safeAsyncStat(filePath: string): Promise<{ size: number; mtimeMs: number } | undefined> {
  if (!filePath) return undefined;
  try {
    const value = await stat(filePath);
    return { size: value.size, mtimeMs: value.mtimeMs };
  } catch {
    return undefined;
  }
}

async function readDiskRolloutCache(cachePath: string): Promise<RolloutDiskCache | undefined> {
  try {
    const value = JSON.parse(await readFile(cachePath, 'utf8')) as Partial<RolloutDiskCache>;
    if (
      value.version !== DISK_CACHE_VERSION
      || typeof value.sourcePath !== 'string'
      || typeof value.size !== 'number'
      || typeof value.mtimeMs !== 'number'
      || typeof value.stale !== 'boolean'
      || typeof value.turnLimit !== 'number'
      || !Array.isArray(value.turns)
    ) return undefined;
    return value as RolloutDiskCache;
  } catch {
    return undefined;
  }
}

async function trimDiskRolloutCache(directory: string): Promise<void> {
  try {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
    if (entries.length <= MAX_DISK_CACHE_FILES) return;
    const files = await Promise.all(entries.map(async (entry) => {
      const filePath = path.join(directory, entry.name);
      const info = await safeAsyncStat(filePath);
      return { filePath, mtimeMs: info?.mtimeMs ?? 0 };
    }));
    files.sort((left, right) => right.mtimeMs - left.mtimeMs);
    await Promise.all(files.slice(MAX_DISK_CACHE_FILES).map((entry) => unlink(entry.filePath).catch(() => undefined)));
  } catch {
    // Best-effort size control only.
  }
}

async function loadSqlite(): Promise<SqlJsStatic> {
  sqlitePromise ??= initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
  return sqlitePromise;
}

function queryRows(database: Database, sql: string, parameters: Array<string | number>): Array<Record<string, unknown>> {
  const statement = database.prepare(sql);
  try {
    statement.bind(parameters);
    const rows: Array<Record<string, unknown>> = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

function tableHasColumn(database: Database, table: string, column: string): boolean {
  return queryRows(database, `PRAGMA table_info(${table})`, []).some((row) => row.name === column);
}

export function parseRollout(filePath: string, turnLimit = 120): CodexTurn[] {
  if (!filePath || !existsSync(filePath)) return [];
  const boundedTurnLimit = Math.max(1, Math.min(120, Math.floor(turnLimit)));
  let fileStat;
  try {
    fileStat = statSync(filePath);
  } catch {
    return [];
  }
  const stale = fileStat.mtimeMs < Date.now() - STALE_IN_PROGRESS_AFTER_MS;
  const cached = rolloutCache.get(filePath);
  if (
    cached
    && cached.size === fileStat.size
    && cached.mtimeMs === fileStat.mtimeMs
    && cached.stale === stale
    && cached.turnLimit >= boundedTurnLimit
  ) {
    touchRolloutCache(filePath, cached);
    return cloneTurns(cached.turns.slice(-boundedTurnLimit));
  }
  const turns: CodexTurn[] = [];
  const calls = new Map<string, CodexHistoryItem>();
  let current: CodexTurn | undefined;
  let fallback = 0;
  const activeTurn = (): CodexTurn => {
    if (!current) {
      current = { id: `history-${++fallback}`, status: 'completed', items: [] };
      turns.push(current);
    }
    return current;
  };
  for (const line of readRolloutLines(filePath, boundedTurnLimit, fileStat.size)) {
    if (!line) continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const payload = asRecord(record.payload);
    if (!payload) continue;
    if (record.type === 'event_msg' && payload.type === 'task_started') {
      const turnId = stringValue(payload.turn_id) || `turn-${++fallback}`;
      current = { id: turnId, status: 'inProgress', items: [] };
      turns.push(current);
      continue;
    }
    if (record.type === 'event_msg' && (payload.type === 'task_complete' || payload.type === 'turn_aborted')) {
      const turnId = stringValue(payload.turn_id);
      const turn = (turnId && findLastTurn(turns, (candidate) => candidate.id === turnId)) || current;
      if (turn) {
        turn.status = payload.type === 'task_complete' ? 'completed' : 'failed';
        for (const item of turn.items) item.status = turn.status;
      }
      if (turn === current) current = undefined;
      continue;
    }
    if (record.type !== 'response_item') continue;
    const payloadType = stringValue(payload.type);
    if (payloadType === 'message') {
      const role = stringValue(payload.role);
      if (role !== 'user' && role !== 'assistant') continue;
      const turn = activeTurn();
      const itemId = stringValue(payload.id) || `${turn.id}-${role}-${turn.items.length + 1}`;
      if (role === 'user') {
        const content = messageContent(payload.content);
        if (content.length) turn.items.push({ id: itemId, type: 'userMessage', status: 'completed', content });
      } else {
        const text = messageText(payload.content);
        if (text) turn.items.push({ id: itemId, type: 'agentMessage', status: turn.status, text });
      }
      continue;
    }
    if (payloadType === 'reasoning') {
      const summary = textArray(payload.summary);
      if (summary.length) activeTurn().items.push({
        id: stringValue(payload.id) || `reasoning-${++fallback}`,
        type: 'reasoning',
        status: current?.status,
        summary,
      });
      continue;
    }
    if (['function_call', 'custom_tool_call', 'tool_search_call'].includes(payloadType)) {
      const turn = activeTurn();
      const callId = stringValue(payload.call_id) || stringValue(payload.id) || `call-${++fallback}`;
      const name = stringValue(payload.name) || (payloadType === 'tool_search_call' ? 'tool_search' : 'tool');
      // Newer rollouts include an outer custom "exec" record as well as the
      // concrete nested tool record. Showing both duplicates nearly every step.
      if (payloadType === 'custom_tool_call' && name === 'exec') continue;
      const input = stringValue(payload.arguments) || stringValue(payload.input);
      const item = processItem(callId, name, input, stringValue(payload.status) || turn.status);
      turn.items.push(item);
      calls.set(callId, item);
      continue;
    }
    if (['function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(payloadType)) {
      const callId = stringValue(payload.call_id);
      const item = calls.get(callId);
      if (!item) continue;
      item.status = 'completed';
      item.result = compactValue(payload.output ?? payload.results);
      if (item.type === 'commandExecution') {
        item.aggregatedOutput = item.result;
        const exitMatch = item.result.match(/Process exited with code (-?\d+)/);
        if (exitMatch) item.exitCode = Number(exitMatch[1]);
      }
    }
  }
  // A crash can leave task_started without task_complete. Once the rollout has
  // stopped changing, release the remote composer instead of locking its queue
  // forever on a turn that no process is still executing.
  if (stale) {
    for (const turn of turns) {
      if (turn.status !== 'inProgress') continue;
      turn.status = 'failed';
      for (const item of turn.items) item.status = 'failed';
    }
  }
  const result = turns.slice(-boundedTurnLimit);
  touchRolloutCache(filePath, {
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    stale,
    turnLimit: boundedTurnLimit,
    turns: cloneTurns(result),
  });
  return result;
}

export function clearRolloutCache(): void {
  rolloutCache.clear();
}

function cloneTurns(turns: CodexTurn[]): CodexTurn[] {
  return structuredClone(turns);
}

function mergeRolloutTurns(cached: CodexTurn[], recent: CodexTurn[], turnLimit: number): CodexTurn[] {
  const merged = new Map(cached.map((turn) => [turn.id, turn]));
  for (const turn of recent) {
    merged.delete(turn.id);
    merged.set(turn.id, turn);
  }
  return cloneTurns([...merged.values()].slice(-turnLimit));
}

function countTaskStartsAfter(filePath: string, start: number, size: number, limit: number): number {
  if (start >= size) return 0;
  const markerPattern = /"type"\s*:\s*"task_started"/g;
  const descriptor = openSync(filePath, 'r');
  let position = start;
  let previousSuffix = '';
  let count = 0;
  try {
    while (position < size && count < limit) {
      const length = Math.min(ROLLOUT_READ_BLOCK_BYTES, size - position);
      const block = Buffer.allocUnsafe(length);
      const bytesRead = readSync(descriptor, block, 0, length, position);
      if (!bytesRead) break;
      position += bytesRead;
      const current = block.subarray(0, bytesRead).toString('utf8');
      const searchable = previousSuffix + current;
      markerPattern.lastIndex = 0;
      for (const match of searchable.matchAll(markerPattern)) {
        if ((match.index ?? 0) + (match[0]?.length ?? 0) <= previousSuffix.length) continue;
        count += 1;
        if (count >= limit) break;
      }
      previousSuffix = current.slice(-128);
    }
    return count;
  } catch {
    return limit;
  } finally {
    closeSync(descriptor);
  }
}

function touchRolloutCache(filePath: string, entry: NonNullable<ReturnType<typeof rolloutCache.get>>): void {
  rolloutCache.delete(filePath);
  rolloutCache.set(filePath, entry);
  while (rolloutCache.size > MAX_ROLLOUT_CACHE_FILES) {
    const oldest = rolloutCache.keys().next().value;
    if (typeof oldest !== 'string') break;
    rolloutCache.delete(oldest);
  }
}

function* readRolloutLines(filePath: string, turnLimit: number, size = statSync(filePath).size): Generator<string> {
  if (!size) return;
  const markerPattern = /"type"\s*:\s*"task_started"/g;
  const descriptor = openSync(filePath, 'r');
  try {
    // Locate the requested recent turns by scanning backwards in fixed blocks.
    // We never concatenate the full rollout, so a 500 MB+ history cannot hit
    // V8's single-string limit. One extra marker lets the caller determine
    // whether an older history page exists.
    let startOffset = size;
    let markerCount = 0;
    let laterPrefix = '';
    while (startOffset > 0 && markerCount <= turnLimit) {
      const blockStart = Math.max(0, startOffset - ROLLOUT_READ_BLOCK_BYTES);
      const block = Buffer.allocUnsafe(startOffset - blockStart);
      const bytesRead = readSync(descriptor, block, 0, block.length, blockStart);
      const blockText = block.subarray(0, bytesRead).toString('utf8');
      const searchable = blockText + laterPrefix;
      markerPattern.lastIndex = 0;
      for (const match of searchable.matchAll(markerPattern)) {
        if ((match.index ?? searchable.length) < blockText.length) markerCount += 1;
      }
      laterPrefix = searchable.slice(0, 128);
      startOffset = blockStart;
    }

    let position = startOffset;
    let carry = Buffer.alloc(0);
    let discardFirstPartialLine = startOffset > 0;
    let discardOversizedLine = false;
    while (position < size) {
      const length = Math.min(ROLLOUT_READ_BLOCK_BYTES, size - position);
      const block = Buffer.allocUnsafe(length);
      const bytesRead = readSync(descriptor, block, 0, length, position);
      if (!bytesRead) break;
      position += bytesRead;
      let combined = carry.length ? Buffer.concat([carry, block.subarray(0, bytesRead)]) : block.subarray(0, bytesRead);
      let lineStart = 0;
      for (let newline = combined.indexOf(10, lineStart); newline >= 0; newline = combined.indexOf(10, lineStart)) {
        if (discardFirstPartialLine || discardOversizedLine) {
          discardFirstPartialLine = false;
          discardOversizedLine = false;
        } else {
          const line = combined.subarray(lineStart, newline);
          if (line.length <= MAX_ROLLOUT_RECORD_BYTES) yield line.toString('utf8');
        }
        lineStart = newline + 1;
      }
      carry = combined.subarray(lineStart);
      if (carry.length > MAX_ROLLOUT_RECORD_BYTES) {
        carry = Buffer.alloc(0);
        discardOversizedLine = true;
      } else if (carry.byteOffset > ROLLOUT_READ_BLOCK_BYTES * 2) {
        carry = Buffer.from(carry);
      }
    }
    if (!discardFirstPartialLine && !discardOversizedLine && carry.length && carry.length <= MAX_ROLLOUT_RECORD_BYTES) {
      yield carry.toString('utf8');
    }
  } finally {
    closeSync(descriptor);
  }
}

function processItem(id: string, name: string, input: string, status: string): CodexHistoryItem {
  const normalized = name.toLowerCase();
  const parsed = parseJsonRecord(input);
  if (['exec_command', 'write_stdin', 'wait'].includes(normalized)) {
    return {
      id, type: 'commandExecution', kind: 'command', status,
      command: stringValue(parsed?.cmd) || commandLabel(normalized, parsed),
    };
  }
  if (normalized === 'apply_patch') {
    const patch = input || stringValue(parsed?.input);
    const changes = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => ({ path: match[1] }));
    return { id, type: 'fileChange', kind: 'file', status, changes, input: truncateHistoryText(patch, 20_000) };
  }
  const kind = /search|find|open|browser|web/.test(normalized) ? 'search'
    : /image|view/.test(normalized) ? 'image'
      : /plan/.test(normalized) ? 'plan'
        : 'tool';
  return {
    id, type: 'mcpToolCall', kind, status,
    server: toolServer(name),
    tool: friendlyToolName(name),
    input: truncateHistoryText(input, 20_000),
  };
}

function commandLabel(name: string, input: Record<string, unknown> | undefined): string {
  if (name === 'write_stdin') return '等待正在运行的命令';
  if (name === 'wait') return '等待任务完成';
  return stringValue(input?.cmd) || name;
}

function toolServer(name: string): string {
  const parts = name.split('__').filter(Boolean);
  return parts.length > 1 ? (parts[0] ?? '') : '';
}

function friendlyToolName(name: string): string {
  const raw = name.split('__').filter(Boolean).at(-1) || name;
  const labels: Record<string, string> = {
    exec: '执行操作',
    update_plan: '更新执行计划',
    tool_search: '查找工具',
    view_image: '查看图片',
    open: '浏览页面',
    search_query: '搜索网页',
  };
  return labels[raw] || raw.replaceAll('_', ' ');
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

function compactValue(value: unknown): string {
  if (typeof value === 'string') return truncateHistoryText(value, 60_000);
  try { return truncateHistoryText(JSON.stringify(value), 60_000); } catch { return ''; }
}

function truncateHistoryText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n\n[内容已截断]` : value;
}

function rolloutActive(filePath: string): boolean {
  if (!filePath || !existsSync(filePath)) return false;
  try {
    const stat = statSync(filePath);
    if (Date.now() - stat.mtimeMs > 6 * 60 * 60 * 1000) return false;
    let active = false;
    for (const line of readTail(filePath, 384 * 1024).split('\n')) {
      let record: Record<string, unknown>;
      try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const payload = asRecord(record.payload);
      if (record.type !== 'event_msg' || !payload) continue;
      if (payload.type === 'task_started') active = true;
      if (payload.type === 'task_complete' || payload.type === 'turn_aborted') active = false;
    }
    return active;
  } catch {
    return false;
  }
}

function scanSessionThreads(directory: string, scanLimit: number, includeSubagents = false): CodexThread[] {
  if (!existsSync(directory)) return [];
  let files: string[];
  try {
    files = (readdirSync(directory, { recursive: true, encoding: 'utf8' }) as string[])
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => path.join(directory, name))
      .sort((left, right) => safeMtime(right) - safeMtime(left))
      .slice(0, scanLimit);
  } catch {
    return [];
  }
  const threads: CodexThread[] = [];
  for (const file of files) {
    const prefix = readPrefix(file, 768 * 1024);
    let id = threadIdFromPath(file);
    let cwd = '';
    let createdAt = safeMtime(file);
    let name = '';
    let isSubagent = false;
    for (const line of prefix.split('\n')) {
      let record: Record<string, unknown>;
      try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const payload = asRecord(record.payload);
      if (!payload) continue;
      if (record.type === 'session_meta') {
        id = stringValue(payload.id) || stringValue(payload.session_id) || id;
        cwd = stringValue(payload.cwd) || cwd;
        const source = asRecord(payload.source);
        isSubagent = stringValue(payload.thread_source) === 'subagent'
          || Boolean(asRecord(source?.subagent))
          || Boolean(stringValue(payload.parent_thread_id));
        const timestamp = Date.parse(stringValue(payload.timestamp));
        if (Number.isFinite(timestamp)) createdAt = timestamp;
      }
      if (!name && record.type === 'event_msg' && payload.type === 'user_message') {
        name = cleanScannedTitle(stringValue(payload.message));
      }
      if (!name && record.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
        name = cleanScannedTitle(messageText(payload.content));
      }
      if (id && cwd && name) break;
    }
    if (!id || (isSubagent && !includeSubagents)) continue;
    const updatedAt = safeMtime(file);
    threads.push({
      id, name: name || '未命名任务', preview: name || '未命名任务', cwd,
      createdAt, updatedAt, status: { type: rolloutActive(file) ? 'active' : 'idle' }, rolloutPath: file,
    });
  }
  return threads;
}

function readPrefix(filePath: string, maxBytes: number): string {
  return readSlice(filePath, 0, maxBytes);
}

function readTail(filePath: string, maxBytes: number): string {
  try {
    const size = statSync(filePath).size;
    return readSlice(filePath, Math.max(0, size - maxBytes), maxBytes);
  } catch {
    return '';
  }
}

function readSlice(filePath: string, position: number, maxBytes: number): string {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(maxBytes);
    const read = readSync(descriptor, buffer, 0, maxBytes, position);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function threadIdFromPath(filePath: string): string {
  return path.basename(filePath).match(/([a-f0-9]{8}-[a-f0-9-]{27,})\.jsonl$/i)?.[1] ?? '';
}

function safeMtime(filePath: string): number {
  try { return statSync(filePath).mtimeMs; } catch { return 0; }
}

function epochValue(milliseconds: number | null, seconds: number): number {
  if (typeof milliseconds === 'number' && milliseconds > 0) return milliseconds;
  return seconds > 10_000_000_000 ? seconds : seconds * 1000;
}

function normalizeEpochMs(value: number): number {
  return value > 10_000_000_000 ? value : value * 1000;
}

function expandHome(value: string): string {
  if (!value.startsWith('~/')) return value;
  return path.join(process.env.HOME || process.env.USERPROFILE || '', value.slice(2));
}

function cleanTitle(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function cleanScannedTitle(value: string): string {
  const text = String(value || '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, ' ')
    .replace(/<permissions[^>]*>[\s\S]*?<\/permissions[^>]*>/gi, ' ')
    .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  return cleanTitle(text);
}

function messageText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    const record = asRecord(part);
    if (!record || !['input_text', 'output_text', 'text'].includes(String(record.type))) return '';
    return stringValue(record.text);
  }).filter(Boolean).join('\n').trim();
}

function messageContent(value: unknown): NonNullable<CodexHistoryItem['content']> {
  if (!Array.isArray(value)) return [];
  const rawText = messageText(value);
  const files = mentionedFiles(rawText);
  const prompt = cleanPromptText(rawText);
  const content: NonNullable<CodexHistoryItem['content']> = prompt ? [{ type: 'text', text: prompt }] : [];
  const images = value.map(asRecord).filter((part) => part?.type === 'input_image');
  let imageIndex = 0;
  for (const file of files) {
    const isImage = file.mimeType.startsWith('image/');
    const image = isImage ? images[imageIndex++] : undefined;
    content.push({
      type: 'attachment',
      name: file.name,
      mimeType: file.mimeType,
      ...(image ? { imageUrl: safeImageUrl(stringValue(image.image_url)) } : {}),
    });
  }
  for (; imageIndex < images.length; imageIndex += 1) {
    content.push({
      type: 'attachment',
      name: `图片 ${imageIndex + 1}`,
      mimeType: imageMimeType(stringValue(images[imageIndex]?.image_url)),
      imageUrl: safeImageUrl(stringValue(images[imageIndex]?.image_url)),
    });
  }
  return content;
}

function mentionedFiles(text: string): Array<{ name: string; mimeType: string }> {
  const files: Array<{ name: string; mimeType: string }> = [];
  const seen = new Set<string>();
  const section = text.match(/# Files mentioned by the user:\s*([\s\S]*?)(?:\n## My request(?: for Codex)?:|$)/i)?.[1] ?? '';
  for (const match of section.matchAll(/^##\s+(.+?):\s+(.+)$/gm)) {
    const name = path.basename((match[1] ?? '').trim()) || path.basename((match[2] ?? '').trim());
    if (!name || seen.has(name)) continue;
    seen.add(name);
    files.push({ name, mimeType: mimeTypeForName(name) });
  }
  return files;
}

function cleanPromptText(text: string): string {
  // Remote attachments created by different Codex builds use either
  // "My request for Codex" or the shorter "My request" marker. Treat both
  // as transport metadata so the Web UI renders only the real user prompt.
  const marker = text.match(/(?:^|\n)## My request(?: for Codex)?:\s*\n/i);
  const prompt = marker?.index === undefined ? text : text.slice(marker.index + marker[0].length);
  return prompt
    .replace(/<(environment_context|recommended_plugins|app-context|permissions|apps_instructions|plugins_instructions|skills_instructions|collaboration_mode)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<image\b[^>]*>\s*/gi, '')
    .replace(/<\/image>/gi, '')
    .trim();
}

function mimeTypeForName(name: string): string {
  const extension = path.extname(name).toLowerCase();
  const known: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.heic': 'image/heic', '.pdf': 'application/pdf',
    '.json': 'application/json', '.csv': 'text/csv', '.txt': 'text/plain', '.md': 'text/markdown',
    '.zip': 'application/zip', '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return known[extension] || 'application/octet-stream';
}

function imageMimeType(url: string): string {
  return url.match(/^data:([^;,]+)[;,]/i)?.[1] || 'image/*';
}

function safeImageUrl(value: string): string | undefined {
  return /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(value) && value.length <= 2_800_000
    ? value
    : undefined;
}

function textArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((part) => {
    if (typeof part === 'string') return part;
    return stringValue(asRecord(part)?.text);
  }).filter(Boolean);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function findLastTurn(turns: CodexTurn[], predicate: (turn: CodexTurn) => boolean): CodexTurn | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn && predicate(turn)) return turn;
  }
  return undefined;
}
