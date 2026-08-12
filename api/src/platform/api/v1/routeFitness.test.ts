/**
 * L07 S5 — MVP gate item 5: the envelope asserted over ALL /api/v1 routes.
 *
 * PF-200 (enumerator), PF-201 (envelope on every route), PF-202 (seams for the
 * other three Testing Scenario 4 clauses), PF-203 (one negative case per code).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express, { Router } from 'express';
import {
  enumerateV1Routes,
  registerRouteAssertion,
  listRouteAssertions,
  clearRouteAssertions,
  runRouteAssertions,
} from './routeFitness.js';
import { registerEnvelopeAssertions, concretePath } from './envelopeAssertion.js';
import { createTestPublicApp, fakeAuthContext, V1_PREFIX } from './testSupport.js';
import { asyncRoute } from './errorMiddleware.js';
import { ApiError, apiErrorBodySchema, API_ERROR_CODES, type ApiErrorCode } from './errors.js';
import { InMemoryTokenBucket } from '../../ratelimit/limiter.js';
import { requireScope } from '../../scopes/registry.js';

/** A believable resource surface, standing in for L08–L16's routes. */
const mountSampleResources = (router: Router): void => {
  router.get('/me', asyncRoute(async (_req, res) => {
    await Promise.resolve();
    res.json({ data: { id: 'user_test' } });
  }));
  router.get('/documents', asyncRoute(async (_req, res) => {
    await Promise.resolve();
    res.json({ data: [], next_cursor: null });
  }));
  router.get('/documents/:id', asyncRoute(async (_req, res) => {
    await Promise.resolve();
    res.json({ data: { id: 'doc_1' } });
  }));
  router.post('/documents', asyncRoute(async (_req, res) => {
    await Promise.resolve();
    res.status(201).json({ data: { id: 'doc_1' } });
  }));

  // A NESTED router — the enumerator must descend into it, and the mount path
  // has to be recovered from the RegExp Express compiled it into.
  const webhooks = Router();
  webhooks.get('/subscriptions', asyncRoute(async (_req, res) => {
    await Promise.resolve();
    res.json({ data: [], next_cursor: null });
  }));
  webhooks.post('/subscriptions', asyncRoute(async (_req, res) => {
    await Promise.resolve();
    res.status(201).json({ data: {} });
  }));
  webhooks.post('/deliveries/:deliveryId/replay', asyncRoute(async (_req, res) => {
    await Promise.resolve();
    res.status(202).json({ data: {} });
  }));
  router.use('/webhooks', webhooks);
};

describe('PF-200 — enumerateV1Routes walks the live app', () => {
  it('finds every route, including inside a nested router', () => {
    const { app } = createTestPublicApp({ mountResources: mountSampleResources });
    const found = enumerateV1Routes(app).map((r) => `${r.method} ${r.path}`);

    expect(found).toEqual(
      expect.arrayContaining([
        `GET ${V1_PREFIX}/me`,
        `GET ${V1_PREFIX}/documents`,
        `GET ${V1_PREFIX}/documents/:id`,
        `POST ${V1_PREFIX}/documents`,
        `GET ${V1_PREFIX}/webhooks/subscriptions`,
        `POST ${V1_PREFIX}/webhooks/subscriptions`,
        `POST ${V1_PREFIX}/webhooks/deliveries/:deliveryId/replay`,
      ]),
    );
  });

  it('reports GET and POST on one path as two routes', () => {
    const { app } = createTestPublicApp({ mountResources: mountSampleResources });
    const documents = enumerateV1Routes(app).filter((r) => r.path === `${V1_PREFIX}/documents`);
    expect(documents.map((r) => r.method).sort()).toEqual(['GET', 'POST']);
  });

  it('IS NOT STALE-ABLE: a brand-new route appears with no edit to the harness', () => {
    // PF-200's actual criterion. The route below did not exist when the
    // enumerator was written and the enumerator was not touched to accommodate
    // it — which is the property every other lane is relying on.
    const { app } = createTestPublicApp({
      mountResources: (router) => {
        mountSampleResources(router);
        router.patch('/a-route-invented-after-the-harness', asyncRoute(async (_req, res) => {
          await Promise.resolve();
          res.json({ data: {} });
        }));
      },
    });

    const found = enumerateV1Routes(app).map((r) => `${r.method} ${r.path}`);
    expect(found).toContain(`PATCH ${V1_PREFIX}/a-route-invented-after-the-harness`);
  });

  it('excludes routes outside the /api/v1 prefix', () => {
    const { app } = createTestPublicApp({ mountResources: mountSampleResources });
    app.get('/health', (_req, res) => {
      res.json({ ok: true });
    });
    app.get('/api/documents', (_req, res) => {
      res.json({ internal: true });
    });

    const paths = enumerateV1Routes(app).map((r) => r.path);
    expect(paths).not.toContain('/health');
    expect(paths).not.toContain('/api/documents');
    expect(paths.every((p) => p.startsWith(`${V1_PREFIX}/`))).toBe(true);
  });

  it('returns an empty list for an app with no resources — the vacuous case', () => {
    // Not a passing state for PF-201; see the guard there.
    const { app } = createTestPublicApp();
    expect(enumerateV1Routes(app)).toEqual([]);
  });
});

