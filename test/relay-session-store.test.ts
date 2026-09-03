import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PersistentSessionStore } from '../backend/src/session-store.mjs';

test('relay sessions survive a process restart and expired sessions are removed', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gpttool-relay-session-'));
  const file = path.join(directory, 'sessions.json');
  const first = new PersistentSessionStore(file);
  first.set('valid', { userId: 'user-1', expiresAt: Date.now() + 60_000 });
  first.set('expired', { userId: 'user-2', expiresAt: Date.now() - 1 });

  const second = new PersistentSessionStore(file);
  assert.deepEqual(second.get('valid'), { userId: 'user-1', expiresAt: first.get('valid')?.expiresAt });
  assert.equal(second.get('expired'), undefined);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 1);
});
