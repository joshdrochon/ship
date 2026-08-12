/**
 * ITokenStore — where the client keeps its credentials. Pluggable so the CLI
 * persists to disk, tests stay in memory, and a browser build can adapt.
 *
 * Corruption contract (architecture.md Failure Modes): a store that fails to
 * read or returns garbage is treated as LOGGED OUT — surface { kind: 'auth' },
 * never retry-loop, never write partial credentials back.
 */

export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Unix seconds; refresh proactively ~60s before this. */
  expiresAtSeconds: number | null;
  scopes: string[];
}

export interface ITokenStore {
  load(): Promise<StoredTokens | null>;
  save(tokens: StoredTokens): Promise<void>;
  clear(): Promise<void>;
}

export class InMemoryTokenStore implements ITokenStore {
  private tokens: StoredTokens | null = null;

  load(): Promise<StoredTokens | null> {
    return Promise.resolve(this.tokens);
  }
  save(tokens: StoredTokens): Promise<void> {
    this.tokens = tokens;
    return Promise.resolve();
  }
  clear(): Promise<void> {
    this.tokens = null;
    return Promise.resolve();
  }
}

// TODO(josh): FileTokenStore (~/.ship/credentials.json, 0600, corrupt file →
// null + clear). The CLI's `ship login` writes through this.
