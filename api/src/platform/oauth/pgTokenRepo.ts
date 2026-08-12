/**
 * `PgTokenRepo` — the Postgres implementation of `ITokenRepo`. PF-154, PF-170.
 *
 * Constructed ONLY in `productionDeps()` (`api/src/deps.ts`). Every statement
 * names its columns explicitly: `SELECT *` and `RETURNING *` are both banned
 * here for the reason L99's F17 records — an internal create returning
 * `RETURNING *` is how `yjs_state` and `deleted_at` nearly shipped to external
 * consumers. A column added by a later migration must be published deliberately.
 *
 * ---------------------------------------------------------------------------
 * THE ISOLATION ARGUMENT (PF-170) — why READ COMMITTED is sufficient here.
 * ---------------------------------------------------------------------------
 * PF-170 asks for "an isolation level that makes PF-167's conditional update
 * authoritative under concurrency". That level is Postgres's default, READ
 * COMMITTED, and the reason is worth writing down because "we used the default"
 * reads as an omission otherwise.
 *
 * The spend is `UPDATE … WHERE id = $1 AND spent_at IS NULL RETURNING id`. Under
 * READ COMMITTED, when two transactions target the same row, the second BLOCKS
 * on the first's row lock. When the first commits, the second does not proceed
 * on its original snapshot — Postgres RE-EVALUATES the `WHERE` clause against
 * the newly committed row version (this is the documented EvalPlanQual
 * behaviour for `UPDATE`). `spent_at` is now set, the predicate fails, and the
 * statement reports zero rows. Exactly one of N concurrent exchanges gets its
 * row back; the rest get the reuse signal. That is the guarantee PF-167 needs,
 * and it holds at every level at or above READ COMMITTED.
 *
 * SERIALIZABLE was considered and rejected: it would add serialization-failure
 * retries to the hot token path to buy a guarantee this statement already has,
 * and a retry loop around a rotation is a way to accidentally issue two pairs.
 */
import type { Database, QueryRunner } from '../../db/client.js';
import type { Scope } from '../scopes/registry.js';
import type {
  ITokenRepo,
  InsertPairInput,
  InsertedPair,
  RevocationReason,
  TokenRecord,
} from './tokenRepo.js';

/** Written once. `toDomain` reads the same list, and both live in this file. */
const COLUMNS = `
  id, token_hash, token_prefix, token_type, family_id, app_id, user_id,
  workspace_id, scopes, expires_at, spent_at, revoked_at, revocation_reason,
  replaces_token_id, created_at
`;

interface Row {
  id: string;
  token_hash: string;
  token_prefix: string;
  token_type: 'access' | 'refresh';
  family_id: string;
  app_id: string;
  user_id: string | null;
  workspace_id: string;
  scopes: string[];
  expires_at: Date;
  spent_at: Date | null;
  revoked_at: Date | null;
  revocation_reason: string | null;
  replaces_token_id: string | null;
  created_at: Date;
}

function toDomain(row: Row): TokenRecord {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    tokenPrefix: row.token_prefix,
    tokenType: row.token_type,
    familyId: row.family_id,
    appId: row.app_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    // Widening to Scope[] is safe because the only writer is `issueTokenPair`,
    // which copies an already-resolved grant. Nothing else writes this column.
    scopes: row.scopes as Scope[],
    expiresAt: row.expires_at,
    spentAt: row.spent_at,
    revokedAt: row.revoked_at,
    revocationReason: row.revocation_reason as RevocationReason | null,
    replacesTokenId: row.replaces_token_id,
    createdAt: row.created_at,
  };
}

/** A checked-out client. Derived from `Database` so `pg` is not imported here. */
type TxClient = Awaited<ReturnType<Database['connect']>>;

/**
 * The statements, parameterised over "anything that can run a query".
 *
 * Both the pool-backed repo and the transaction-bound repo extend this, so there
 * is exactly one copy of every statement and the two cannot drift. Only
 * `transaction` differs between them.
 */
abstract class TokenStatements implements ITokenRepo {
  constructor(protected readonly q: QueryRunner) {}

  abstract transaction<T>(fn: (repo: ITokenRepo) => Promise<T>): Promise<T>;

  /**
   * Both rows in ONE statement (PF-155). A two-statement insert outside a
   * transaction could leave an access token with no refresh partner; a single
   * multi-row INSERT is atomic on its own and needs no ceremony to be so.
   */
  async insertPair(input: InsertPairInput): Promise<InsertedPair> {
    const result = await this.q.query<Row>(
      `INSERT INTO oauth_tokens (
         token_hash, token_prefix, token_type, family_id, app_id, user_id,
         workspace_id, scopes, expires_at, replaces_token_id, created_at
       ) VALUES
         ($1,  $2,  'access',  $3, $4, $5, $6, $7::text[], $8,  $9,  $12),
         ($10, $11, 'refresh', $3, $4, $5, $6, $7::text[], $13, $14, $12)
       RETURNING ${COLUMNS}`,
      [
        input.accessTokenHash,
        input.accessTokenPrefix,
        input.familyId,
        input.appId,
        input.userId,
        input.workspaceId,
        input.scopes,
        input.accessExpiresAt,
        input.replacesAccessTokenId ?? null,
        input.refreshTokenHash,
        input.refreshTokenPrefix,
        input.createdAt,
        input.refreshExpiresAt,
        input.replacesRefreshTokenId ?? null,
      ],
    );

    // Selected by `token_type` rather than by row position: RETURNING order is
    // not a documented guarantee, and a silent swap here would hand the caller
    // a refresh token as its access token.
    const access = result.rows.find((r) => r.token_type === 'access');
    const refresh = result.rows.find((r) => r.token_type === 'refresh');
    if (!access || !refresh) throw new Error('insertPair did not return both rows');
    return { access: toDomain(access), refresh: toDomain(refresh) };
  }

