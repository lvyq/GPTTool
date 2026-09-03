import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('release notes and lockfile match the desktop package version before publishing', async () => {
  const [pkg, lock, notes] = await Promise.all(['package.json', 'package-lock.json', 'release-notes.json'].map(async name =>
    JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), 'utf8'))));
  assert.equal(notes.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
});
