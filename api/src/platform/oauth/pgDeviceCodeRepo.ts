/**
 * `PgDeviceCodeRepo` — the Postgres implementation of `IDeviceCodeRepo`.
 * PF-121, PF-130, PF-136, PF-140 (lane L05).
 *
 * Constructed ONLY in `productionDeps()` (`api/src/deps.ts`), for the same
 * reason `PgAuthCodeRepo`, `PgTokenRepo` and `PgOAuthAppRepo` are. Every
 * statement names its columns: `SELECT *` and `RETURNING *` are banned here
 * exactly as they are in `pgTokenRepo.ts` and `pgAuthCodeRepo.ts` (L99's F17 is
 * what that rule is for).
 *
 * The file's shape deliberately mirrors `pgAuthCodeRepo.ts` — an abstract
 * `…Statements` class parameterised over a `QueryRunner`, with a pool-backed and
 * a transaction-bound subclass — so there is one copy of every statement and the
 * two callers cannot drift.
 *
 * ---------------------------------------------------------------------------
 * THE ISOLATION ARGUMENT, AGAIN, AND IT IS THE SAME ONE (PF-140).
 * ---------------------------------------------------------------------------
 * `consume` is `UPDATE … WHERE id = $1 AND consumed_at IS NULL RETURNING id`.
 * Under Postgres's default READ COMMITTED, two transactions targeting the same
 * row serialise on the row lock, and when the first commits the second
 * RE-EVALUATES its `WHERE` against the new row version (EvalPlanQual) rather
 * than proceeding on its original snapshot. `consumed_at` is now set, the
 * predicate fails, zero rows come back.
 *
 * So exactly one of N concurrent polls after approval gets the row and the rest
 * get `false` — which is what makes "one device code yields one token pair" a
 * property of the statement rather than of a `SELECT … then UPDATE` the handler
 * is trusted to write correctly. PF-140's concurrency test drives simultaneous
 * polls rather than reading this paragraph.
 *
 * `approve` and `deny` carry `WHERE status = 'pending'` for the same reason:
 * two browser tabs submitting a decision on one code must not both win.
 *
 * ---------------------------------------------------------------------------
 * WHY `findByUserCode` NORMALIZES ON BOTH SIDES (PF-131).
 * ---------------------------------------------------------------------------
 * The stored value is the canonical hyphenated form, and the incoming value is
 * whatever a human typed. Rather than trusting that the column is already
 * normalized, the predicate normalizes the stored side too — uppercase, strip
 * everything outside `[A-Z0-9]` — which is exactly what `normalizeUserCode`
 * does in TypeScript. Two expressions of one rule is a thing that drifts, so
 * `deviceCodes.test.ts` asserts the two agree across the same input table.
 *
 * The predicate is therefore not sargable and will not use `UNIQUE(user_code)`
 * as an index. That is a deliberate and bounded cost: the table holds one row
 * per in-flight `ship login` with a 600-second TTL (PF-144's arithmetic), so it
 * is tens of rows in the demo and the scan is trivial. The alternative — a
 * generated normalized column with its own index — is the right fix if this
 * table ever grows, and it is a migration rather than a rewrite.
 */
import type { Database, QueryRunner } from '../../db/client.js';
import type { Scope } from '../scopes/scopes.js';
import type {
  IDeviceCodeRepo,
  DeviceCodeRecord,
  InsertDeviceCodeInput,
  ApproveDeviceCodeInput,
  DeviceAuthorizationStatus,
} from './deviceCodes.js';

/** Written once. `toDomain` reads the same list, and both live in this file. */
const COLUMNS = `
  id, device_code_hash, user_code, app_id, scopes, status, user_id, workspace_id,
  interval_seconds, last_polled_at, expires_at, consumed_at, created_at
`;

/**
 * The SQL half of `normalizeUserCode`. See the header — `deviceCodes.test.ts`
 * asserts this expression and the TypeScript function agree on the same inputs.
 */
const NORMALIZED_USER_CODE = `regexp_replace(upper(user_code), '[^A-Z0-9]', '', 'g')`;

interface Row {
  id: string;
  device_code_hash: string;
  user_code: string;
  app_id: string;
  scopes: string[];
  status: string;
  user_id: string | null;
  workspace_id: string | null;
  interval_seconds: number;
  last_polled_at: Date | null;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
}

