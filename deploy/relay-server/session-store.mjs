import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class PersistentSessionStore {
  #file;
  #sessions = new Map();

  constructor(file) {
    this.#file = file;
    this.#load();
  }

  get(key) {
    const session = this.#sessions.get(key);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.delete(key);
      return undefined;
    }
    return session;
  }

  set(key, session) {
    this.#sessions.set(key, session);
    this.#persist();
    return this;
  }

  delete(key) {
    const deleted = this.#sessions.delete(key);
    if (deleted) this.#persist();
    return deleted;
  }

  #load() {
    if (!existsSync(this.#file)) return;
    try {
      const entries = JSON.parse(readFileSync(this.#file, 'utf8'));
      const now = Date.now();
      for (const [key, session] of Array.isArray(entries) ? entries : []) {
        if (
          typeof key === 'string'
          && typeof session?.userId === 'string'
          && Number.isFinite(session?.expiresAt)
          && session.expiresAt > now
        ) this.#sessions.set(key, session);
      }
      this.#persist();
    } catch (error) {
      console.warn(`Unable to restore relay sessions: ${error.message}`);
    }
  }

  #persist() {
    const directory = path.dirname(this.#file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryFile = `${this.#file}.tmp`;
    writeFileSync(temporaryFile, JSON.stringify([...this.#sessions]), { mode: 0o600 });
    chmodSync(temporaryFile, 0o600);
    renameSync(temporaryFile, this.#file);
  }
}
