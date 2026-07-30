import pg from 'pg';
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

const pool = new Pool({
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
 * events took the API process down, even though the pool's own recovery
 * (discard the client, open a fresh one) is exactly the right behaviour.
 *
 * Failure mode this protects against: the API process dying when the database
 * closes an idle connection.
 */
pool.on('error', (err) => {
  console.error('[db] Idle client error (connection discarded, pool continues):', err.message);
});

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
const RETRYABLE_CONNECT_ERRORS = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT',
  '57P03', '53300', '08001', '08004', '08006',
]);

const CONNECT_RETRY_ATTEMPTS = 3;
const CONNECT_RETRY_BASE_MS = 100;

function isRetryableConnectError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  if (code && RETRYABLE_CONNECT_ERRORS.has(code)) return true;
  const message = (err as { message?: string }).message ?? '';
  return message.includes('timeout exceeded when trying to connect');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry only connection establishment, transparently, for every existing
 * `pool.query(...)` call site. There are several hundred of them, so wrapping the
 * method is what makes this reachable without touching each one.
 *
 * Deliberately NOT retried: anything that failed after the statement was sent.
 * `pool.query` cannot tell "the write never ran" from "the write committed and
 * then the socket broke", so a blanket retry would risk applying a document
 * update twice. Statement-level retry belongs at the call site, where
 * idempotence is known — recorded here rather than left as an unexplained gap.
 *
 * Failure mode this protects against: a PostgreSQL restart, an RDS failover, or
 * a brief connection-limit exhaustion turning into a burst of HTTP 500s for
 * requests that would have succeeded a few hundred milliseconds later.
 */
const originalQuery = pool.query.bind(pool);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
pool.query = (async (...args: any[]) => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CONNECT_RETRY_ATTEMPTS; attempt++) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await (originalQuery as any)(...args);
    } catch (err) {
      lastError = err;
      if (attempt === CONNECT_RETRY_ATTEMPTS || !isRetryableConnectError(err)) throw err;
      // Exponential backoff with jitter so N concurrent requests do not all
      // retry on the same tick and re-exhaust the connection limit together.
      const delay = CONNECT_RETRY_BASE_MS * 2 ** (attempt - 1);
      const jittered = delay / 2 + Math.random() * delay;
      console.warn(
        `[db] Connection attempt ${attempt}/${CONNECT_RETRY_ATTEMPTS} failed ` +
        `(${(err as { code?: string }).code ?? 'unknown'}), retrying in ${Math.round(jittered)}ms`
      );
      await sleep(jittered);
    }
  }
  throw lastError;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

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

export { pool, isRetryableConnectError };
