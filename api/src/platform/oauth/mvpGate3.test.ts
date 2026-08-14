/**
 * PF-163 — MVP GATE ITEM 3, asserted as ONE test.
 *
 * PRD p.2, read literally:
 *
 *   "Bearer token middleware validates tokens on every /api/v1/* route; invalid
 *    tokens return 401, missing tokens return 401, expired tokens return 401
 *    with a distinct error code."
 *
 * Four clauses plus an enumeration claim. They are asserted in ONE `it` on
 * purpose: split across four, a partial pass can be reported as a pass, and the
 * gate is a checkbox a grader ticks once. Either the whole thing holds or the
 * test is red.
 *
 * This is the item a grader can check with four `curl`s. It is jointly L08's —
 * the router composition is theirs, the middleware is this lane's.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ROUTES HERE ARE MOUNTED BY THE TEST.
 * ---------------------------------------------------------------------------
 * The ticket names `GET /api/v1/documents`, which belongs to L10 and does not
 * exist yet — L08's branch is empty and L09/L10 have not landed. Rather than
 * invent another lane's routes, this test mounts throwaway ones through
 * `createPublicRouter`'s `mountResources` hook, which is the seam L07 documents
 * for exactly this. The middleware, the router, the ordering and the envelope
 * under test are all the real ones; only the resource handlers are stand-ins.
 *
 * When L10 lands, its routes are enumerated by the same walk with no edit here —
 * that is the point of enumerating from the live app rather than from a list.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Router } from 'express';
import {
  runRouteAssertions,
  enumerateV1Routes,
  clearRouteAssertions,
} from '../api/v1/routeFitness.js';
import { registerEnvelopeAssertions } from '../api/v1/envelopeAssertion.js';
import { registerBearerAssertions } from './bearerFitness.js';
import { createBearerTestApp } from './bearerTestSupport.js';

/**
 * Stand-ins for the resource surface L09/L10 will mount. Several routes and
 * several methods, so the enumeration claim has something to enumerate.
 */
const mountResources = (router: Router): void => {
  router.get('/documents', (_req, res) => res.json({ data: [], next_cursor: null }));
  router.post('/documents', (_req, res) => res.status(201).json({ id: 'doc-1' }));
  router.get('/documents/:id', (_req, res) => res.json({ id: 'doc-1' }));
  router.get('/me', (_req, res) => res.json(res.locals.platformAuth));
  router.get('/issues', (_req, res) => res.json({ data: [], next_cursor: null }));
};

beforeEach(() => {
  clearRouteAssertions();
});

afterEach(() => {
  clearRouteAssertions();
});

