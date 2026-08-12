/**
 * `ITokenRepo` and its in-memory double. PF-154 (lane L06, slice S1).
 *
 * No Express types and no `pg` types appear in any signature in this file. That
 * is the property that lets L04 (auth code), L05 (device grant) and this lane's
 * own rotation logic be unit-tested in a bare Node context with no HTTP stack
 * and no database — exactly as L02's PF-037 does for `IOAuthAppRepo`, and for
 * the same reason.
 *
 * Construction is the composition root's job and nobody else's: `PgTokenRepo` is
 * built in `productionDeps()` and `InMemoryTokenRepo` in `testDeps()`
 * (`api/src/deps.ts`, PF-015/PF-016). A `new PgTokenRepo(...)` anywhere else is
 * the bug that the composition-root claim in `docs/architecture.md` exists to
 * prevent, and `tokenRepo.test.ts` fails on a second construction site.
 *
 * This is the `tokenRepo(db)` argument the composition-root sketch at
 * `docs/architecture.md:52` and `:59` already passes to both
 * `bearerTokenMiddleware` and `oauthRouter`, so p.12's Composition Root
 * deliverable stays accurate rather than becoming aspirational.
 *
 * ---------------------------------------------------------------------------
 * ONE METHOD MORE THAN PF-154 LISTED, AND WHY.
 * ---------------------------------------------------------------------------
 * PF-154 names seven: insertPair, findByHash, markSpent, revokeFamily,
 * revokeByApp, listFamily, deleteExpired. All seven are here. `transaction` is
 * an eighth, and it is here because PF-170 requires the spend, the family check,
 * the new pair's insert and any family revocation to happen inside ONE
 * transaction, and none of the seven can express that boundary. The alternative
 * — a single fat `rotate()` method — would push rotation policy into the
 * repository, where the in-memory double and Postgres would each need their own
 * copy of it and could disagree. `transaction` keeps the policy in `rotation.ts`
 * (one implementation, both backends) and keeps the repository about storage.
 * It leaks no `pg` types: the callback receives an `ITokenRepo`.
 */
import type { Scope } from '../scopes/registry.js';

/** Why a token was revoked. A machine-readable tag, never prose, never shown to a caller. */
export type RevocationReason =
  /** PRD p.3's theft signal — a spent refresh token was presented again. */
  | 'refresh_token_reuse'
  /** Superseded by a successful rotation. The old ACCESS token gets this (PF-166). */
  | 'rotated'
  /** L02's leaked-secret playbook, the revoke half (PF-165/PF-049). */
  | 'app_revoked';

/** A row of `oauth_tokens` (migration 043), in domain terms. */
export interface TokenRecord {
  id: string;
  tokenHash: string;
  tokenPrefix: string;
  tokenType: 'access' | 'refresh';
  /** The theft signal's anchor. Shared by every token descended from one grant. */
  familyId: string;
  appId: string;
  /** Null for machine-to-machine tokens, which belong to an app and to no human. */
  userId: string | null;
  workspaceId: string;
  /** The RESOLVED grant, copied at issuance — never the app's `requested_scopes`. */
  scopes: Scope[];
  expiresAt: Date;
  /** One-time use: set when a refresh token is exchanged (PF-167). */
  spentAt: Date | null;
  revokedAt: Date | null;
  revocationReason: RevocationReason | null;
  /** The rotation chain (PF-153). Null for the first pair of a family. */
  replacesTokenId: string | null;
  createdAt: Date;
}

/** Everything needed to write one access/refresh pair. Raw tokens never reach here. */
export interface InsertPairInput {
  familyId: string;
  appId: string;
  userId: string | null;
  workspaceId: string;
  scopes: Scope[];
  accessTokenHash: string;
  accessTokenPrefix: string;
  accessExpiresAt: Date;
  refreshTokenHash: string;
  refreshTokenPrefix: string;
  refreshExpiresAt: Date;
  /** Links the chain when this pair supersedes another (PF-153). */
  replacesAccessTokenId?: string | null;
  replacesRefreshTokenId?: string | null;
  createdAt: Date;
}