describe('PF-201 — every enumerated route ships the envelope on a failure path', () => {
  beforeEach(() => {
    clearRouteAssertions();
    registerEnvelopeAssertions();
  });
  afterEach(() => {
    clearRouteAssertions();
  });

  it('FAILS LOUDLY when the enumeration is empty', () => {
    // The failure mode that makes this whole lane theatre: a harness that
    // enumerates nothing asserts nothing and reports green. This is the guard
    // every consuming spec must copy.
    const { app } = createTestPublicApp();
    const routes = enumerateV1Routes(app);
    expect(
      routes.length === 0,
      'sanity check: an app with no resources really does enumerate empty',
    ).toBe(true);

    // ...so the real spec asserts non-emptiness before believing a pass.
    const { app: withRoutes } = createTestPublicApp({ mountResources: mountSampleResources });
    expect(
      enumerateV1Routes(withRoutes).length,
      'route enumeration is empty — the fitness test would pass vacuously',
    ).toBeGreaterThan(0);
  });

  it('holds for all 7 sample routes', async () => {
    const { app } = createTestPublicApp({
      auth: null,
      mountResources: mountSampleResources,
    });

    const routes = enumerateV1Routes(app);
    expect(routes.length, 'enumeration is empty — refusing to pass vacuously').toBeGreaterThan(0);

    const failures = await runRouteAssertions(app);
    expect(
      failures.map((f) => `${f.assertion} · ${f.route}: ${f.error.message}`),
    ).toEqual([]);
  });

  it('CATCHES a v1 route mounted OUTSIDE the public router', async () => {
    // Proves the assertion can fail — an assertion that has never failed is an
    // assertion nobody has tested.
    //
    // This is the realistic drift, and it is worth being precise about what
    // clause (c) does and does not catch. Routes registered through
    // `mountResources` sit BELOW bearer auth, so an anonymous request is
    // rejected by the shared stack before their handler runs; for those, the
    // clause proves the stack behaves, not that each handler does. What it
    // genuinely catches is a route that bypasses the stack altogether — mounted
    // straight onto the app under /api/v1, which is how the envelope would
    // actually get lost in a hurry.
    const { app } = createTestPublicApp({ auth: null, mountResources: mountSampleResources });

    // Mounted after the public router, so a path the router does not know about
    // still reaches it... except the router's catch-all answers first. Use a
    // path the router WOULD 404, and register it on the app ahead of the router
    // by rebuilding the stack in the other order.
    const rogue = express();
    rogue.get(`${V1_PREFIX}/rogue`, (_req, res) => {
      res.status(500).json({ error: 'Internal server error' });
    });
    rogue.use(app);

    const failures = await runRouteAssertions(rogue);
    expect(failures.length, 'a route bypassing the public stack went undetected').toBeGreaterThan(0);
    expect(failures.some((f) => f.route === `GET ${V1_PREFIX}/rogue`)).toBe(true);
  });

  it('CATCHES an unwrapped async handler (PF-195 at build time)', async () => {
    const { app } = createTestPublicApp({
      auth: null,
      mountResources: (router) => {
        // No asyncRoute() — Express 4 would drop its rejections.
        router.get('/unwrapped', async (_req, res) => {
          await Promise.resolve();
          res.json({ data: {} });
        });
      },
    });

    const failures = await runRouteAssertions(app);
    expect(failures.some((f) => f.assertion.includes('async'))).toBe(true);
  });

  it('substitutes :params so the request actually routes', () => {
    expect(concretePath(`${V1_PREFIX}/documents/:id`)).toBe(
      `${V1_PREFIX}/documents/00000000-0000-4000-8000-000000000000`,
    );
  });
});

