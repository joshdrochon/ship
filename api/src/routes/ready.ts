/**
 * GET /ready — readiness, as distinct from liveness.
 *
 * Required by the MVP brief and listed in PRESEARCH.md's open items as
 * "required by MVP, does not exist yet". This is that endpoint.
 *
 * ── Why /health was not enough ──────────────────────────────────────────────
 * `/health` answers "is this process running and which commit is it" without
 * touching anything. That is the right answer for a liveness probe: a restart
 * fixes a dead process, and making liveness depend on the database means a
 * database blip restarts every healthy container, which is strictly worse than
 * the blip. `/ready` answers the different question — "can this process serve a
 * request right now" — and to answer it honestly it must actually reach its
 * dependencies. Two questions, two endpoints, deliberately.
 *
 * ── What makes it 503, and what does not (FG-153) ───────────────────────────
 *   Postgres unreachable  → 503. Every route in Ship queries it. A process that
 *                           cannot reach the database can serve nothing, and
 *                           should be taken out of rotation.
 *   Bedrock breaker open  → 200, `degraded`. NOT a 503, and this is a decision
 *                           rather than an oversight. AI is one advisory
 *                           feature with a designed-in fallback: `ai-analysis`
 *                           already answers `ai_unavailable` and the UI already
 *                           renders it. Failing readiness on an open breaker
 *                           would pull every container out of rotation because
 *                           an optional feature is unwell — converting a
 *                           degraded feature into a total outage, and doing it
 *                           automatically, at the worst possible moment.
 *
 * The breaker state is still REPORTED, because the point of a readiness probe
 * with checks in it is to be the first thing an operator curls. Reporting it
 * without gating on it is the useful half.
 *
 * ── Unauthenticated, like /health ───────────────────────────────────────────
 * A load balancer probes this before any session exists. Nothing here is a
 * secret: a boolean about the database, a circuit state, and the commit SHA —
 * which `/health` already publishes for the same reason.
 *
 * ── Timeout (Implementation Rule 7) ─────────────────────────────────────────
 * The Postgres probe races an explicit timeout. Without one, a readiness check
 * against a half-open connection inherits the pool's 30 s `query_timeout`,
 * which is far longer than any prober's own patience — so the prober times out
 * first and reports "unreachable" with no detail, and the container is killed
 * for a reason nobody can see. Failing fast and saying WHY is the whole job.
 * No retry, deliberately: a readiness probe is already polled on a schedule, so
 * a retry inside one call just delays the answer the next poll would give.
 */
import { Router, Request, Response } from 'express';

import { pool } from '../db/client.js';
import { getBedrockBreakerStats } from '../services/ai-analysis.js';

type RouterType = ReturnType<typeof Router>;
const router: RouterType = Router();

/**
 * How long the database gets to answer `SELECT 1` before it counts as
 * unreachable. Short on purpose — this is a liveness question about a socket,
 * not a query anyone is waiting on.
 */
export const READY_DB_TIMEOUT_MS = 2_000;

const revision = process.env.GIT_SHA || 'unknown';

export interface DependencyCheck {
  status: 'ok' | 'degraded' | 'error';
  [key: string]: unknown;
}

/** FG-151 · Postgres connectivity, with its own timeout. */
export async function checkPostgres(
  timeoutMs: number = READY_DB_TIMEOUT_MS
): Promise<DependencyCheck> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`postgres probe exceeded ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
    return { status: 'ok', latencyMs: Date.now() - startedAt };
  } catch (err) {
    return {
      status: 'error',
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : 'unknown error',
    };
  } finally {
    // Without this the timer keeps the event loop alive for its full duration
    // after a fast success — harmless in a server, but it hangs vitest.
    if (timer) clearTimeout(timer);
  }
}

/**
 * FG-152 · Circuit-breaker state for the Bedrock client.
 *
 * `getBedrockBreakerStats` lives in `services/ai-analysis.ts`, which is where
 * the breaker instance is constructed — `services/circuitBreaker.ts` is the
 * generic class and holds no instance to report on.
 *
 * A half-open circuit reports `degraded` rather than `ok`: it means the last
 * cooldown elapsed and the next call is a probe, which an operator reading this
 * during an incident needs to see as "recovering", not as "fine".
 */
export function checkBedrockBreaker(): DependencyCheck {
  const stats = getBedrockBreakerStats();
  return {
    status: stats.state === 'closed' ? 'ok' : 'degraded',
    circuit: stats.state,
    consecutiveFailures: stats.consecutiveFailures,
  };
}

router.get('/ready', async (_req: Request, res: Response) => {
  const postgres = await checkPostgres();
  const bedrock = checkBedrockBreaker();

  // FG-153. Only a hard dependency gates the status code; see the header for
  // why an open Bedrock breaker is reported but not fatal.
  const ready = postgres.status !== 'error';

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    revision,
    checks: { postgres, bedrock },
  });
});

export default router;
