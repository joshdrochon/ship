/**
 * The only thing the agent needs from a database handle: the ability to run a
 * query.
 *
 * ── Why this is structural rather than `Pool | PoolClient` ──────────────────
 * It used to be `Pool | PoolClient` from `pg`, which is precise and turned out
 * to be too narrow. Ship's API wraps its pool in a `Database` object with
 * retry and logging around `query`, and that wrapper is not a `Pool` — it is
 * missing two dozen properties the agent never touches. So the chat endpoint
 * could not hand the agent the connection it already had.
 *
 * The agent calls exactly one method. Asking for a full `Pool` demanded
 * twenty-odd properties as proof of something never used, which is the same
 * mistake as accepting a concrete class where an interface would do.
 *
 * A real `Pool`, a `PoolClient`, and Ship's `Database` wrapper all satisfy
 * this, so the same detector code runs under the cron, under a test container,
 * and inside an HTTP request without caring which it got.
 *
 * `pool.connect()` is deliberately NOT here. The cron needs it for the
 * per-workspace advisory lock and reaches for the real pool directly — a lock
 * taken on one pooled connection and released on another is not a lock, and
 * hiding that behind this interface would make it look optional.
 */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}
