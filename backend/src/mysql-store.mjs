import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import {
  hashPassword,
  verifyPassword,
  hashSecret,
  secretMatches,
  normalizeUsername,
  validatePassword,
  validateDeviceId,
  validateDeviceSecret,
  normalizeDeviceName,
} from './store.mjs';

export class MySqlRelayStore {
  constructor(pool) {
    this.pool = pool;
  }

  async createUser(username, password) {
    const normalized = normalizeUsername(username);
    validatePassword(password);
    const user = { id: randomUUID(), username: normalized, passwordHash: hashPassword(password), createdAt: Date.now() };
    try {
      await this.pool.execute(
        'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)',
        [user.id, user.username, user.passwordHash, user.createdAt],
      );
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') throw new Error('账号已存在');
      throw error;
    }
    return publicUser(user);
  }

  async authenticate(username, password) {
    const normalized = normalizeUsername(username);
    const [rows] = await this.pool.execute(
      'SELECT id, username, password_hash AS passwordHash FROM users WHERE username = ? LIMIT 1',
      [normalized],
    );
    const user = rows[0];
    return user && verifyPassword(password, user.passwordHash) ? publicUser(user) : undefined;
  }

  async changePassword(userId, currentPassword, nextPassword) {
    const [rows] = await this.pool.execute('SELECT password_hash AS passwordHash FROM users WHERE id = ? LIMIT 1', [userId]);
    const user = rows[0];
    if (!user || !verifyPassword(currentPassword, user.passwordHash)) throw new Error('当前密码错误');
    validatePassword(nextPassword);
    await this.pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(nextPassword), userId]);
  }

  async resetPassword(username, nextPassword) {
    const normalized = normalizeUsername(username);
    validatePassword(nextPassword);
    const [result] = await this.pool.execute(
      'UPDATE users SET password_hash = ? WHERE username = ?',
      [hashPassword(nextPassword), normalized],
    );
    if (!result.affectedRows) throw new Error('账号不存在');
    const [rows] = await this.pool.execute('SELECT id, username FROM users WHERE username = ? LIMIT 1', [normalized]);
    return publicUser(rows[0]);
  }

  async createPairing({ deviceId, name, secret }) {
    validateDeviceId(deviceId);
    validateDeviceSecret(secret);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [devices] = await connection.execute('SELECT id, secret_hash AS secretHash FROM devices WHERE id = ? LIMIT 1 FOR UPDATE', [deviceId]);
      const existingDevice = devices[0];
      if (existingDevice && !secretMatches(secret, existingDevice.secretHash)) throw new Error('设备身份验证失败');
      await connection.execute('DELETE FROM pairings WHERE expires_at <= ? OR device_id = ?', [Date.now(), deviceId]);
      let code;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        code = randomBytes(4).toString('hex').toUpperCase();
        const [matches] = await connection.execute('SELECT code FROM pairings WHERE code = ? LIMIT 1', [code]);
        if (!matches.length) break;
      }
      const pairing = {
        code, deviceId, name: normalizeDeviceName(name),
        secretHash: existingDevice?.secretHash || hashSecret(secret), expiresAt: Date.now() + 10 * 60_000,
      };
      await connection.execute(
        'INSERT INTO pairings (code, device_id, name, secret_hash, expires_at) VALUES (?, ?, ?, ?, ?)',
        [pairing.code, pairing.deviceId, pairing.name, pairing.secretHash, pairing.expiresAt],
      );
      await connection.commit();
      return { code: pairing.code, expiresAt: pairing.expiresAt };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async claimPairing(userId, code) {
    const normalizedCode = String(code).replace(/\s+/g, '').toUpperCase();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute('DELETE FROM pairings WHERE expires_at <= ?', [Date.now()]);
      const [rows] = await connection.execute(
        'SELECT code, device_id AS deviceId, name, secret_hash AS secretHash FROM pairings WHERE code = ? LIMIT 1 FOR UPDATE',
        [normalizedCode],
      );
      const pairing = rows[0];
      if (!pairing) throw new Error('配对二维码无效或已经过期');
      const [existingRows] = await connection.execute(
        'SELECT id, user_id AS userId, name, secret_hash AS secretHash, created_at AS createdAt, last_seen_at AS lastSeenAt FROM devices WHERE id = ? LIMIT 1 FOR UPDATE',
        [pairing.deviceId],
      );
      const existingDevice = existingRows[0];
      if (existingDevice) {
        if (existingDevice.userId !== userId) throw new Error('设备已经绑定到其他账号');
        if (existingDevice.secretHash !== pairing.secretHash) throw new Error('设备身份验证失败');
        existingDevice.name = pairing.name;
        await connection.execute('UPDATE devices SET name = ? WHERE id = ?', [pairing.name, pairing.deviceId]);
        await connection.execute('DELETE FROM pairings WHERE code = ?', [normalizedCode]);
        await connection.commit();
        return publicDevice(existingDevice, false);
      }
      const device = {
        id: pairing.deviceId, userId, name: pairing.name, secretHash: pairing.secretHash,
        createdAt: Date.now(), lastSeenAt: null,
      };
      await connection.execute(
        'INSERT INTO devices (id, user_id, name, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, NULL)',
        [device.id, device.userId, device.name, device.secretHash, device.createdAt],
      );
      await connection.execute('DELETE FROM pairings WHERE code = ?', [normalizedCode]);
      await connection.commit();
      return publicDevice(device, false);
    } catch (error) {
      await connection.rollback();
      if (error?.code === 'ER_DUP_ENTRY') throw new Error('设备已经绑定');
      throw error;
    } finally {
      connection.release();
    }
  }

  async importDevice(userId, { deviceId, name, secret }) {
    validateDeviceId(deviceId);
    validateDeviceSecret(secret);
    const device = {
      id: deviceId, userId, name: normalizeDeviceName(name), secretHash: hashSecret(secret),
      createdAt: Date.now(), lastSeenAt: null,
    };
    try {
      await this.pool.execute(
        'INSERT INTO devices (id, user_id, name, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, NULL)',
        [device.id, device.userId, device.name, device.secretHash, device.createdAt],
      );
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') throw new Error('设备 ID 已存在');
      throw error;
    }
    return publicDevice(device, false);
  }

  async verifyDevice(deviceId, secret) {
    const [rows] = await this.pool.execute(
      'SELECT id, user_id AS userId, name, secret_hash AS secretHash, created_at AS createdAt, last_seen_at AS lastSeenAt FROM devices WHERE id = ? LIMIT 1',
      [deviceId],
    );
    const device = rows[0];
    if (!device || !secretMatches(secret, device.secretHash)) return undefined;
    device.lastSeenAt = Date.now();
    await this.pool.execute('UPDATE devices SET last_seen_at = ? WHERE id = ?', [device.lastSeenAt, device.id]);
    return publicDevice(device, true);
  }

  async userOwnsDevice(userId, deviceId) {
    const [rows] = await this.pool.execute('SELECT id FROM devices WHERE user_id = ? AND id = ? LIMIT 1', [userId, deviceId]);
    return rows.length > 0;
  }

  async listDevices(userId, onlineIds = new Set()) {
    const [rows] = await this.pool.execute(
      'SELECT id, name, created_at AS createdAt, last_seen_at AS lastSeenAt FROM devices WHERE user_id = ? ORDER BY created_at',
      [userId],
    );
    return rows.map((device) => publicDevice(device, onlineIds.has(device.id)));
  }

  async revokeDevice(userId, deviceId) {
    const [result] = await this.pool.execute('DELETE FROM devices WHERE user_id = ? AND id = ?', [userId, deviceId]);
    if (!result.affectedRows) throw new Error('设备不存在');
  }

  async userById(userId) {
    const [rows] = await this.pool.execute('SELECT id, username FROM users WHERE id = ? LIMIT 1', [userId]);
    return rows[0] ? publicUser(rows[0]) : undefined;
  }
}

