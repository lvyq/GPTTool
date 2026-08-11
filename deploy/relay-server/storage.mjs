import path from 'node:path';
import { RelayStore } from './store.mjs';
import { PersistentSessionStore } from './session-store.mjs';
import { createMySqlStorage } from './mysql-store.mjs';
import { createPostgresStorage } from './postgres-store.mjs';

export async function createStorage() {
  const stateFile = process.env.ASTERGATE_DATABASE || '/var/lib/astergate-relay/state.json';
  const sessionsFile = process.env.ASTERGATE_SESSIONS || path.join(path.dirname(stateFile), 'sessions.json');
  const postgresHost = process.env.ASTERGATE_POSTGRES_HOST?.trim();
  const mysqlHost = process.env.ASTERGATE_MYSQL_HOST?.trim();
  if (postgresHost) {
    const result = await createPostgresStorage({
      host: postgresHost,
      port: Number(process.env.ASTERGATE_POSTGRES_PORT || 5432),
      user: requiredEnv('ASTERGATE_POSTGRES_USER'),
      password: requiredEnv('ASTERGATE_POSTGRES_PASSWORD'),
      database: requiredEnv('ASTERGATE_POSTGRES_DATABASE'),
      stateFile,
      sessionsFile,
      mysql: mysqlHost ? {
        host: mysqlHost,
        port: Number(process.env.ASTERGATE_MYSQL_PORT || 3306),
        user: requiredEnv('ASTERGATE_MYSQL_USER'),
        password: requiredEnv('ASTERGATE_MYSQL_PASSWORD'),
        database: requiredEnv('ASTERGATE_MYSQL_DATABASE'),
      } : undefined,
    });
    return { ...result, backend: 'postgres' };
  }
  if (!mysqlHost) {
    return {
      store: new RelayStore(stateFile),
      sessions: new PersistentSessionStore(sessionsFile),
      backend: 'json',
    };
  }
  const result = await createMySqlStorage({
    host: mysqlHost,
    port: Number(process.env.ASTERGATE_MYSQL_PORT || 3306),
    user: requiredEnv('ASTERGATE_MYSQL_USER'),
    password: requiredEnv('ASTERGATE_MYSQL_PASSWORD'),
    database: requiredEnv('ASTERGATE_MYSQL_DATABASE'),
    stateFile,
    sessionsFile,
  });
  return { ...result, backend: 'mysql' };
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
