/**
 * `PgAuthCodeRepo` — the Postgres implementation of `IAuthCodeRepo`. PF-086, PF-104.
 *
 * Constructed ONLY in `productionDeps()` (`api/src/deps.ts`), for the same
 * reason `PgTokenRepo` and `PgOAuthAppRepo` are. Every statement names its
 * columns: `SELECT *` and `RETURNING *` are banned here exactly as they are in
 * `pgTokenRepo.ts` (L99's F17 is what that rule is for).
 *
 * The file's shape deliberately mirrors `pgTokenRepo.ts` — an abstract
 * `…Statements` class parameterised over a `QueryRunner`, with a pool-backed and
 * a transaction-bound subclass — so there is one copy of every statement and the
 * two callers cannot drift.
 *
 * ---------------------------------------------------------------------------
 * THE ISOLATION ARGUMENT, AGAIN, AND IT IS THE SAME ONE (PF-104).
 * ---------------------------------------------------------------------------
 * `consume` is `UPDATE … WHERE id = $1 AND consumed_at IS NULL RETURNING id`.
 * Under Postgres's default READ COMMITTED, two transactions targeting the same
 * row serialise on the row lock, and when the first commits the second
 * RE-EVALUATES its `WHERE` against the new row version (EvalPlanQual) rather
 * than proceeding on its original snapshot. `consumed_at` is now set, the
 * predicate fails, zero rows come back.
 *
 * So exactly one of N concurrent exchanges of one code gets the row, and the
 * rest get `false` — which is the replay signal PF-104 needs, and the reason the
 * single-use guarantee is a property of the statement rather than of a
 * `SELECT … then UPDATE` the handler is trusted to write correctly. PF-104's
 * concurrency test drives two exchanges simultaneously rather than reading this
 * paragraph.
 *
 * SERIALIZABLE was considered and rejected for the reason `pgTokenRepo.ts`
 * gives: it would add serialization-failure retries to the redemption path to
 * buy a guarantee this statement already has, and a retry loop around a
 * redemption is a way to accidentally issue two token pairs from one code.
 */
import type { Database, QueryRunner } from '../../db/client.js';
import type { Scope } from '../scopes/scopes.js';
import type {
  IAuthCodeRepo,
  AuthorizationCodeRecord,
  InsertAuthorizationCodeInput,
} from './authCodes.js';

/** Written once. `toDomain` reads the same list, and both live in this file. */
const COLUMNS = `
  id, code_hash, code_prefix, app_id, user_id, workspace_id, redirect_uri,
  scopes, code_challenge, code_challenge_method, expires_at, consumed_at,
  created_at
`;

interface Row {
  id: string;
  code_hash: string;
  code_prefix: string;
  app_id: string;
  user_id: string;
  workspace_id: string;
  redirect_uri: string;
  scopes: string[];
  code_challenge: string;
  code_challenge_method: string;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
}

function toDomain(row: Row): AuthorizationCodeRecord {
  return {
    id: row.id,
    codeHash: row.code_hash,
    codePrefix: row.code_prefix,
    appId: row.app_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    redirectUri: row.redirect_uri,
    // Widening to Scope[] is safe because the only writer is the authorize
    // handler, which writes an already-resolved grant (PF-074). Nothing else
    // writes this column.
    scopes: row.scopes as Scope[],
    codeChallenge: row.code_challenge,
    codeChallengeMethod: row.code_challenge_method,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

/** A checked-out client. Derived from `Database` so `pg` is not imported here. */
type TxClient = Awaited<ReturnType<Database['connect']>>;

abstract class AuthCodeStatements implements IAuthCodeRepo {
  constructor(protected readonly q: QueryRunner) {}

  abstract transaction<T>(fn: (repo: IAuthCodeRepo) => Promise<T>): Promise<T>;

  async insert(input: InsertAuthorizationCodeInput): Promise<AuthorizationCodeRecord> {
    const result = await this.q.query<Row>(
      `INSERT INTO oauth_authorization_codes (
         code_hash, code_prefix, app_id, user_id, workspace_id, redirect_uri,
         scopes, code_challenge, code_challenge_method, expires_at, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9, $10, $11)
       RETURNING ${COLUMNS}`,
      [
        input.codeHash,
        input.codePrefix,
        input.appId,
        input.userId,
        input.workspaceId,
        input.redirectUri,
        input.scopes,
        input.codeChallenge,
        input.codeChallengeMethod,
        input.expiresAt,
        input.createdAt,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('authorization code insert returned no row');
    return toDomain(row);
  }

  async findByHash(codeHash: string): Promise<AuthorizationCodeRecord | null> {
    const result = await this.q.query<Row>(
      `SELECT ${COLUMNS} FROM oauth_authorization_codes WHERE code_hash = $1`,
      [codeHash],
    );
    const row = result.rows[0];
    return row ? toDomain(row) : null;
  }

  /** See the header. ONE conditional statement; never a read followed by a write. */
  async consume(id: string, at: Date): Promise<boolean> {
    const result = await this.q.query<{ id: string }>(
      `UPDATE oauth_authorization_codes
          SET consumed_at = $2
        WHERE id = $1 AND consumed_at IS NULL
        RETURNING id`,
      [id, at],
    );
    return result.rows.length === 1;
  }

  async deleteSwept(expiredBefore: Date, consumedBefore: Date): Promise<number> {
    const result = await this.q.query<{ id: string }>(
      `DELETE FROM oauth_authorization_codes
        WHERE (consumed_at IS NULL AND expires_at < $1)
           OR (consumed_at IS NOT NULL AND consumed_at < $2)
        RETURNING id`,
      [expiredBefore, consumedBefore],
    );
    return result.rows.length;
  }
}

/** Pool-backed. Every call is its own implicit transaction. */
export class PgAuthCodeRepo extends AuthCodeStatements {
  constructor(private readonly db: Database) {
    super(db);
  }

  async transaction<T>(fn: (repo: IAuthCodeRepo) => Promise<T>): Promise<T> {
    const client: TxClient = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new TxAuthCodeRepo(client));
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

/**
 * Bound to one checked-out client inside an open transaction.
 *
 * `transaction` returns `fn(this)` rather than opening a nested one: Postgres
 * has no nested transactions without savepoints, and silently opening a second
 * BEGIN on the same client is how a rollback ends up rolling back nothing. Same
 * call as `TxTokenRepo`'s.
 */
class TxAuthCodeRepo extends AuthCodeStatements {
  async transaction<T>(fn: (repo: IAuthCodeRepo) => Promise<T>): Promise<T> {
    return fn(this);
  }
}
