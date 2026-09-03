import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
// @ts-expect-error The relay runtime is native ESM JavaScript deployed as-is.
import { RelayStore } from '../backend/src/store.mjs';

test('an already-bound device can securely renew pairing for the same account', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gpttool-pairing-'));
  try {
    const store = new RelayStore(path.join(directory, 'relay.json'));
    const firstUser = store.createUser('first-user', 'correct-horse-battery-staple');
    const secondUser = store.createUser('second-user', 'another-secure-password');
    const identity = {
      deviceId: '11111111-1111-4111-8111-111111111111',
      name: '测试电脑',
      secret: '0123456789abcdefghijklmnopqrstuvwxyzABCDEFG',
    };

    const initial = store.createPairing(identity);
    store.claimPairing(firstUser.id, initial.code);

    const renewed = store.createPairing(identity);
    const sameDevice = store.claimPairing(firstUser.id, renewed.code);
    assert.equal(sameDevice.id, identity.deviceId);
    assert.equal(store.listDevices(firstUser.id).length, 1);

    const crossAccount = store.createPairing(identity);
    assert.throws(() => store.claimPairing(secondUser.id, crossAccount.code), /绑定到其他账号/);
    assert.throws(
      () => store.createPairing({ ...identity, secret: 'wrong-secret-that-is-still-long-enough-123456' }),
      /身份验证失败/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
