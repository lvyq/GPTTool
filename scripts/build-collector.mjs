import { cp, mkdir, rm } from 'node:fs/promises';
import { build } from 'esbuild';

await rm('dist/collector', { recursive: true, force: true });
await rm('dist/collector-ui', { recursive: true, force: true });
await mkdir('dist/collector', { recursive: true });

await build({
  entryPoints: ['src/collector/main.ts'],
  outfile: 'dist/collector/main.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['electron', 'ws'],
  sourcemap: true,
});

await build({
  entryPoints: ['src/collector/preload.ts'],
  outfile: 'dist/collector/preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: true,
});

await cp('src/collector-ui', 'dist/collector-ui', { recursive: true });