function toDomain(row: Row): DeviceCodeRecord {
  return {
    id: row.id,
    deviceCodeHash: row.device_code_hash,
    userCode: row.user_code,
    appId: row.app_id,
    // Widening to Scope[] is safe because the only writers are the issuance
    // handler, which writes a validated request (PF-126), and the approval,
    // which writes an already-resolved grant (PF-074).
    scopes: row.scopes as Scope[],
    status: row.status as DeviceAuthorizationStatus,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    intervalSeconds: row.interval_seconds,
    lastPolledAt: row.last_polled_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

/** A checked-out client. Derived from `Database` so `pg` is not imported here. */
type TxClient = Awaited<ReturnType<Database['connect']>>;

abstract class DeviceCodeStatements implements IDeviceCodeRepo {
  constructor(protected readonly q: QueryRunner) {}

  abstract transaction<T>(fn: (repo: IDeviceCodeRepo) => Promise<T>): Promise<T>;

  async insert(input: InsertDeviceCodeInput): Promise<DeviceCodeRecord> {
    const result = await this.q.query<Row>(
      `INSERT INTO oauth_device_codes (
         device_code_hash, user_code, app_id, scopes, status,
         interval_seconds, expires_at, created_at
       ) VALUES ($1, $2, $3, $4::text[], 'pending', $5, $6, $7)
       RETURNING ${COLUMNS}`,
      [
        input.deviceCodeHash,
        input.userCode,
        input.appId,
        input.scopes,
        input.intervalSeconds,
        input.expiresAt,
        input.createdAt,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('device code insert returned no row');
    return toDomain(row);
  }

  async findByDeviceCodeHash(hash: string): Promise<DeviceCodeRecord | null> {
    const result = await this.q.query<Row>(
      `SELECT ${COLUMNS} FROM oauth_device_codes WHERE device_code_hash = $1`,
      [hash],
    );
    const row = result.rows[0];
    return row ? toDomain(row) : null;
  }

  /** See the header for why both sides are normalized. */
  async findByUserCode(normalized: string): Promise<DeviceCodeRecord | null> {
    const result = await this.q.query<Row>(
      `SELECT ${COLUMNS} FROM oauth_device_codes WHERE ${NORMALIZED_USER_CODE} = $1`,
      [normalized],
    );
    const row = result.rows[0];
    return row ? toDomain(row) : null;
  }

  /** ONE conditional statement. See the header. */
  async approve(input: ApproveDeviceCodeInput, at: Date): Promise<boolean> {
    const result = await this.q.query<{ id: string }>(
      `UPDATE oauth_device_codes
          SET status = 'approved',
              user_id = $2,
              workspace_id = $3,
              scopes = $4::text[],
              last_polled_at = last_polled_at
        WHERE id = $1 AND status = 'pending'
        RETURNING id`,
      [input.id, input.userId, input.workspaceId, input.scopes],
    );
    void at;
    return result.rows.length === 1;
  }

  async deny(id: string, at: Date): Promise<boolean> {
    const result = await this.q.query<{ id: string }>(
      `UPDATE oauth_device_codes
          SET status = 'denied'
        WHERE id = $1 AND status = 'pending'
        RETURNING id`,
      [id],
    );
    void at;
    return result.rows.length === 1;
  }

  async recordPoll(id: string, at: Date, intervalSeconds: number): Promise<void> {
    await this.q.query(
      `UPDATE oauth_device_codes
          SET last_polled_at = $2, interval_seconds = $3
        WHERE id = $1`,
      [id, at, intervalSeconds],
    );
  }

  /** See the header. ONE conditional statement; never a read followed by a write. */
  async consume(id: string, at: Date): Promise<boolean> {
    const result = await this.q.query<{ id: string }>(
      `UPDATE oauth_device_codes
          SET consumed_at = $2
        WHERE id = $1 AND consumed_at IS NULL
        RETURNING id`,
      [id, at],
    );
    return result.rows.length === 1;
  }

  async invalidate(id: string, at: Date): Promise<boolean> {
    // Denial rather than deletion — see `IDeviceCodeRepo.invalidate`. Reuses the
    // same conditional shape so an already-decided code is not re-decided.
    return this.deny(id, at);
  }

  async deleteSwept(expiredBefore: Date, consumedBefore: Date): Promise<number> {
    const result = await this.q.query<{ id: string }>(
      `DELETE FROM oauth_device_codes
        WHERE (consumed_at IS NULL AND expires_at < $1)
           OR (consumed_at IS NOT NULL AND consumed_at < $2)
        RETURNING id`,
      [expiredBefore, consumedBefore],
    );
    return result.rows.length;
  }
}

/** Pool-backed. Every call is its own implicit transaction. */
export class PgDeviceCodeRepo extends DeviceCodeStatements {
  constructor(private readonly db: Database) {
    super(db);
  }

  async transaction<T>(fn: (repo: IDeviceCodeRepo) => Promise<T>): Promise<T> {
    const client: TxClient = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new TxDeviceCodeRepo(client));
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
 * call as `TxAuthCodeRepo`'s and `TxTokenRepo`'s.
 */
class TxDeviceCodeRepo extends DeviceCodeStatements {
  async transaction<T>(fn: (repo: IDeviceCodeRepo) => Promise<T>): Promise<T> {
    return fn(this);
  }
}
