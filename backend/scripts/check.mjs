import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const source = new URL('../src/', import.meta.url);
for (const file of await readdir(source)) {
  if (file.endsWith('.mjs')) execFileSync(process.execPath, ['--check', fileURLToPath(new URL(file, source))], { stdio: 'inherit' });
}
