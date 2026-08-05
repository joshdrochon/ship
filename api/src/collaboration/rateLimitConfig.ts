/**
 * WebSocket rate limits.
 *
 * Its own module, with no imports, for one reason: `collaboration/index.ts` pulls in
 * the database client at module load, so a test that imported these constants from
 * there needed a live Postgres to assert two numbers. A config assertion that can be
 * broken by a stopped container is a config assertion nobody trusts.
 *
 * ── Why the connection limit changes under test and the message limit does not ──
 *
 * Every Playwright worker connects from 127.0.0.1, so the whole E2E suite shares ONE
 * connection bucket. Each test opens two sockets — `/collaboration/{type}:{id}` and
 * `/events` — and the suite runs ~877 tests in ~21 minutes across 2 workers. That is
 * roughly 80 connections a minute against a production limit of 30.
 *
 * The suite therefore throttled itself. Past the 30th connection in any minute the
 * upgrade got `HTTP/1.1 429 Too Many Requests`, and whether that failed a test
 * depended on whether that test happened to need its socket — load-dependent,
 * non-deterministic, worse on the heavier specs. Exactly the shape of a flake, and
 * for a year the tests took the blame. One CI run logged 108 of them.
 *
 * It is also why raising CI from 2 workers to 3 made things worse rather than better
 * (measured: flaky 4 → 10). More workers, same IP, same 30-per-minute budget.
 *
 * `app.ts:114` already does this for the HTTP limiter — `isTestEnv ? 10000` — because
 * the same problem was hit there first. This is that fix, one file over.
 *
 * The message limit is deliberately left alone. It is per-connection rather than
 * per-IP, so parallel workers never contend for it, and a test that trips 50 messages
 * a second on a single socket is describing a real bug rather than a busy runner.
 */

// Same detection as app.ts:86. Duplicated rather than imported so this module keeps
// its zero-dependency property, which is the whole point of it existing.
const isTestEnv = process.env.NODE_ENV === 'test' || process.env.E2E_TEST === '1';

export const RATE_LIMIT = {
  /** Sliding window the connection limit is counted over. */
  CONNECTION_WINDOW_MS: 60_000,
  /** Max new connections per IP per window. Raised for tests, never in production. */
  MAX_CONNECTIONS_PER_IP: isTestEnv ? 10_000 : 30,
  /** Sliding window the message limit is counted over. */
  MESSAGE_WINDOW_MS: 1_000,
  /** Max messages per connection per window. Same in every environment. */
  MAX_MESSAGES_PER_SECOND: 50,
} as const;

/** Close a connection after this many rate-limit violations. */
export const RATE_LIMIT_VIOLATION_THRESHOLD = 50;
