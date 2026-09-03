import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url);
const output = new URL('dist/', root);
const version = JSON.parse(await readFile(new URL('src/remote/web-version.json', root), 'utf8'));
if (!version.version || version.clientProtocol !== 1) throw new Error('Invalid Web protocol version');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const name of ['remote', 'gateway', 'admin']) {
  await cp(new URL(`src/${name}/`, root), new URL(`${name}/`, output), {
    recursive: true,
    filter: (source) => !/qr-decoder(?:-entry)?\.js$/.test(source),
  });
}
await build({
  entryPoints: [fileURLToPath(new URL('src/gateway/qr-decoder-entry.js', root))],
  outfile: fileURLToPath(new URL('gateway/qr-decoder.js', output)),
  bundle: true, platform: 'browser', format: 'iife', target: ['safari15'], legalComments: 'eof',
});
console.log(`Web ${version.version}: ${fileURLToPath(output)}`);
