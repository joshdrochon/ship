import pg from 'pg';
import type { PoolClient, QueryConfig, QueryResult, QueryResultRow } from 'pg';
import { config } from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables before creating pool
config({ path: join(__dirname, '../../.env.local') });
config({ path: join(__dirname, '../../.env') });

const { Pool } = pg;

const isProduction = process.env.NODE_ENV === 'production';

const basePool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Production-ready pool configuration
  max: isProduction ? 20 : 10, // Max connections (default is 10)
  idleTimeoutMillis: 30000, // Close idle connections after 30 seconds
  connectionTimeoutMillis: 2000, // Fail fast if can't connect in 2 seconds
  maxUses: 7500, // Recycle connections after 7500 queries to prevent memory leaks
  // DDoS protection: Terminate queries running longer than 30 seconds
  statement_timeout: 30000, // 30 seconds max query duration
  // Rule 7 (timeouts). statement_timeout is enforced by PostgreSQL, so it does
  // nothing if the server never answers at all. query_timeout is enforced by the
  // client, and is what actually unblocks a request whose connection has gone
  // half-open — a NAT or load-balancer dropping the flow without a FIN, which is
  // otherwise indistinguishable from a slow query and hangs until the socket's
  // own OS-level timeout (minutes to hours).
  // Failure mode: a silently dead TCP connection hanging an HTTP request forever.
  query_timeout: 30000,
  // Rule 7 (timeouts). TCP keepalives make the kernel notice a dead peer instead
  // of leaving an idle pooled connection to be handed out and fail on first use.
  // Failure mode: idle connections killed by an intermediary (RDS Proxy, NAT
  // table eviction) being handed to a request that then fails.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

/**
 * Rule 7 (resilience, not a retry). node-postgres emits `error` on the POOL for
 * errors on idle clients — a PostgreSQL restart, an RDS failover, an operator
 * running pg_terminate_backend. `error` on an EventEmitter with no listener is
 * rethrown as an uncaught exception, so before this handler existed any of those
 * events took the API process down, even though the pool's own recovery (discard
 * the client, open a fresh one) is exactly the right behaviour.
 *
 * Failure mode this protects against: the API process dying when the database
 * closes an idle connection.
 */
basePool.on('error', (err: Error) => {
  console.error('[db] Idle client error (connection discarded, pool continues):', err.message);
});

/**
 * Read a `code` off an unknown thrown value.
 *
 * Both sources of a retryable failure carry one: Node system errors
 * (`ECONNREFUSED`) put a string there, and pg's `DatabaseError` puts the
 * five-character SQLSTATE there. Narrowing with `in` rather than asserting a
 * shape means a thrown string, a thrown null, or an error with a non-string code
 * all fall through honestly instead of being described to the compiler as
 * something they are not.
 */
function errorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const { code } = err;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Rule 7 (retries). Transient failures where the query provably never reached
 * the server. Retrying these is safe; retrying anything else is not, because a
 * statement that may have committed must not be re-applied.
 *
 *   ECONNREFUSED / ENOTFOUND / EHOSTUNREACH / ETIMEDOUT  — never connected
 *   pg-pool "timeout exceeded when trying to connect"    — never got a client
 *   57P03 cannot_connect_now   — server is starting up and refusing connections
 *   53300 too_many_connections — server at its connection limit
 *   08001 / 08004 / 08006      — connection could not be established
 */
const RETRYABLE_CONNECT_ERRORS: ReadonlySet<string> = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT',
  '57P03', '53300', '08001', '08004', '08006',
]);

const CONNECT_RETRY_ATTEMPTS = 3;
const CONNECT_RETRY_BASE_MS = 100;

export function isRetryableConnectError(err: unknown): boolean {
  const code = errorCode(err);
  if (code !== undefined && RETRYABLE_CONNECT_ERRORS.has(code)) return true;
  return errorMessage(err).includes('timeout exceeded when trying to connect');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry an operation that failed before reaching PostgreSQL.
 *
 * Deliberately NOT retried: anything that failed after the statement was sent.
 * Neither this wrapper nor pg can tell "the write never ran" from "the write
 * committed and then the socket broke", so a blanket retry would risk applying a
 * document update twice. Statement-level retry belongs at the call site, where
 * idempotence is known — recorded here rather than left as an unexplained gap.
 *
 * Failure mode this protects against: a PostgreSQL restart, an RDS failover, or
 * a brief connection-limit exhaustion turning into a burst of HTTP 500s for
 * requests that would have succeeded a few hundred milliseconds later.
 */
async function withConnectRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= CONNECT_RETRY_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt === CONNECT_RETRY_ATTEMPTS || !isRetryableConnectError(err)) throw err;

      // Exponential backoff with jitter so N concurrent requests do not all
      // retry on the same tick and re-exhaust the connection limit together.
      const delay = CONNECT_RETRY_BASE_MS * 2 ** (attempt - 1);
      const jittered = delay / 2 + Math.random() * delay;
      console.warn(
        `[db] Connection attempt ${attempt}/${CONNECT_RETRY_ATTEMPTS} failed ` +
        `(${errorCode(err) ?? 'unknown'}), retrying in ${Math.round(jittered)}ms`
      );
      await sleep(jittered);
    }
  }

  throw lastError;
}

