/**
 * The authorization code: generation, hashing, TTL, and the repository seam.
 * PF-087 / PF-086 (lane L04, slice S1).
 *
 * ---------------------------------------------------------------------------
 * THE CODE IS A CREDENTIAL, AND IS TREATED LIKE ONE.
 * ---------------------------------------------------------------------------
 * Three properties, each of which is asserted rather than asserted-in-a-comment:
 *
 *   high-entropy   32 bytes of `crypto.randomBytes`, base64url. A guessable code
 *                  is a full account takeover against any app whose redirect_uri
 *                  an attacker can observe.
 *   stored hashed  the row holds `sha256(code)` and never the code. Same
 *                  discipline `tokens.ts` applies to access tokens and D1
 *                  applies to `client_secret`, for the same reason: a database
 *                  read must not yield a redeemable credential.
 *   short-lived    60 seconds. See the constant.
 *
 * ---------------------------------------------------------------------------
 * NO SECOND HASH SITE.
 * ---------------------------------------------------------------------------
 * `hashAuthorizationCode` delegates to L06's `hashToken` rather than calling
 * `createHash('sha256')` again. `tokens.ts` carries a fitness test asserting
 * there is no second `createHash('sha256')` under `platform/oauth/`, and this
 * module deliberately keeps that true — one hashing function for every opaque
 * credential this surface issues means one place to change if the algorithm ever
 * moves, and no chance of the two drifting to different encodings.
 *
 * ---------------------------------------------------------------------------
 * WHY A REPOSITORY AND NOT SQL IN THE HANDLER.
 * ---------------------------------------------------------------------------
 * Identical reasoning to `ITokenRepo` (PF-154) and `IOAuthAppRepo` (PF-037): no
 * Express type and no `pg` type appears in any signature in this file, so the
 * authorize handler, the token exchange and the sweeper are all unit-testable in
 * a bare Node context. `InMemoryAuthCodeRepo` and `PgAuthCodeRepo` are a Liskov
 * pair and the shared contract test in `authCodes.test.ts` is what catches a
 * divergence.
 */
import type { Scope } from '../scopes/scopes.js';
import { hashToken, generateAuthorizationCode } from './tokens.js';

/**
 * Re-exported, not redefined. The generator lives in `tokens.ts` because
 * PF-155's fitness test asserts that file is the only site under
 * `platform/oauth/` drawing random bytes — see the function's own header for why
 * that invariant beat locality.
 */
export { generateAuthorizationCode };

/**
 * The ONE place the code's lifetime is written down (PF-087).
 *
 * RFC 6749 §4.1.2 recommends a maximum of ten minutes and says the code "SHOULD
 * be short-lived". Sixty seconds is generous against what the code actually
 * does: it travels one HTTP redirect from Ship to the client's callback, and the
 * client redeems it immediately in its own handler. Nothing in that path
 * involves a human, so the ten-minute allowance is sized for a flow this is not.
 *
 * The value that would be wrong in the other direction is one that assumed the
 * user's think time — that happens BEFORE the code exists, at the consent
 * screen, and the authorize request itself carries no deadline.
 *
 * PF-087 asserts this constant is the only place the number appears.
 */
export const AUTHORIZATION_CODE_TTL_SECONDS = 60;

/**
 * How long a CONSUMED code is kept before the sweeper deletes it (PF-112).
 *
 * Not the same number as the TTL and it must not be: a consumed row is what
 * makes a replay recognisable as a replay rather than as an unknown code
 * (PF-104), and a replay-driven family revocation is only possible while the row
 * survives. An hour comfortably outlives any legitimate retry and is bounded
 * enough that the table does not become an append-only log.
 */
export const CONSUMED_CODE_RETENTION_SECONDS = 60 * 60;

/**
 * Prefix length for identification in logs and operator queries. Copies
 * `tokenPrefix`'s 8 characters — 48 bits of a 256-bit value, enough to tell two
 * codes apart and far short of enough to redeem one.
 */
const CODE_PREFIX_LENGTH = 8;

/** What the row stores. Never the code itself. */
export function hashAuthorizationCode(raw: string): string {
  return hashToken(raw);
}

/** First 8 characters, in clear, for identification only. */
export function authorizationCodePrefix(raw: string): string {
  return raw.slice(0, CODE_PREFIX_LENGTH);
}

