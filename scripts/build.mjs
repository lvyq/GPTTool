import { existsSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { build } from 'esbuild';
import '../frontend/scripts/build.mjs';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const publicBuildConfig = {
  'process.env.GPTTOOL_RELAY_URL': JSON.stringify(process.env.GPTTOOL_RELAY_URL || ''),
  'process.env.GPTTOOL_UPDATE_MANIFEST_URL': JSON.stringify(process.env.GPTTOOL_UPDATE_MANIFEST_URL || ''),
  'process.env.GPTTOOL_UPDATE_PUBLIC_KEY': JSON.stringify(process.env.GPTTOOL_UPDATE_PUBLIC_KEY || ''),
};

await rm('dist', { recursive: true, force: true });
await mkdir('dist/desktop', { recursive: true });

await build({
  entryPoints: ['src/desktop/main.ts'],
  outdir: 'dist/desktop',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['electron', 'ws', 'sql.js', 'qrcode'],
  sourcemap: true,
  define: publicBuildConfig,
});

await build({
  entryPoints: ['src/desktop/preload.ts'],
  outfile: 'dist/desktop/preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: true,
});

await cp('src/renderer', 'dist/renderer', { recursive: true });
await cp('frontend/dist/remote', 'dist/remote-ui', { recursive: true });
