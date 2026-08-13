import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
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

const { Pool } = pg;

export class PostgresRelayStore {
  constructor(pool) { this.pool = pool; }

  async cdpRulesFor(version, platform) {
    const { rows } = await this.pool.query(
      `SELECT payload FROM cdp_rule_sets
       WHERE enabled = TRUE AND (platform = 'all' OR platform = $1)
       ORDER BY priority DESC, updated_at DESC`,
      [platform || 'all'],
    );
    return rows.map((row) => row.payload).find((rules) => matchesCdpVersion(rules, version));
  }

  async putCdpRules(rules, platform = 'all', priority = 0) {
    await this.pool.query(
      `INSERT INTO cdp_rule_sets (id, platform, payload, enabled, priority, updated_at)
       VALUES ($1, $2, $3::jsonb, TRUE, $4, $5)
       ON CONFLICT (id) DO UPDATE SET platform = EXCLUDED.platform, payload = EXCLUDED.payload,
       enabled = TRUE, priority = EXCLUDED.priority, updated_at = EXCLUDED.updated_at`,
      [rules.id, platform || 'all', JSON.stringify(rules), Number(priority) || 0, Date.now()],
    );
    return rules;
  }

  async createUser(username, password) {
    const normalized = normalizeUsername(username);
    validatePassword(password);
    const user = { id: randomUUID(), username: normalized, passwordHash: hashPassword(password), createdAt: Date.now() };
    try {
      await this.pool.query(
        'INSERT INTO users (id, username, password_hash, created_at) VALUES ($1, $2, $3, $4)',
        [user.id, user.username, user.passwordHash, user.createdAt],
      );
    } catch (error) {
      if (error?.code === '23505') throw new Error('账号已存在');
      throw error;
    }
    return publicUser(user);
  }

  async authenticate(username, password) {
    const normalized = normalizeUsername(username);
    const { rows } = await this.pool.query(
      'SELECT id, username, password_hash AS "passwordHash" FROM users WHERE username = $1 LIMIT 1',
      [normalized],
    );
    const user = rows[0];
    return user && verifyPassword(password, user.passwordHash) ? publicUser(user) : undefined;
  }

