import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compareVersions,
  parseSignedUpdateManifest,
  UpdateManager,
  type SignedUpdateEnvelope,
  type UpdateManifestPayload,
} from '../src/desktop/update-manager.ts';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

test('verifies the signed update feed and rejects tampering', () => {
  const manifest = createManifest(Buffer.from('installer'));
  const envelope = signManifest(manifest);
  assert.deepEqual(parseSignedUpdateManifest(envelope, publicKeyBase64), manifest);

  const tampered = {
    ...envelope,
    payload: Buffer.from(JSON.stringify({ ...manifest, version: '9.9.9' })).toString('base64'),
  };
  assert.throws(() => parseSignedUpdateManifest(tampered, publicKeyBase64), /签名无效/);
});

test('compares stable semantic versions', () => {
  assert.equal(compareVersions('0.1.1', '0.1.0'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.2.3', '2.0.0'), -1);
});

test('downloads an available update only after signature, size and hash verification', async () => {
  const installer = Buffer.from('verified GPTTool installer');
  const manifest = createManifest(installer);
  const envelope = signManifest(manifest);
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'gpttool-update-test-'));
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/latest.json')) {
      return new Response(JSON.stringify(envelope), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/GPTTool-0.1.1-universal.dmg')) return new Response(installer, { status: 200 });
    return new Response('not found', { status: 404 });
  };

  try {
    const manager = new UpdateManager({
      currentVersion: '0.1.0',
      platform: 'darwin',
      userDataDirectory: temporaryDirectory,
      executablePath: '/Applications/GPTTool.app/Contents/MacOS/GPTTool',
      manifestUrl: 'https://updates.example.com/updates/latest.json',
      publicKey: publicKeyBase64,
      autoUpdate: false,
      fetchImpl,
    });
    assert.equal((await manager.check()).phase, 'available');
    const downloaded = await manager.download();
    assert.equal(downloaded.phase, 'downloaded');
    assert.deepEqual(await readFile(downloaded.downloadedPath!), installer);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

function createManifest(installer: Buffer): UpdateManifestPayload {
  return {
    schema: 1,
    version: '0.1.1',
    publishedAt: '2026-07-29T00:00:00.000Z',
    notes: ['自动更新测试'],
    artifacts: {
      darwin: {
        url: 'https://updates.example.com/updates/GPTTool-0.1.1-universal.dmg',
        size: installer.length,
        sha256: createHash('sha256').update(installer).digest('hex'),
      },
    },
  };
}

function signManifest(manifest: UpdateManifestPayload): SignedUpdateEnvelope {
  const payload = Buffer.from(JSON.stringify(manifest));
  return {
    payload: payload.toString('base64'),
    signature: sign(null, payload, privateKey).toString('base64'),
  };
}
