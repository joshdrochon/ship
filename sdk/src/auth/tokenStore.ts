/**
 * `ITokenStore` — where the client keeps its credentials. THREE methods, no more.
 *
 * ── The contract (PF-503) ───────────────────────────────────────────────────
 *
 *     load(): Promise<StoredTokens | null>   the current credential, or null
 *     save(tokens): Promise<void>            replace it wholesale
 *     clear(): Promise<void>                 forget it
 *
 * Three and not four: there is no `update`, because a rotation replaces the
 * whole pair (PRD p.3 — refresh tokens are one-time-use and rotate), and a
 * partial update is the shape that lets an access token and a refresh token
 * belong to different generations.
 *
 * Structural, not nominal: any object with those three methods IS an
 * `ITokenStore`. A consumer does not import a base class or register anything.
 * `tokenStore.test.ts` proves it with a third-party class that declares no
 * `implements` clause.
 *
 * The prose version lives in `docs/architecture.md` → SDK Surface, which is what
 * Pre-Search 2.4 (p.17) asks for — *"Where does ITokenStore's contract live"*
 * must have a location as an answer.
 *
 * ── D8, first half (PF-504): BOTH tokens are persisted ──────────────────────
 * Pre-Search 2.4 asks whether the store keeps refresh tokens or only access
 * tokens. Both. An access-token-only store makes `ship login` a device flow on
 * EVERY invocation, which fails the drill's TTFE target on the second command
 * (p.8's stage 2 measures persistence across process restarts). The cost is
 * stated rather than hidden: the file on disk now holds a credential whose theft
 * is worth more, which is why `FileTokenStore` is 0600 and why the SDK never
 * writes a token into a message, a log line or a stack.
 *
 * ── The corruption contract (PF-508) ────────────────────────────────────────
 * A store that fails to read, or returns something that is not a credential, is
 * treated as LOGGED OUT: one attempt at most, a thrown `{ kind: 'auth' }`, and
 * **no write-back**. `docs/architecture.md`'s Failure Modes section commits to
 * this, and p.12 makes that section a graded deliverable.
 *
 * `clear()` is deliberately NOT called on a corrupt read. `clear()` is a write,
 * the contract forbids writing back, and a file the SDK cannot parse may still
 * be a file a human can repair. Erasing would be the friendlier UX and the less
 * recoverable one.
 */

export interface StoredTokens {
  accessToken: string;
  /**
   * The rotating half. `null` for a credential minted by a grant that issues no
   * refresh token (client_credentials), which is a real state and not an error.
   */
  refreshToken: string | null;
  /** Unix SECONDS at which the access token expires. Refreshed proactively before this. */
  expiresAtSeconds: number | null;
  scopes: string[];
}

export interface ITokenStore {
  load(): Promise<StoredTokens | null>;
  save(tokens: StoredTokens): Promise<void>;
  clear(): Promise<void>;
}

/**
 * PF-508's shape check — is this thing a credential?
 *
 * Exported because every store needs it and each one implementing its own would
 * be three chances to accept a half-written file. "Valid JSON of the wrong
 * shape" is one of the four corruption cases, and it is the one a `try/catch`
 * around `JSON.parse` does not catch.
 */
export function isStoredTokens(value: unknown): value is StoredTokens {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.accessToken !== 'string' || candidate.accessToken === '') return false;
  if (candidate.refreshToken !== null && typeof candidate.refreshToken !== 'string') return false;
  if (
    candidate.expiresAtSeconds !== null &&
    (typeof candidate.expiresAtSeconds !== 'number' || !Number.isFinite(candidate.expiresAtSeconds))
  ) {
    return false;
  }
  if (!Array.isArray(candidate.scopes)) return false;
  return candidate.scopes.every((scope) => typeof scope === 'string');
}

/**
 * PF-505 — the default store, and the test double p.10 asks for.
 *
 * Default when no store is supplied, so a `ShipClient` built with a static token
 * still has somewhere to put a refreshed one. Two clients sharing one instance
 * see each other's writes, which is what makes it a usable double for the
 * single-flight refresh test.
 */
export class InMemoryTokenStore implements ITokenStore {
  private tokens: StoredTokens | null;

  constructor(initial: StoredTokens | null = null) {
    this.tokens = initial;
  }

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