/** A row of `oauth_authorization_codes` (migration 065), in domain terms. */
export interface AuthorizationCodeRecord {
  id: string;
  codeHash: string;
  codePrefix: string;
  appId: string;
  userId: string;
  workspaceId: string;
  /** The exact string used at authorize. Re-checked at exchange (PF-105). */
  redirectUri: string;
  /** The RESOLVED grant (PF-074), never the raw `scope` parameter. */
  scopes: Scope[];
  codeChallenge: string;
  /** Always `'S256'`. The column has a CHECK constraint saying so. */
  codeChallengeMethod: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

/** Everything needed to write one code row. The raw code never reaches here. */
export interface InsertAuthorizationCodeInput {
  codeHash: string;
  codePrefix: string;
  appId: string;
  userId: string;
  workspaceId: string;
  redirectUri: string;
  scopes: Scope[];
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface IAuthCodeRepo {
  insert(input: InsertAuthorizationCodeInput): Promise<AuthorizationCodeRecord>;

  /** The lookup at `/oauth/token`. Returns the row regardless of consumed/expired state. */
  findByHash(codeHash: string): Promise<AuthorizationCodeRecord | null>;

  /**
   * PF-104 — the CONDITIONAL consume, and the whole single-use guarantee.
   *
   * Returns false when the row was already consumed, and that false IS the
   * replay signal. Implementations must express this as ONE conditional write
   * (`UPDATE … WHERE id = $1 AND consumed_at IS NULL RETURNING id`), never as a
   * read followed by a write: two concurrent exchanges both pass a
   * read-then-write and the single-use property collapses to a race. Identical
   * in shape and in reasoning to `ITokenRepo.markSpent`.
   */
  consume(id: string, at: Date): Promise<boolean>;

  /**
   * PF-112 — the sweep. Deletes codes past `expires_at` that were never
   * consumed, and consumed codes older than `consumedBefore`.
   *
   * Two cut-offs rather than one because the two classes are retained for
   * different reasons: an unredeemed expired code is dead weight the moment it
   * expires, while a consumed code has to outlive its own TTL to keep replay
   * detection working. Returns the number of rows removed.
   */
  deleteSwept(expiredBefore: Date, consumedBefore: Date): Promise<number>;

  /**
   * Runs `fn` inside one transaction. Present for the same reason
   * `ITokenRepo.transaction` is: PF-104 requires the consume and the token
   * insert to be one atomic step, and no single-purpose method can express that
   * boundary. The callback receives an `IAuthCodeRepo` bound to the transaction.
   */
  transaction<T>(fn: (repo: IAuthCodeRepo) => Promise<T>): Promise<T>;
}

/**
 * In-memory double. Liskov-substitutable with `PgAuthCodeRepo`: same interface,
 * same null-on-missing behaviour, same conditional-consume semantics. Where the
 * two differ, the difference is a bug in one of them.
 */
export class InMemoryAuthCodeRepo implements IAuthCodeRepo {
  private rows = new Map<string, AuthorizationCodeRecord>();
  private seq = 0;

  async insert(input: InsertAuthorizationCodeInput): Promise<AuthorizationCodeRecord> {
    for (const row of this.rows.values()) {
      // Mirrors UNIQUE(code_hash). A collision means a CSPRNG failure and must be loud.
      if (row.codeHash === input.codeHash) throw new Error('duplicate code_hash');
    }
    this.seq += 1;
    const row: AuthorizationCodeRecord = {
      id: `authcode-${this.seq}`,
      codeHash: input.codeHash,
      codePrefix: input.codePrefix,
      appId: input.appId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      redirectUri: input.redirectUri,
      scopes: [...input.scopes],
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod,
      expiresAt: input.expiresAt,
      consumedAt: null,
      createdAt: input.createdAt,
    };
    this.rows.set(row.id, row);
    return { ...row };
  }

  async findByHash(codeHash: string): Promise<AuthorizationCodeRecord | null> {
    for (const row of this.rows.values()) {
      if (row.codeHash === codeHash) return { ...row };
    }
    return null;
  }

  async consume(id: string, at: Date): Promise<boolean> {
    const row = this.rows.get(id);
    // The `consumedAt === null` guard is the in-memory equivalent of the SQL
    // `WHERE … AND consumed_at IS NULL`. Checking it HERE rather than in the
    // caller is what keeps the two implementations substitutable.
    if (!row || row.consumedAt !== null) return false;
    row.consumedAt = at;
    return true;
  }

  async deleteSwept(expiredBefore: Date, consumedBefore: Date): Promise<number> {
    let count = 0;
    for (const [id, row] of [...this.rows.entries()]) {
      const expiredUnconsumed = row.consumedAt === null && row.expiresAt < expiredBefore;
      const agedConsumed = row.consumedAt !== null && row.consumedAt < consumedBefore;
      if (expiredUnconsumed || agedConsumed) {
        this.rows.delete(id);
        count += 1;
      }
    }
    return count;
  }

  async transaction<T>(fn: (repo: IAuthCodeRepo) => Promise<T>): Promise<T> {
    // No rollback. A test that needs rollback semantics is testing Postgres and
    // belongs in `pgAuthCodeRepo.test.ts`, where it runs against the engine whose
    // guarantee is under test. Same call as `InMemoryTokenRepo.transaction`.
    return fn(this);
  }

  /** Test-only: total rows held. PF-098 asserts Deny writes none. */
  size(): number {
    return this.rows.size;
  }
}
