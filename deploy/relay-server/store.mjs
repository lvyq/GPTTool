import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { chownSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class RelayStore {
  #state;

  constructor(privateFile) {
    this.file = privateFile;
    this.#state = this.#load();
  }

  createUser(username, password) {
    const normalized = normalizeUsername(username);
    validatePassword(password);
    if (this.#state.users.some((user) => user.username === normalized)) throw new Error('账号已存在');
    const user = { id: randomUUID(), username: normalized, passwordHash: hashPassword(password), createdAt: Date.now() };
    this.#state.users.push(user);
    this.#save();
    return publicUser(user);
  }

  authenticate(username, password) {
    const normalized = normalizeUsername(username);
    const user = this.#state.users.find((candidate) => candidate.username === normalized);
    return user && verifyPassword(password, user.passwordHash) ? publicUser(user) : undefined;
  }

  changePassword(userId, currentPassword, nextPassword) {
    const user = this.#state.users.find((candidate) => candidate.id === userId);
    if (!user || !verifyPassword(currentPassword, user.passwordHash)) throw new Error('当前密码错误');
    validatePassword(nextPassword);
    user.passwordHash = hashPassword(nextPassword);
    this.#save();
  }

  resetPassword(username, nextPassword) {
    const normalized = normalizeUsername(username);
    const user = this.#state.users.find((candidate) => candidate.username === normalized);
    if (!user) throw new Error('账号不存在');
    validatePassword(nextPassword);
    user.passwordHash = hashPassword(nextPassword);
    this.#save();
    return publicUser(user);
  }

  createPairing({ deviceId, name, secret }) {
    validateDeviceId(deviceId);
    validateDeviceSecret(secret);
    const existingDevice = this.#state.devices.find((device) => device.id === deviceId);
    if (existingDevice && !secretMatches(secret, existingDevice.secretHash)) throw new Error('设备身份验证失败');
    this.#prunePairings();
    this.#state.pairings = this.#state.pairings.filter((pairing) => pairing.deviceId !== deviceId);
    const pairing = {
      code: uniquePairingCode(this.#state.pairings), deviceId, name: normalizeDeviceName(name),
      secretHash: existingDevice?.secretHash || hashSecret(secret), expiresAt: Date.now() + 10 * 60_000,
    };
    this.#state.pairings.push(pairing);
    this.#save();
    return { code: pairing.code, expiresAt: pairing.expiresAt };
  }

  claimPairing(userId, code) {
    this.#prunePairings();
    const normalizedCode = String(code).replace(/\s+/g, '').toUpperCase();
    const index = this.#state.pairings.findIndex((pairing) => pairing.code === normalizedCode);
    if (index < 0) throw new Error('配对二维码无效或已经过期');
    const pairing = this.#state.pairings[index];
    const existingDevice = this.#state.devices.find((device) => device.id === pairing.deviceId);
    if (existingDevice) {
      if (existingDevice.userId !== userId) throw new Error('设备已经绑定到其他账号');
      if (existingDevice.secretHash !== pairing.secretHash) throw new Error('设备身份验证失败');
      existingDevice.name = pairing.name;
      this.#state.pairings.splice(index, 1);
      this.#save();
      return publicDevice(existingDevice, false);
    }
    const device = {
      id: pairing.deviceId, userId, name: pairing.name, secretHash: pairing.secretHash,
      createdAt: Date.now(), lastSeenAt: null,
    };
    this.#state.devices.push(device);
    this.#state.pairings.splice(index, 1);
    this.#save();
    return publicDevice(device, false);
  }

  importDevice(userId, { deviceId, name, secret }) {
    validateDeviceId(deviceId);
    validateDeviceSecret(secret);
    if (this.#state.devices.some((device) => device.id === deviceId)) throw new Error('设备 ID 已存在');
    const device = { id: deviceId, userId, name: normalizeDeviceName(name), secretHash: hashSecret(secret), createdAt: Date.now(), lastSeenAt: null };
    this.#state.devices.push(device);
    this.#save();
    return publicDevice(device, false);
  }

  verifyDevice(deviceId, secret) {
    const device = this.#state.devices.find((candidate) => candidate.id === deviceId);
    if (!device || !secretMatches(secret, device.secretHash)) return undefined;
    device.lastSeenAt = Date.now();
    this.#save();
    return publicDevice(device, true);
  }

  userOwnsDevice(userId, deviceId) {
    return this.#state.devices.some((device) => device.userId === userId && device.id === deviceId);
  }

  listDevices(userId, onlineIds = new Set()) {
    return this.#state.devices.filter((device) => device.userId === userId).map((device) => publicDevice(device, onlineIds.has(device.id)));
  }

  revokeDevice(userId, deviceId) {
    const index = this.#state.devices.findIndex((device) => device.userId === userId && device.id === deviceId);
    if (index < 0) throw new Error('设备不存在');
    this.#state.devices.splice(index, 1);
    this.#save();
  }

  userById(userId) {
    const user = this.#state.users.find((candidate) => candidate.id === userId);
    return user ? publicUser(user) : undefined;
  }

  #prunePairings() {
    this.#state.pairings = this.#state.pairings.filter((pairing) => pairing.expiresAt > Date.now());
  }

  #load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (parsed.version === 1 && Array.isArray(parsed.users) && Array.isArray(parsed.devices) && Array.isArray(parsed.pairings)) return parsed;
    } catch { /* initialize below */ }
    return { version: 1, users: [], devices: [], pairings: [] };
  }

  #save() {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    let existing;
    try { existing = statSync(this.file); } catch { /* first write */ }
    writeFileSync(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, { mode: existing ? existing.mode & 0o777 : 0o600 });
    if (existing && process.getuid?.() === 0) chownSync(temporary, existing.uid, existing.gid);
    renameSync(temporary, this.file);
  }
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${digest.toString('base64url')}`;
}

function verifyPassword(password, saved) {
  const [, saltText, digestText] = String(saved).split('$');
  if (!saltText || !digestText) return false;
  const expected = Buffer.from(digestText, 'base64url');
  const actual = scryptSync(String(password), Buffer.from(saltText, 'base64url'), expected.length);
  return timingSafeEqual(actual, expected);
}

function hashSecret(secret) { return createHash('sha256').update(secret).digest('base64url'); }
function secretMatches(secret, expected) { return timingSafeEqual(Buffer.from(hashSecret(secret)), Buffer.from(expected)); }
function publicUser(user) { return { id: user.id, username: user.username }; }
function publicDevice(device, online) { return { id: device.id, name: device.name, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt, online }; }
function normalizeUsername(value) { const result = String(value).trim().toLowerCase(); if (!/^[a-z0-9][a-z0-9._@-]{2,63}$/.test(result)) throw new Error('账号格式无效'); return result; }
function validatePassword(value) { if (typeof value !== 'string' || value.length < 10 || value.length > 128) throw new Error('密码长度必须为 10–128 个字符'); }
function validateDeviceId(value) { if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(String(value))) throw new Error('设备 ID 无效'); }
function validateDeviceSecret(value) { if (typeof value !== 'string' || value.length < 32) throw new Error('设备密钥无效'); }
function normalizeDeviceName(value) { const result = String(value || '未命名设备').trim().slice(0, 64); return result || '未命名设备'; }
function uniquePairingCode(pairings) { let code; do { code = randomBytes(4).toString('hex').toUpperCase(); } while (pairings.some((pairing) => pairing.code === code)); return code; }

export {
  hashPassword,
  verifyPassword,
  hashSecret,
  secretMatches,
  normalizeUsername,
  validatePassword,
  validateDeviceId,
  validateDeviceSecret,
  normalizeDeviceName,
};