export interface InsertedPair {
  access: TokenRecord;
  refresh: TokenRecord;
}

export interface ITokenRepo {
  /**
   * Writes BOTH rows and their shared `family_id` atomically (PF-155).
   *
   * One call rather than two so that a crash cannot leave an access token whose
   * refresh partner does not exist — a state in which the user appears logged in
   * for an hour and then cannot recover without re-authenticating.
   */
  insertPair(input: InsertPairInput): Promise<InsertedPair>;

  /** The lookup on every `/api/v1` request. Returns the row regardless of state. */
  findByHash(tokenHash: string): Promise<TokenRecord | null>;

  /**
   * PF-167 — the CONDITIONAL spend. Returns false when the token was already
   * spent, and that false IS the reuse signal.
   *
   * Implementations must express this as one conditional write
   * (`UPDATE … WHERE id = $1 AND spent_at IS NULL`), never as a read followed by
   * a write: two concurrent exchanges both pass a read-then-write, and the whole
   * theft signal collapses to a race.
   */
  markSpent(tokenId: string, at: Date): Promise<boolean>;

  /** PF-168 — revokes EVERY token in the family, of either type, spent or not. */
  revokeFamily(familyId: string, reason: RevocationReason, at: Date): Promise<number>;

  /**
   * Revokes ONE token by id.
   *
   * A ninth method, and the justification is PF-166's: a successful rotation
   * must kill the OLD ACCESS token, not just spend the old refresh token —
   * leaving it live for the remainder of its hour is the difference between
   * rotation and mere re-issuance. Neither `revokeFamily` (too broad; it would
   * kill the pair just issued) nor `revokeByApp` (far too broad) can express
   * "this one token", so the capability has to exist somewhere. Putting it on
   * the repository keeps rotation policy in `rotation.ts` with one
   * implementation for both backends.
   */
  revokeToken(tokenId: string, reason: RevocationReason, at: Date): Promise<boolean>;

  /** PF-165 — every unexpired, unrevoked token belonging to one app. */
  revokeByApp(appId: string, reason: RevocationReason, at: Date): Promise<number>;

  /** PF-153/PF-169 — the whole family, oldest first, so a test can walk the chain. */
  listFamily(familyId: string): Promise<TokenRecord[]>;

  /** Housekeeping sweep. Deletes rows already past `expires_at`. */
  deleteExpired(before: Date): Promise<number>;

  /**
   * Runs `fn` inside one transaction (PF-170). See the header for why this is
   * here rather than a `rotate()` method.
   *
   * The `ITokenRepo` handed to the callback is bound to the transaction; calls
   * made on the OUTER repo from inside the callback are NOT part of it.
   */
  transaction<T>(fn: (repo: ITokenRepo) => Promise<T>): Promise<T>;
}

/**
 * In-memory double for tests and for the lanes downstream of this one.
 *
 * Liskov-substitutable with `PgTokenRepo`: same interface, same ordering, same
 * null-on-missing behaviour, same conditional-spend semantics. Where the two
 * differ the difference is a bug in one of them, and the shared contract test in
 * `tokenRepo.test.ts` is what catches it.
 *
 * `transaction` here is deliberately NOT a real transaction — see the note on
 * the method. Single-threaded JavaScript gives the callback atomicity against
 * other callbacks in the same process, which is all a unit test needs; the
 * concurrency guarantee PF-170 actually rests on is Postgres's, and it is tested
 * against Postgres.
 */
export class InMemoryTokenRepo implements ITokenRepo {
  private rows = new Map<string, TokenRecord>();
  private seq = 0;

