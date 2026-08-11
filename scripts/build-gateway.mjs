import { build } from 'esbuild';

await build({
  entryPoints: ['src/gateway/qr-decoder.js'],
  outfile: 'deploy/relay-server/gateway/qr-decoder.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['safari15'],
  legalComments: 'eof',
});