describe('MVP gate item 3 (PRD p.2)', () => {
  it('missing → 401 · invalid → 401 · expired → 401 with a distinct reason · live → 200, on EVERY /api/v1 route', async () => {
    // A 2-second access TTL so expiry is produced by configuration, never by
    // waiting (PF-173; PRD p.11 rules out sleeps, p.9 budgets zero flake).
    const harness = await createBearerTestApp({
      mountResources,
      ttl: { accessSeconds: 2, refreshSeconds: 300 },
      scopes: ['documents:read'],
    });

    // ── (a) NO Authorization header → 401 ────────────────────────────────
    const missing = await request(harness.app).get('/api/v1/documents');
    expect(missing.status, 'no Authorization header must be 401').toBe(401);
    expect(missing.body.code).toBe('unauthorized');
    expect(missing.body.details).toEqual({ reason: 'missing' });

    // ── (b) a garbage token → 401 ────────────────────────────────────────
    const garbage = await request(harness.app)
      .get('/api/v1/documents')
      .set('Authorization', 'Bearer ship_at_this-matches-no-row-at-all');
    expect(garbage.status, 'a garbage token must be 401').toBe(401);
    expect(garbage.body.code).toBe('unauthorized');
    expect(garbage.body.details).toEqual({ reason: 'invalid' });

    // ── (d) a LIVE token → 200 ───────────────────────────────────────────
    // Asserted before the clock advances, and it is what stops (a)–(c) passing
    // vacuously because everything 401s.
    const tokens = await harness.mint();
    const live = await request(harness.app)
      .get('/api/v1/documents')
      .set('Authorization', `Bearer ${tokens.access_token}`);
    expect(live.status, 'a live token must be 200').toBe(200);

    // ── (c) an EXPIRED token → 401 with a DISTINCT reason ────────────────
    harness.clock.advance(3000);
    const expired = await request(harness.app)
      .get('/api/v1/documents')
      .set('Authorization', `Bearer ${tokens.access_token}`);
    expect(expired.status, 'an expired token must be 401').toBe(401);
    expect(expired.body.code).toBe('unauthorized');
    expect(expired.body.details).toEqual({ reason: 'expired' });

    // …and the expired reason is DISTINCT from the other two. This is the
    // clause "expired tokens return 401 with a distinct error code" cashes out
    // to, given B14 put the distinction in `details.reason` rather than in a
    // seventh ApiErrorCode.
    const reasons = [
      missing.body.details.reason,
      garbage.body.details.reason,
      expired.body.details.reason,
    ];
    expect(new Set(reasons).size, 'the three reasons must be pairwise distinct').toBe(3);
    expect(reasons).toEqual(['missing', 'invalid', 'expired']);

    // ── "EVERY" — the enumeration half ──────────────────────────────────
    const routes = enumerateV1Routes(harness.app);
    // A harness that enumerates nothing asserts nothing and reports green.
    expect(routes.length, 'the enumerator must find the mounted routes').toBeGreaterThanOrEqual(5);

    registerEnvelopeAssertions();
    registerBearerAssertions();
    const failures = await runRouteAssertions(harness.app);
    expect(
      failures.map((f) => `${f.route} — ${f.assertion}: ${f.error.message}`),
      'every mounted /api/v1 route must sit behind bearer auth',
    ).toEqual([]);
  });

  it('a route added later inherits the gate with no edit to this test', async () => {
    // The anti-staleness direction. A lane that mounts a new route and forgets
    // about auth must fail CI unaided — which only works if the enumerator reads
    // the live app rather than a hand-maintained list.
    const harness = await createBearerTestApp({
      mountResources: (router) => {
        mountResources(router);
        router.get('/a-route-nobody-told-the-gate-about', (_req, res) => res.json({ ok: true }));
      },
    });

    const routes = enumerateV1Routes(harness.app);
    expect(routes.map((r) => r.path)).toContain('/api/v1/a-route-nobody-told-the-gate-about');

    registerBearerAssertions();
    const failures = await runRouteAssertions(harness.app);
    expect(failures).toEqual([]);

    // And it really is protected, not merely enumerated.
    const res = await request(harness.app).get('/api/v1/a-route-nobody-told-the-gate-about');
    expect(res.status).toBe(401);
  });

  it('the clause is not vacuous — an app that authenticates everyone FAILS it', async () => {
    // A fitness test nobody has watched fail is a fitness test nobody should
    // believe. L07's `createTestPublicApp` installs a bearer-auth STUB that
    // attaches a fake context to every caller and never 401s — which is exactly
    // the shape of the bug this clause exists to catch, and a more realistic one
    // than an unreachable route: it is what happens if someone "simplifies" the
    // middleware into always calling `next()`.
    const { createTestPublicApp } = await import('../api/v1/testSupport.js');
    const stubbed = createTestPublicApp({ mountResources });

    registerBearerAssertions();
    const failures = await runRouteAssertions(stubbed.app);

    expect(failures.length, 'an always-authenticating app must fail the clause').toBeGreaterThan(0);
    // Every enumerated route should be reported, not just the first.
    expect(failures.some((f) => f.route.includes('/api/v1/documents'))).toBe(true);
    expect(failures.every((f) => /expected 401|expected details\.reason/.test(f.error.message))).toBe(
      true,
    );
  });
});