describe('PF-202 — the seam L03, L08 and L13 bolt onto', () => {
  beforeEach(() => {
    clearRouteAssertions();
  });
  afterEach(() => {
    clearRouteAssertions();
  });

  it('runs a registered assertion against every route', async () => {
    const seen: string[] = [];
    registerRouteAssertion('no-op: proves the seam runs', ({ route }) => {
      seen.push(`${route.method} ${route.path}`);
    });

    const { app } = createTestPublicApp({ mountResources: mountSampleResources });
    const failures = await runRouteAssertions(app);

    expect(failures).toEqual([]);
    expect(seen.length).toBe(enumerateV1Routes(app).length);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('reports which clause failed and on which route', async () => {
    registerRouteAssertion('L13 (a): every route has an OpenAPI entry', ({ route }) => {
      if (route.path.endsWith('/me')) throw new Error('no OpenAPI entry');
    });

    const { app } = createTestPublicApp({ mountResources: mountSampleResources });
    const failures = await runRouteAssertions(app);

    expect(failures).toHaveLength(1);
    expect(failures[0]!.assertion).toContain('L13');
    expect(failures[0]!.route).toBe(`GET ${V1_PREFIX}/me`);
    expect(failures[0]!.error.message).toBe('no OpenAPI entry');
  });

  it('supports an async assertion (a clause may issue real requests)', async () => {
    registerRouteAssertion('async clause', async ({ route, app }) => {
      const res = await request(app).get(concretePath(route.path));
      if (res.status === 0) throw new Error('unreachable');
    });

    const { app } = createTestPublicApp({ mountResources: mountSampleResources });
    expect(await runRouteAssertions(app)).toEqual([]);
  });

  it('re-registering a name replaces rather than duplicates', () => {
    registerRouteAssertion('same-name', () => {});
    registerRouteAssertion('same-name', () => {});
    expect(listRouteAssertions().filter((a) => a.name === 'same-name')).toHaveLength(1);
  });

  it('the harness documents an owning lane for all four clauses', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      fileURLToPath(new URL('./routeFitness.ts', import.meta.url)),
      'utf8',
    );
    for (const lane of ['L03', 'L07', 'L08', 'L13']) {
      expect(source, `the clause table must name ${lane}`).toContain(lane);
    }
  });
});

