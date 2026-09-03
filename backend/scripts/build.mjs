import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import './check.mjs';
const root = new URL('../', import.meta.url);
const output = new URL('dist/', root);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(new URL('src/', root), output, { recursive: true });
await cp(new URL('cdp-rules/', root), new URL('cdp-rules/', output), { recursive: true });
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
manifest.scripts = { start: 'node --env-file-if-exists=.env server.mjs', admin: 'node --env-file-if-exists=.env admin.mjs' };
await writeFile(new URL('package.json', output), JSON.stringify(manifest, null, 2) + '\n');
await cp(new URL('package-lock.json', root), new URL('package-lock.json', output));
for (const file of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
  await cp(new URL(`../${file}`, root), new URL(file, output));
}
console.log('API backend built: backend/dist (no frontend assets or private configuration)');