export class MySqlSessionStore {
  constructor(pool) {
    this.pool = pool;
  }

  async get(key) {
    const [rows] = await this.pool.execute(
      'SELECT user_id AS userId, expires_at AS expiresAt FROM login_sessions WHERE token_hash = ? LIMIT 1',
      [key],
    );
    const session = rows[0];
    if (!session) return undefined;
    if (Number(session.expiresAt) <= Date.now()) {
      await this.delete(key);
      return undefined;
    }
    return { userId: session.userId, expiresAt: Number(session.expiresAt) };
  }

  async set(key, session) {
    await this.pool.execute(
      'INSERT INTO login_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), expires_at = VALUES(expires_at)',
      [key, session.userId, session.expiresAt],
    );
    return this;
  }

  async delete(key) {
    const [result] = await this.pool.execute('DELETE FROM login_sessions WHERE token_hash = ?', [key]);
    return result.affectedRows > 0;
  }
}

export async function createMySqlStorage(options) {
  const pool = mysql.createPool({
    host: options.host,
    port: options.port,
    user: options.user,
    password: options.password,
    database: options.database,
    charset: 'utf8mb4',
    timezone: 'Z',
    waitForConnections: true,
    connectionLimit: 8,
    enableKeepAlive: true,
  });
  await initializeSchema(pool);
  await migrateJsonState(pool, options.stateFile, options.sessionsFile);
  return { pool, store: new MySqlRelayStore(pool), sessions: new MySqlSessionStore(pool) };
}

