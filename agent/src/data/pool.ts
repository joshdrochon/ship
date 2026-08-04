/**
 * Postgres connection pool for the agent.
 *
 * Deliberately small. The agent runs in two shapes and both are constrained:
 *
 *  - the proactive cron starts, scans, and exits — it wants a couple of
 *    connections for a few seconds, not a warm pool
 *  - Render's free-plan Postgres caps total connections, and the API service is
 *    already holding a pool against the same database
 *
 * An unbounded pool here would compete with the API for connections and the
 * symptom would surface as user-facing request failures rather than as an agent
 * problem, which is the worst place for it to appear.
 */
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';

/**
 * Four is enough for the three parallel fetch nodes (PRESEARCH.md Q16) plus one
 * spare. More would not make the scan faster — it is a small number of indexed
 * queries, not a throughput problem.
 */
const MAX_CONNECTIONS = 4;

/** A scan that has not produced a connection in 5s is not going to. */
const CONNECTION_TIMEOUT_MS = 5_000;

/**
 * Cron containers exit; idle connections should not keep the process alive or
 * hold a slot on the server after the run is done.
 */
const IDLE_TIMEOUT_MS = 10_000;

/**
 * Engineering requirement 4 applies to every outbound call, and Postgres is one.
 * Without this a query against a wedged connection hangs the run indefinitely —
 * "should not crash or hang indefinitely" in the brief's words.
 */
const STATEMENT_TIMEOUT_MS = 15_000;

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. The agent reads Ship state directly (PRESEARCH.md Q1); ' +
        'it cannot fall back to the HTTP API for detection.'
    );
  }

  const config: PoolConfig = {
    connectionString,
    max: MAX_CONNECTIONS,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    // Matches api/src/db/client.ts — Render terminates TLS with its own CA.
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  };

  pool = new Pool(config);

  // An idle client erroring is not fatal — pg replaces it — but swallowing it
  // silently means a database problem shows up later as an inexplicably empty
  // scan. Log it where it happens.
  pool.on('error', (err) => {
    console.error('[fleetgraph] idle client error:', err.message);
  });

  return pool;
}

/** Cron entrypoints must call this, or the process will not exit. */
export async function closePool(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}