  async findByHash(tokenHash: string): Promise<TokenRecord | null> {
    const result = await this.q.query<Row>(
      `SELECT ${COLUMNS} FROM oauth_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    const row = result.rows[0];
    return row ? toDomain(row) : null;
  }

  /**
   * PF-167 — the conditional spend. ONE statement, and its row count is the
   * answer. A `SELECT … ; if (!spent) UPDATE …` here would let two concurrent
   * exchanges both observe an unspent token and both proceed, which is the exact
   * race the theft signal is supposed to detect.
   */
  async markSpent(tokenId: string, at: Date): Promise<boolean> {
    const result = await this.q.query<{ id: string }>(
      `UPDATE oauth_tokens
          SET spent_at = $2
        WHERE id = $1 AND spent_at IS NULL
        RETURNING id`,
      [tokenId, at],
    );
    return result.rowCount === 1;
  }

  /**
   * PF-168 — every token in the family, of either type, spent or not.
   *
   * No `token_type` filter and no `spent_at` filter. Revoking only the refresh
   * side would leave the live ACCESS token working for the rest of its hour,
   * which is the half a client can actually observe and the half L24's PF-725
   * asserts from the far side of the wire.
   */
  async revokeFamily(familyId: string, reason: RevocationReason, at: Date): Promise<number> {
    const result = await this.q.query(
      `UPDATE oauth_tokens
          SET revoked_at = $2, revocation_reason = $3
        WHERE family_id = $1 AND revoked_at IS NULL`,
      [familyId, at, reason],
    );
    return result.rowCount ?? 0;
  }

  /**
   * One token, by id. PF-166's "the old access token is revoked too" — see the
   * justification on the interface.
   */
  async revokeToken(tokenId: string, reason: RevocationReason, at: Date): Promise<boolean> {
    const result = await this.q.query<{ id: string }>(
      `UPDATE oauth_tokens
          SET revoked_at = $2, revocation_reason = $3
        WHERE id = $1 AND revoked_at IS NULL
        RETURNING id`,
      [tokenId, at, reason],
    );
    return result.rowCount === 1;
  }

  /**
   * PF-165 — the revoke half of L02's leaked-secret playbook.
   *
   * UPDATE, never DELETE: the rows stay so the audit trail's history remains
   * resolvable, the same reasoning as migration 043's ON DELETE RESTRICT and
   * L02's PF-051.
   */
  async revokeByApp(appId: string, reason: RevocationReason, at: Date): Promise<number> {
    const result = await this.q.query(
      `UPDATE oauth_tokens
          SET revoked_at = $2, revocation_reason = $3
        WHERE app_id = $1 AND revoked_at IS NULL AND expires_at > $2`,
      [appId, at, reason],
    );
    return result.rowCount ?? 0;
  }

  async listFamily(familyId: string): Promise<TokenRecord[]> {
    const result = await this.q.query<Row>(
      `SELECT ${COLUMNS} FROM oauth_tokens
        WHERE family_id = $1
        ORDER BY created_at ASC, token_type DESC, id ASC`,
      [familyId],
    );
    return result.rows.map(toDomain);
  }

  async deleteExpired(before: Date): Promise<number> {
    const result = await this.q.query(`DELETE FROM oauth_tokens WHERE expires_at < $1`, [before]);
    return result.rowCount ?? 0;
  }
}

/** Bound to a checked-out client inside an open transaction. */
class TxTokenRepo extends TokenStatements {
  /**
   * Already inside a transaction — join it rather than opening a second one.
   * Throwing instead would make an inner helper that wants atomicity unusable
   * from a caller that already has it, which is the common case in `rotation.ts`.
   */
  async transaction<T>(fn: (repo: ITokenRepo) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

export class PgTokenRepo extends TokenStatements {
  constructor(private readonly db: Database) {
    super(db);
  }

  /**
   * PF-170 — one transaction around the whole rotation.
   *
   * The spend, the family check, the new pair's insert and any family revocation
   * are all inside this boundary, so the database is never left with a live
   * access token whose refresh partner does not exist.
   */
  async transaction<T>(fn: (repo: ITokenRepo) => Promise<T>): Promise<T> {
    const client: TxClient = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new TxTokenRepo(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