  async changePassword(userId, currentPassword, nextPassword) {
    const { rows } = await this.pool.query('SELECT password_hash AS "passwordHash" FROM users WHERE id = $1 LIMIT 1', [userId]);
    const user = rows[0];
    if (!user || !verifyPassword(currentPassword, user.passwordHash)) throw new Error('当前密码错误');
    validatePassword(nextPassword);
    await this.pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(nextPassword), userId]);
  }

  async resetPassword(username, nextPassword) {
    const normalized = normalizeUsername(username);
    validatePassword(nextPassword);
    const { rows } = await this.pool.query(
      'UPDATE users SET password_hash = $1 WHERE username = $2 RETURNING id, username',
      [hashPassword(nextPassword), normalized],
    );
    if (!rows.length) throw new Error('账号不存在');
    return publicUser(rows[0]);
  }

  async createPairing({ deviceId, name, secret }) {
    validateDeviceId(deviceId);
    validateDeviceSecret(secret);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const devices = await client.query('SELECT id, secret_hash AS "secretHash" FROM devices WHERE id = $1 LIMIT 1 FOR UPDATE', [deviceId]);
      const existingDevice = devices.rows[0];
      if (existingDevice && !secretMatches(secret, existingDevice.secretHash)) throw new Error('设备身份验证失败');
      await client.query('DELETE FROM pairings WHERE expires_at <= $1 OR device_id = $2', [Date.now(), deviceId]);
      let code;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        code = randomBytes(4).toString('hex').toUpperCase();
        const matches = await client.query('SELECT code FROM pairings WHERE code = $1 LIMIT 1', [code]);
        if (!matches.rows.length) break;
      }
      const pairing = {
        code, deviceId, name: normalizeDeviceName(name),
        secretHash: existingDevice?.secretHash || hashSecret(secret), expiresAt: Date.now() + 10 * 60_000,
      };
      await client.query(
        'INSERT INTO pairings (code, device_id, name, secret_hash, expires_at) VALUES ($1, $2, $3, $4, $5)',
        [pairing.code, pairing.deviceId, pairing.name, pairing.secretHash, pairing.expiresAt],
      );
      await client.query('COMMIT');
      return { code: pairing.code, expiresAt: pairing.expiresAt };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async claimPairing(userId, code) {
    const normalizedCode = String(code).replace(/\s+/g, '').toUpperCase();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM pairings WHERE expires_at <= $1', [Date.now()]);
      const { rows } = await client.query(
        'SELECT code, device_id AS "deviceId", name, secret_hash AS "secretHash" FROM pairings WHERE code = $1 LIMIT 1 FOR UPDATE',
        [normalizedCode],
      );
      const pairing = rows[0];
      if (!pairing) throw new Error('配对二维码无效或已经过期');
      const existingResult = await client.query(
        'SELECT id, user_id AS "userId", name, secret_hash AS "secretHash", created_at AS "createdAt", last_seen_at AS "lastSeenAt" FROM devices WHERE id = $1 LIMIT 1 FOR UPDATE',
        [pairing.deviceId],
      );
      const existingDevice = existingResult.rows[0];
      if (existingDevice) {
        if (existingDevice.userId !== userId) throw new Error('设备已经绑定到其他账号');
        if (existingDevice.secretHash !== pairing.secretHash) throw new Error('设备身份验证失败');
        existingDevice.name = pairing.name;
        await client.query('UPDATE devices SET name = $1 WHERE id = $2', [pairing.name, pairing.deviceId]);
        await client.query('DELETE FROM pairings WHERE code = $1', [normalizedCode]);
        await client.query('COMMIT');
        return publicDevice(existingDevice, false);
      }
      const device = {
        id: pairing.deviceId, userId, name: pairing.name, secretHash: pairing.secretHash,
        createdAt: Date.now(), lastSeenAt: null,
      };
      await client.query(
        'INSERT INTO devices (id, user_id, name, secret_hash, created_at, last_seen_at) VALUES ($1, $2, $3, $4, $5, NULL)',
        [device.id, device.userId, device.name, device.secretHash, device.createdAt],
      );
      await client.query('DELETE FROM pairings WHERE code = $1', [normalizedCode]);
      await client.query('COMMIT');
      return publicDevice(device, false);
    } catch (error) {
      await client.query('ROLLBACK');
      if (error?.code === '23505') throw new Error('设备已经绑定');
      throw error;
    } finally {
      client.release();
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
      await this.pool.query(
        'INSERT INTO devices (id, user_id, name, secret_hash, created_at, last_seen_at) VALUES ($1, $2, $3, $4, $5, NULL)',
        [device.id, device.userId, device.name, device.secretHash, device.createdAt],
      );
    } catch (error) {
      if (error?.code === '23505') throw new Error('设备 ID 已存在');
      throw error;
    }
    return publicDevice(device, false);
  }

  async verifyDevice(deviceId, secret) {
    const { rows } = await this.pool.query(
      'SELECT id, user_id AS "userId", name, secret_hash AS "secretHash", created_at AS "createdAt", last_seen_at AS "lastSeenAt" FROM devices WHERE id = $1 LIMIT 1',
      [deviceId],
    );
    const device = rows[0];
    if (!device || !secretMatches(secret, device.secretHash)) return undefined;
    device.lastSeenAt = Date.now();
    await this.pool.query('UPDATE devices SET last_seen_at = $1 WHERE id = $2', [device.lastSeenAt, device.id]);
    return publicDevice(device, true);
  }

  async userOwnsDevice(userId, deviceId) {
    const { rows } = await this.pool.query('SELECT id FROM devices WHERE user_id = $1 AND id = $2 LIMIT 1', [userId, deviceId]);
    return rows.length > 0;
  }

  async listDevices(userId, onlineIds = new Set()) {
    const { rows } = await this.pool.query(
      'SELECT id, name, created_at AS "createdAt", last_seen_at AS "lastSeenAt" FROM devices WHERE user_id = $1 ORDER BY created_at',
      [userId],
    );
    return rows.map((device) => publicDevice(device, onlineIds.has(device.id)));
  }

  async revokeDevice(userId, deviceId) {
    const result = await this.pool.query('DELETE FROM devices WHERE user_id = $1 AND id = $2', [userId, deviceId]);
    if (!result.rowCount) throw new Error('设备不存在');
  }

  async userById(userId) {
    const { rows } = await this.pool.query('SELECT id, username FROM users WHERE id = $1 LIMIT 1', [userId]);
    return rows[0] ? publicUser(rows[0]) : undefined;
  }

  async putDeviceRecord(deviceId, kind, key, value, updatedAt = Date.now()) {
    validateRecord(kind, key, value);
    await this.pool.query(
      `INSERT INTO device_records (device_id, kind, record_key, payload, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (device_id, kind, record_key)
       DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
      [deviceId, kind, key, JSON.stringify(value), updatedAt],
    );
  }

  async deleteDeviceRecord(deviceId, kind, key) {
    await this.pool.query(
      'DELETE FROM device_records WHERE device_id = $1 AND kind = $2 AND record_key = $3',
      [deviceId, kind, key],
    );
  }

  async listDeviceRecords(deviceId, kinds = []) {
    const parameters = [deviceId];
    const filter = kinds.length
      ? ` AND kind = ANY($${parameters.push(kinds)}::text[])`
      : '';
    const { rows } = await this.pool.query(
      `SELECT kind, record_key AS "key", payload AS value, updated_at AS "updatedAt"
       FROM device_records WHERE device_id = $1${filter} ORDER BY updated_at`,
      parameters,
    );
    return rows.map((row) => ({ ...row, updatedAt: Number(row.updatedAt) }));
  }
}

export class PostgresSessionStore {
  constructor(pool) { this.pool = pool; }

  async get(key) {
    const { rows } = await this.pool.query(
      'SELECT user_id AS "userId", expires_at AS "expiresAt" FROM login_sessions WHERE token_hash = $1 LIMIT 1',
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
    await this.pool.query(
      `INSERT INTO login_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (token_hash) DO UPDATE SET user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at`,
      [key, session.userId, session.expiresAt],
    );
    return this;
  }

  async delete(key) {
    const result = await this.pool.query('DELETE FROM login_sessions WHERE token_hash = $1', [key]);
    return Boolean(result.rowCount);
  }
}

export async function createPostgresStorage(options) {
  const pool = new Pool({
    host: options.host,
    port: options.port,
    user: options.user,
    password: options.password,
    database: options.database,
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'gpttool-relay',
  });
  await initializeSchema(pool);
  await migrateJsonState(pool, options.stateFile, options.sessionsFile);
  if (options.mysql?.host) await migrateMySqlState(pool, options.mysql);
  return { pool, store: new PostgresRelayStore(pool), sessions: new PostgresSessionStore(pool) };
}

async function initializeSchema(pool) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(36) PRIMARY KEY, username VARCHAR(64) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL, created_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS devices (
      id VARCHAR(36) PRIMARY KEY, user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(64) NOT NULL, secret_hash VARCHAR(128) NOT NULL,
      created_at BIGINT NOT NULL, last_seen_at BIGINT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS devices_user_id ON devices(user_id)',
    `CREATE TABLE IF NOT EXISTS pairings (
      code VARCHAR(16) PRIMARY KEY, device_id VARCHAR(36) NOT NULL UNIQUE,
      name VARCHAR(64) NOT NULL, secret_hash VARCHAR(128) NOT NULL, expires_at BIGINT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS pairings_expires_at ON pairings(expires_at)',
    `CREATE TABLE IF NOT EXISTS login_sessions (
      token_hash VARCHAR(64) PRIMARY KEY, user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at BIGINT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS sessions_expires_at ON login_sessions(expires_at)',
    `CREATE TABLE IF NOT EXISTS migrations (
      name VARCHAR(128) PRIMARY KEY, applied_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS device_records (
      device_id VARCHAR(36) NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      kind VARCHAR(32) NOT NULL, record_key VARCHAR(160) NOT NULL,
      payload JSONB NOT NULL, updated_at BIGINT NOT NULL,
      PRIMARY KEY (device_id, kind, record_key)
    )`,
    'CREATE INDEX IF NOT EXISTS device_records_updated_at ON device_records(device_id, updated_at DESC)',
    `CREATE TABLE IF NOT EXISTS cdp_rule_sets (
      id VARCHAR(128) PRIMARY KEY, platform VARCHAR(32) NOT NULL DEFAULT 'all', payload JSONB NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE, priority INTEGER NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS cdp_rule_sets_lookup ON cdp_rule_sets(enabled, platform, priority DESC, updated_at DESC)',
  ];
  for (const statement of statements) await pool.query(statement);
  await pool.query('DELETE FROM pairings WHERE expires_at <= $1', [Date.now()]);
  await pool.query('DELETE FROM login_sessions WHERE expires_at <= $1', [Date.now()]);
}

function matchesCdpVersion(rules, version) {
  if (!rules || rules.schemaVersion !== 1 || !rules.selectors) return false;
  if (!version) return !rules.exactOfficialVersion;
  if (rules.exactOfficialVersion && compareCdpVersions(version, rules.exactOfficialVersion) !== 0) return false;
  if (rules.minOfficialVersion && compareCdpVersions(version, rules.minOfficialVersion) < 0) return false;
  if (rules.maxOfficialVersion && compareCdpVersions(version, rules.maxOfficialVersion) > 0) return false;
  return true;
}

function compareCdpVersions(left, right) {
  const a = String(left).split(/[^0-9]+/).filter(Boolean).map(Number);
  const b = String(right).split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta) return delta > 0 ? 1 : -1;
  }
  return 0;
}

async function migrateJsonState(pool, stateFile, sessionsFile) {
  if (await migrationApplied(pool, 'json-v1')) return;
  const state = await readJsonFile(stateFile, { users: [], devices: [], pairings: [] });
  const sessions = await readJsonFile(sessionsFile, []);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertState(client, state, sessions);
    await client.query(
      'INSERT INTO migrations (name, applied_at) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
      ['json-v1', Date.now()],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function migrateMySqlState(pool, options) {
  if (await migrationApplied(pool, 'mysql-v1')) return;
  const source = mysql.createPool({
    host: options.host,
    port: options.port || 3306,
    user: options.user,
    password: options.password,
    database: options.database,
    connectionLimit: 2,
  });
  try {
    const [[users], [devices], [pairings], [sessions]] = await Promise.all([
      source.query('SELECT id, username, password_hash AS passwordHash, created_at AS createdAt FROM users'),
      source.query('SELECT id, user_id AS userId, name, secret_hash AS secretHash, created_at AS createdAt, last_seen_at AS lastSeenAt FROM devices'),
      source.query('SELECT code, device_id AS deviceId, name, secret_hash AS secretHash, expires_at AS expiresAt FROM pairings'),
      source.query('SELECT token_hash AS tokenHash, user_id AS userId, expires_at AS expiresAt FROM login_sessions'),
    ]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await insertState(client, { users, devices, pairings }, sessions.map((entry) => [entry.tokenHash, entry]));
      await client.query(
        'INSERT INTO migrations (name, applied_at) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
        ['mysql-v1', Date.now()],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await source.end();
  }
}

async function insertState(client, state, sessions) {
  for (const user of state.users || []) {
    await client.query(
      `INSERT INTO users (id, username, password_hash, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [user.id, user.username, user.passwordHash, user.createdAt],
    );
  }
  for (const device of state.devices || []) {
    await client.query(
      `INSERT INTO devices (id, user_id, name, secret_hash, created_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [device.id, device.userId, device.name, device.secretHash, device.createdAt, device.lastSeenAt],
    );
  }
  for (const pairing of state.pairings || []) {
    if (Number(pairing.expiresAt) <= Date.now()) continue;
    await client.query(
      `INSERT INTO pairings (code, device_id, name, secret_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (code) DO NOTHING`,
      [pairing.code, pairing.deviceId, pairing.name, pairing.secretHash, pairing.expiresAt],
    );
  }
  for (const entry of Array.isArray(sessions) ? sessions : []) {
    const [tokenHash, session] = Array.isArray(entry) ? entry : [];
    if (!tokenHash || !session?.userId || Number(session.expiresAt) <= Date.now()) continue;
    await client.query(
      `INSERT INTO login_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (token_hash) DO NOTHING`,
      [tokenHash, session.userId, session.expiresAt],
    );
  }
}

async function migrationApplied(pool, name) {
  const { rows } = await pool.query('SELECT name FROM migrations WHERE name = $1 LIMIT 1', [name]);
  return rows.length > 0;
}

async function readJsonFile(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

function validateRecord(kind, key, value) {
  if (!/^[a-z][a-z0-9_.-]{0,31}$/i.test(String(kind))) throw new Error('Invalid device record kind');
  if (!key || String(key).length > 160) throw new Error('Invalid device record key');
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 4 * 1024 * 1024) throw new Error('Device record is too large');
}

function publicUser(user) { return { id: user.id, username: user.username }; }

function publicDevice(device, online) {
  return {
    id: device.id,
    name: device.name,
    createdAt: Number(device.createdAt),
    lastSeenAt: device.lastSeenAt === null ? null : Number(device.lastSeenAt),
    online,
  };
}
