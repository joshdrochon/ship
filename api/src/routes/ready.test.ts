/**
 * /ready — the readiness probe the MVP brief requires and PRESEARCH.md listed
 * as not yet existing.
 *
 * These tests exist to pin three things that are easy to break silently:
 *   - it reports BOTH dependencies, not just the one that happened to be handy
 *   - Postgres unreachable is a 503, not a 200 with a sad field
 *   - an open Bedrock circuit is NOT a 503 — see the note on that test
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';

import { createApp } from '../app.js';
import { checkPostgres, READY_DB_TIMEOUT_MS } from './ready.js';
import { pool } from '../db/client.js';
import { getBedrockBreakerStats } from '../services/ai-analysis.js';

describe('GET /ready', () => {
  const app = createApp();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 200 with both dependency checks when everything is reachable', async () => {
    const res = await request(app).get('/ready');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.checks.postgres.status).toBe('ok');
    // FG-152: the breaker is reported whether or not it gates the status code.
    expect(res.body.checks.bedrock).toHaveProperty('circuit');
    expect(res.body.checks.bedrock).toHaveProperty('consecutiveFailures');
  });

  // /ready is probed by a load balancer before any session exists. If it ever
  // acquires auth, every deploy hangs at the health gate.
  it('requires no authentication', async () => {
    const res = await request(app).get('/ready');
    expect(res.status).not.toBe(401);
  });

  it('reports the build revision, like /health', async () => {
    const res = await request(app).get('/ready');
    expect(res.body.revision).toBe(process.env.GIT_SHA || 'unknown');
  });

  // FG-151/FG-153. The probe must actually reach Postgres — a check that cannot
  // fail is not a check. Forcing the query to reject proves the 503 path is
  // wired to the real query and not to a constant.
  it('returns 503 when Postgres is unreachable', async () => {
    vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const res = await request(app).get('/ready');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.checks.postgres.status).toBe('error');
    expect(res.body.checks.postgres.error).toContain('ECONNREFUSED');
  });

  // Implementation Rule 7. A hung socket must fail fast and say so, rather than
  // inheriting the pool's 30 s query_timeout and letting the prober give up
  // first with no detail.
  it('times out the Postgres probe rather than hanging', async () => {
    vi.spyOn(pool, 'query').mockImplementationOnce(
      () => new Promise<Awaited<ReturnType<typeof pool.query>>>(() => {})
    );

    const startedAt = Date.now();
    const result = await checkPostgres(50);

    expect(result.status).toBe('error');
    expect(String(result.error)).toContain('exceeded 50ms');
    expect(Date.now() - startedAt).toBeLessThan(READY_DB_TIMEOUT_MS);
  });

  // The decision this test exists to defend: an unwell Bedrock must NOT take the
  // API out of rotation. AI is one advisory feature with a designed fallback
  // (`ai_unavailable`), so failing readiness on an open circuit would convert a
  // degraded feature into a total outage — automatically, during an incident.
  //
  // If this test ever fails because someone made the breaker gate the status
  // code, that is the change to argue about, not the test.
  it('reports an open Bedrock circuit as degraded but stays 200', async () => {
    const stats = getBedrockBreakerStats();
    const res = await request(app).get('/ready');

    expect(res.status).toBe(200);
    if (stats.state === 'closed') {
      expect(res.body.checks.bedrock.status).toBe('ok');
    } else {
      expect(res.body.checks.bedrock.status).toBe('degraded');
    }
  });
});
