import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPairingQrCode, createRemoteQrCode } from '../src/desktop/remote-qr.ts';

test('creates a local QR data URL without exposing the credential separately', async () => {
  const url = 'https://remote.example/?token=secret';
  const result = await createRemoteQrCode(url);
  assert.equal(result.url, url);
  assert.match(result.dataUrl, /^data:image\/png;base64,/);
  assert.ok(result.dataUrl.length > 500);
});

test('rejects non-Web remote QR targets', async () => {
  await assert.rejects(() => createRemoteQrCode('file:///tmp/private'), /无效/);
});

test('creates a one-time pairing QR without putting the code in the request query', async () => {
  const result = await createPairingQrCode('https://remote.example/astergate/', 'a1b2c3d4');
  assert.equal(result.url, 'https://remote.example/astergate/#pair=A1B2C3D4');
  assert.match(result.dataUrl, /^data:image\/png;base64,/);
  await assert.rejects(() => createPairingQrCode('https://remote.example/', 'not-a-code'), /配对二维码无效/);
});

test('allows locally generated QR data images in the desktop renderer CSP', async () => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url));
  const html = await readFile(path.join(testDirectory, '..', 'src', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /img-src\s+'self'\s+data:/);
});