/**
 * Anything that can run a statement: the pool itself, or a `PoolClient` checked
 * out for a transaction. Helpers that accept either should take this type rather
 * than reaching for `typeof pool.query`.
 */
export interface QueryRunner {
  // The default type argument mirrors `@types/pg`, which declares
  // `query<R extends QueryResultRow = any>`. It is deliberate, not an oversight:
  // 1310 call sites read `result.rows[0].column` off an untyped row, and
  // tightening the default here to `QueryResultRow` makes every one of those a
  // "possibly undefined" error — 728 of them, in files this lane does not own.
  // Per-query row types are the fix for that, one call site at a time, behind the
  // same generic parameter this signature already exposes.
  // Named prepared statements go through this overload. pg selects its
  // extended-protocol path when given a config object carrying a `name`, which
  // lets each pooled connection parse and plan a statement once and thereafter
  // only bind and execute. GET /api/documents uses it for its six query shapes.
  //
  // This is the overload the interface comment below anticipated. Adding it with
  // a type, rather than widening the surface back out to `Pool`, is the point.
  //
  // Declared FIRST on purpose. Overload order is resolution order for calls, but
  // utility types like `Parameters<typeof pool.query>` read the LAST signature —
  // and several existing suites extract that to type their mocks. Putting the
  // (text, values) form last keeps those suites compiling unchanged.
  query<R extends QueryResultRow = any>(
    config: QueryConfig<any[]>,
  ): Promise<QueryResult<R>>;

  query<R extends QueryResultRow = any>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

/**
 * The database surface this codebase actually uses — `query` (1310 call sites),
 * `connect` (14, all transactions) and `end` (shutdown).
 *
 * Why a declared surface rather than the raw `Pool`: the retry above has to reach
 * every call site, and the first version of it got there by reassigning
 * `pool.query`. `Pool['query']` is eight overloads deep, so a wrapper could only
 * be attached through `as any` — which put four `any`s and two invented shape
 * assertions into the one module every route imports, for no type safety in
 * return. Naming the three methods makes the wrapper ordinary typed code, and it
 * closed a real gap on the way: the old patch wrapped `query` only, so the 14
 * `pool.connect()` transaction sites had no retry at all.
 *
 * If a future call site needs more of `Pool` (`totalCount`, a `QueryConfig`
 * object, the callback forms), add it here with a type rather than widening this
 * back out.
 */
export interface Database extends QueryRunner {
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}

const pool: Database = {
  query<R extends QueryResultRow = QueryResultRow>(
    textOrConfig: string | QueryConfig<any[]>,
    values?: unknown[],
  ): Promise<QueryResult<R>> {
    // Both overloads keep the connect-retry wrapper. A prepared statement that
    // could not retry a lost connection would be a silent hole in exactly the
    // hottest endpoint.
    return withConnectRetry(() =>
      typeof textOrConfig === 'string'
        ? basePool.query<R>(textOrConfig, values)
        : basePool.query<R>(textOrConfig),
    );
  },

  connect(): Promise<PoolClient> {
    return withConnectRetry(() => basePool.connect());
  },

  end(): Promise<void> {
    return basePool.end();
  },
};

/**
 * Rule 7 (circuit breakers) — assessed, deliberately not added for the database.
 *
 * A breaker exists to stop a caller hammering a dependency it cannot use, and to
 * fail fast instead of queueing. Neither applies here: there is no degraded mode
 * for this API without its own database, so tripping a breaker would convert
 * "some requests fail" into "all requests fail" while adding a second failure
 * mode (a stuck-open breaker) to debug. Failing fast is already covered —
 * connectionTimeoutMillis is 2 s, `max` bounds the queue, and the retry above is
 * capped at 3 attempts and ~700 ms. Recorded so the absence is a decision.
 */

// Graceful shutdown - close pool connections on process termination
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing database pool...');
  await pool.end();
  console.log('Database pool closed');
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, closing database pool...');
  await pool.end();
  console.log('Database pool closed');
  process.exit(0);
});

export { pool };
