import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OfficialAppServerClient, readHostDirectory } from '../src/codex/thread-metadata-client.ts';

test('lists local directories without starting or waiting for the official app-server', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gpttool-directory-'));
  const client = new OfficialAppServerClient({ executable: '/missing/official-client' });
  try {
    await mkdir(path.join(root, 'project'));
    await writeFile(path.join(root, 'file.txt'), 'test');
    const result = await client.request<{ entries: Array<{ fileName: string; isDirectory: boolean; isFile: boolean }> }>('fs/readDirectory', { path: root });
    assert.equal(result.entries.find((item) => item.fileName === 'project')?.isDirectory, true);
    assert.equal(result.entries.find((item) => item.fileName === 'file.txt')?.isFile, true);
    await assert.rejects(readHostDirectory('relative'), /绝对路径/);
    await assert.rejects(readHostDirectory(path.join(root, 'missing')), /ENOENT/);
    if (process.platform !== 'win32') {
      await symlink(tmpdir(), path.join(root, 'link'));
      const linked = await readHostDirectory(root);
      assert.equal(linked.entries.find((item) => item.fileName === 'link')?.isDirectory, false);
    }
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});