  private mint(
    input: InsertPairInput,
    type: 'access' | 'refresh',
    hash: string,
    prefix: string,
    expiresAt: Date,
    replaces: string | null,
  ): TokenRecord {
    this.seq += 1;
    const row: TokenRecord = {
      id: `token-${this.seq}`,
      tokenHash: hash,
      tokenPrefix: prefix,
      tokenType: type,
      familyId: input.familyId,
      appId: input.appId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      scopes: [...input.scopes],
      expiresAt,
      spentAt: null,
      revokedAt: null,
      revocationReason: null,
      replacesTokenId: replaces,
      createdAt: input.createdAt,
    };
    this.rows.set(row.id, row);
    return { ...row };
  }

  async insertPair(input: InsertPairInput): Promise<InsertedPair> {
    for (const row of this.rows.values()) {
      if (row.tokenHash === input.accessTokenHash || row.tokenHash === input.refreshTokenHash) {
        // Mirrors the UNIQUE(token_hash) index. A collision here means a CSPRNG
        // failure or a reused hash, and both must be loud.
        throw new Error('duplicate token_hash');
      }
    }
    const access = this.mint(
      input,
      'access',
      input.accessTokenHash,
      input.accessTokenPrefix,
      input.accessExpiresAt,
      input.replacesAccessTokenId ?? null,
    );
    const refresh = this.mint(
      input,
      'refresh',
      input.refreshTokenHash,
      input.refreshTokenPrefix,
      input.refreshExpiresAt,
      input.replacesRefreshTokenId ?? null,
    );
    return { access, refresh };
  }

  async findByHash(tokenHash: string): Promise<TokenRecord | null> {
    for (const row of this.rows.values()) {
      if (row.tokenHash === tokenHash) return { ...row };
    }
    return null;
  }

  async markSpent(tokenId: string, at: Date): Promise<boolean> {
    const row = this.rows.get(tokenId);
    // The `spentAt === null` guard is the in-memory equivalent of the SQL
    // `WHERE … AND spent_at IS NULL`. Checking it here rather than in the caller
    // is what keeps the two implementations substitutable.
    if (!row || row.spentAt !== null) return false;
    row.spentAt = at;
    return true;
  }

  async revokeFamily(familyId: string, reason: RevocationReason, at: Date): Promise<number> {
    let count = 0;
    for (const row of this.rows.values()) {
      // No token_type filter and no spent filter, deliberately: PF-168 revokes
      // the LIVE ACCESS TOKEN too, and that half is the only part a subscriber
      // can observe.
      if (row.familyId === familyId && row.revokedAt === null) {
        row.revokedAt = at;
        row.revocationReason = reason;
        count += 1;
      }
    }
    return count;
  }

  async revokeToken(tokenId: string, reason: RevocationReason, at: Date): Promise<boolean> {
    const row = this.rows.get(tokenId);
    if (!row || row.revokedAt !== null) return false;
    row.revokedAt = at;
    row.revocationReason = reason;
    return true;
  }

  async revokeByApp(appId: string, reason: RevocationReason, at: Date): Promise<number> {
    let count = 0;
    for (const row of this.rows.values()) {
      if (row.appId === appId && row.revokedAt === null && row.expiresAt > at) {
        row.revokedAt = at;
        row.revocationReason = reason;
        count += 1;
      }
    }
    return count;
  }

  async listFamily(familyId: string): Promise<TokenRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.familyId === familyId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .map((r) => ({ ...r }));
  }

  async deleteExpired(before: Date): Promise<number> {
    let count = 0;
    for (const [id, row] of [...this.rows.entries()]) {
      if (row.expiresAt < before) {
        this.rows.delete(id);
        count += 1;
      }
    }
    return count;
  }

  async transaction<T>(fn: (repo: ITokenRepo) => Promise<T>): Promise<T> {
    // No rollback. A unit test that needs rollback semantics is really testing
    // Postgres and belongs in `pgTokenRepo.test.ts`, where it runs against the
    // engine whose guarantee is under test.
    return fn(this);
  }
}