async function initializeSchema(pool) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(36) PRIMARY KEY, username VARCHAR(64) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL, created_at BIGINT UNSIGNED NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS devices (
      id VARCHAR(36) PRIMARY KEY, user_id VARCHAR(36) NOT NULL, name VARCHAR(64) NOT NULL,
      secret_hash VARCHAR(128) NOT NULL, created_at BIGINT UNSIGNED NOT NULL,
      last_seen_at BIGINT UNSIGNED NULL, INDEX devices_user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS pairings (
      code VARCHAR(16) PRIMARY KEY, device_id VARCHAR(36) NOT NULL UNIQUE, name VARCHAR(64) NOT NULL,
      secret_hash VARCHAR(128) NOT NULL, expires_at BIGINT UNSIGNED NOT NULL,
      INDEX pairings_expires_at (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS login_sessions (
      token_hash VARCHAR(64) PRIMARY KEY, user_id VARCHAR(36) NOT NULL,
      expires_at BIGINT UNSIGNED NOT NULL, INDEX sessions_expires_at (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS migrations (
      name VARCHAR(128) PRIMARY KEY, applied_at BIGINT UNSIGNED NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ];
  for (const statement of statements) await pool.query(statement);
  await pool.execute('DELETE FROM pairings WHERE expires_at <= ?', [Date.now()]);
  await pool.execute('DELETE FROM login_sessions WHERE expires_at <= ?', [Date.now()]);
}

async function migrateJsonState(pool, stateFile, sessionsFile) {
  const [migrationRows] = await pool.execute('SELECT name FROM migrations WHERE name = ? LIMIT 1', ['json-v1']);
  if (migrationRows.length) return;
  const state = await readJsonFile(stateFile, { users: [], devices: [], pairings: [] });
  const sessions = await readJsonFile(sessionsFile, []);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const user of state.users || []) {
      await connection.execute(
        'INSERT IGNORE INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)',
        [user.id, user.username, user.passwordHash, user.createdAt],
      );
    }
    for (const device of state.devices || []) {
      await connection.execute(
        'INSERT IGNORE INTO devices (id, user_id, name, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
        [device.id, device.userId, device.name, device.secretHash, device.createdAt, device.lastSeenAt],
      );
    }
    for (const pairing of state.pairings || []) {
      if (pairing.expiresAt <= Date.now()) continue;
      await connection.execute(
        'INSERT IGNORE INTO pairings (code, device_id, name, secret_hash, expires_at) VALUES (?, ?, ?, ?, ?)',
        [pairing.code, pairing.deviceId, pairing.name, pairing.secretHash, pairing.expiresAt],
      );
    }
    for (const entry of Array.isArray(sessions) ? sessions : []) {
      const [tokenHash, session] = Array.isArray(entry) ? entry : [];
      if (!tokenHash || !session?.userId || session.expiresAt <= Date.now()) continue;
      await connection.execute(
        'INSERT IGNORE INTO login_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
        [tokenHash, session.userId, session.expiresAt],
      );
    }
    await connection.execute('INSERT INTO migrations (name, applied_at) VALUES (?, ?)', ['json-v1', Date.now()]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function publicUser(user) {
  return { id: user.id, username: user.username };
}

function publicDevice(device, online) {
  return {
    id: device.id,
    name: device.name,
    createdAt: Number(device.createdAt),
    lastSeenAt: device.lastSeenAt === null ? null : Number(device.lastSeenAt),
    online,
  };
}
