import { describe, it, expect, vi, afterEach } from 'vitest'

/**
 * The WebSocket connection rate limit, and the two ways it goes wrong.
 *
 * ── What happened ────────────────────────────────────────────────────────────
 * `MAX_CONNECTIONS_PER_IP` was a flat 30 per minute in every environment. Every
 * Playwright worker connects from 127.0.0.1, so the whole E2E suite shared one
 * bucket: ~877 tests in ~21 minutes, two sockets each (`/collaboration/{id}` and
 * `/events`), roughly 80 connections a minute against a limit of 30.
 *
 * The suite rate-limited itself. Past the 30th connection in any minute the
 * upgrade got `HTTP/1.1 429 Too Many Requests`, and whether that failed a test
 * depended on whether that test happened to need its socket. One CI run logged
 * 108 of them alongside 1 failure and 8 flaky tests.
 *
 * That is also why raising CI from 2 workers to 3 made it worse rather than
 * better — measured at the time, flaky 4 → 10. More workers, same IP, same
 * 30-per-minute budget.
 *
 * ── Why this file exists rather than just the fix ────────────────────────────
 * Two opposite regressions are both one-line edits, and neither fails anything
 * else in the suite:
 *
 *   1. Someone deletes the ternary and keeps 30 everywhere. The flakes come
 *      back, get blamed on the tests again, and the next person adds retries.
 *   2. Someone deletes the ternary and keeps 10,000 everywhere, because it
 *      reads as tidier. Production silently loses connection-flood protection,
 *      and nothing anywhere reports it.
 *
 * The second is the dangerous one, so it is asserted explicitly against a
 * production environment rather than inferred.
 */

const PRODUCTION_LIMIT = 30

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function loadRateLimit(env: Record<string, string | undefined>) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  // rateLimitConfig.js, NOT index.js. index.js loads the database client at module
  // scope, so importing it here would make a two-number config assertion depend on a
  // running Postgres — see the header of rateLimitConfig.ts.
  const mod = await import('../rateLimitConfig.js')
  return mod.RATE_LIMIT
}

describe('WebSocket connection rate limit', () => {
  it('is raised under NODE_ENV=test so the suite cannot throttle itself', async () => {
    const rl = await loadRateLimit({ NODE_ENV: 'test', E2E_TEST: undefined })

    // The real requirement is "comfortably above what the suite generates", which
    // is ~80/minute today and grows with the suite. A specific number is asserted
    // rather than `> 80` so that halving it is a visible change, not a silent one.
    expect(rl.MAX_CONNECTIONS_PER_IP).toBe(10_000)
  })

  it('is raised under E2E_TEST=1 even when NODE_ENV is not test', async () => {
    // The E2E harness sets NODE_ENV=test (e2e/fixtures/isolated-env.ts), but the
    // flag is honoured independently so a runner that sets only E2E_TEST is not
    // silently throttled.
    const rl = await loadRateLimit({ NODE_ENV: 'development', E2E_TEST: '1' })

    expect(rl.MAX_CONNECTIONS_PER_IP).toBe(10_000)
  })

  it('stays at 30 in production — the raise must never become global', async () => {
    const rl = await loadRateLimit({ NODE_ENV: 'production', E2E_TEST: undefined })

    expect(rl.MAX_CONNECTIONS_PER_IP).toBe(PRODUCTION_LIMIT)
  })

  it('stays at 30 in development, which is not a test environment', async () => {
    const rl = await loadRateLimit({ NODE_ENV: 'development', E2E_TEST: undefined })

    expect(rl.MAX_CONNECTIONS_PER_IP).toBe(PRODUCTION_LIMIT)
  })

  it('leaves the per-connection message limit alone in every environment', async () => {
    // Deliberately NOT raised for tests. It is per-connection rather than per-IP,
    // so parallel workers never contend for it, and a test that trips 50 messages
    // a second on one socket is describing a real bug rather than a busy runner.
    for (const env of [
      { NODE_ENV: 'test', E2E_TEST: undefined },
      { NODE_ENV: 'production', E2E_TEST: undefined },
      { NODE_ENV: 'development', E2E_TEST: '1' },
    ]) {
      const rl = await loadRateLimit(env)
      expect(rl.MAX_MESSAGES_PER_SECOND).toBe(50)
      expect(rl.MESSAGE_WINDOW_MS).toBe(1_000)
    }
  })

  it('keeps the connection window at one minute, which the limits are stated against', async () => {
    const rl = await loadRateLimit({ NODE_ENV: 'production', E2E_TEST: undefined })

    // "30 per minute" is meaningless if the window moves. Asserted so a change to
    // the window forces a matching look at the limit.
    expect(rl.CONNECTION_WINDOW_MS).toBe(60_000)
  })
})