describe('PF-203 — one negative case per code, produced by a real request', () => {
  /**
   * The coverage table. Every code must have either a live case below or an
   * explicit todo naming the lane that will produce it; the last test in this
   * block fails if any code has neither, so a code cannot silently go
   * unexercised.
   */
  const LIVE: ApiErrorCode[] = [
    'unauthorized',
    'forbidden',
    'not_found',
    'rate_limited',
    'server_error',
  ];
  const TODO: Partial<Record<ApiErrorCode, string>> = {
    // L09 owns the first route with a request body to validate. Until one
    // exists there is no honest end-to-end way to produce this code.
    validation_failed: 'L09 (resource: documents) — POST with an invalid body',
  };

  it('unauthorized — an anonymous request to a real route', async () => {
    const { app } = createTestPublicApp({ auth: null, mountResources: mountSampleResources });
    const res = await request(app).get(`${V1_PREFIX}/documents`).expect(401);
    expect(apiErrorBodySchema.safeParse(res.body).success).toBe(true);
    expect(res.body.code).toBe('unauthorized');
  });

  it('forbidden — an authenticated caller missing the scope (via requireScope)', async () => {
    // Live rather than a todo: L03's requireScope already exists, so a real
    // request can produce this today. The lane file expected a test.todo here.
    const { app } = createTestPublicApp({
      auth: fakeAuthContext(['issues:read']),
      mountResources: (router) => {
        router.get(
          '/documents',
          requireScope('documents:read'),
          asyncRoute(async (_req, res) => {
            await Promise.resolve();
            res.json({ data: [] });
          }),
        );
      },
    });

    const res = await request(app).get(`${V1_PREFIX}/documents`).expect(403);
    expect(apiErrorBodySchema.safeParse(res.body).success).toBe(true);
    expect(res.body.code).toBe('forbidden');
    // The full non-opaque 403 (gate item 6): what was missing, what the caller
    // has, and the registry's own prose for the scope.
    expect(res.body.details).toEqual({
      missing_scope: 'documents:read',
      granted_scopes: ['issues:read'],
      scope_description: 'Read documents',
    });
  });

  it('not_found — an unrouted path under /api/v1', async () => {
    const { app } = createTestPublicApp({ mountResources: mountSampleResources });
    const res = await request(app).get(`${V1_PREFIX}/no-such-thing`).expect(404);
    expect(apiErrorBodySchema.safeParse(res.body).success).toBe(true);
    expect(res.body.code).toBe('not_found');
  });

  it('rate_limited — a real second request against a capacity-1 bucket', async () => {
    // Live rather than a todo: the token bucket already exists. No fake timers —
    // the bucket is exhausted by real requests.
    const { app } = createTestPublicApp({
      perAppLimiter: new InMemoryTokenBucket({ capacity: 1, refillPerSecond: 0 }),
      mountResources: mountSampleResources,
    });

    await request(app).get(`${V1_PREFIX}/me`).expect(200);
    const res = await request(app).get(`${V1_PREFIX}/me`).expect(429);

    expect(apiErrorBodySchema.safeParse(res.body).success).toBe(true);
    expect(res.body.code).toBe('rate_limited');
  });

  it('server_error — a handler that throws for real', async () => {
    const { app } = createTestPublicApp({
      mountResources: (router) => {
        router.get(
          '/explodes',
          asyncRoute(async () => {
            await Promise.resolve();
            throw new Error('a real failure with a real stack');
          }),
        );
      },
    });

    const res = await request(app).get(`${V1_PREFIX}/explodes`).expect(500);
    expect(apiErrorBodySchema.safeParse(res.body).success).toBe(true);
    expect(res.body.code).toBe('server_error');
  });

  it.todo(`validation_failed — ${TODO.validation_failed}`);

  it('every code has either a live case or a named todo', () => {
    const covered = new Set<ApiErrorCode>([...LIVE, ...(Object.keys(TODO) as ApiErrorCode[])]);
    const uncovered = API_ERROR_CODES.filter((code) => !covered.has(code));
    expect(
      uncovered,
      `these codes have no negative test and no todo naming an owner: ${uncovered.join(', ')}`,
    ).toEqual([]);

    // A todo must name a lane, or it is a wish rather than a handoff.
    for (const [code, note] of Object.entries(TODO)) {
      expect(note, `todo for "${code}" does not name an owning lane`).toMatch(/L\d\d/);
    }
  });

  it('the live cases really do cover five distinct codes', async () => {
    // Guards against a copy-paste that leaves two tests asserting one code.
    expect(new Set(LIVE).size).toBe(5);
    expect(LIVE.every((c) => API_ERROR_CODES.includes(c))).toBe(true);
  });
});

describe('PF-201 — the ApiError instance carries a usable throw site', () => {
  it('a thrown ApiError keeps the stack of the code that threw it', () => {
    const err = new ApiError('not_found', 'x');
    expect(err.stack).toContain('routeFitness.test.ts');
  });
});
