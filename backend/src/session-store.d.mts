export interface RelaySession {
  userId: string;
  expiresAt: number;
}

export class PersistentSessionStore {
  constructor(file: string);
  get(key: string): RelaySession | undefined;
  set(key: string, session: RelaySession): this;
  delete(key: string): boolean;
}
