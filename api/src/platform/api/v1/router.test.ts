/**
 * S1 — the fresh public router and its declared middleware order.
 *
 * PF-211 (fresh router, zero shared middleware), PF-212 (V1_MIDDLEWARE_ORDER is
 * checked against the live stack), PF-213 (audit above everything that can
 * terminate a request), PF-216 (the unauthenticated-path allowlist).
 *
 * PF-214 and PF-215 are defects in `createApp`, not in this router, so they have
 * their own specs beside `app.ts` — asserting them here would assert against a
 * stack that does not have the internal middleware in it.
 */
import { describe, it, expect } from 'vitest';
import express, { Router, type Request, type Response } from 'express';
import request from 'supertest';
import { createPublicRouter, V1_UNAUTHENTICATED_PATHS, isUnauthenticatedV1Path } from './router.js';
import {
  V1_MIDDLEWARE_ORDER,
  V1_LAYERS_BEFORE_RESOURCES,
  V1_LAYERS_AFTER_RESOURCES,
  V1_RESOURCES_REGION,
} from './middlewareOrder.js';
import { createTestPublicApp, fakeAuthContext, V1_PREFIX } from './testSupport.js';
import { InMemoryTokenBucket } from '../../ratelimit/limiter.js';
import { InMemoryAuditSink } from '../../audit/audit.js';
import { asyncRoute } from './errorMiddleware.js';
import { enumerateV1Routes } from './routeFitness.js';

/** Reads the layer names off a live router, in mount order. */
function layerNames(router: Router): string[] {
  const stack = (router as unknown as { stack: { name?: string }[] }).stack;
  return stack.map((layer) => layer.name ?? '');
}

function buildRouter(overrides: Partial<Parameters<typeof createPublicRouter>[0]> = {}): Router {
  const bucket = new InMemoryTokenBucket({ capacity: 1_000_000, refillPerSecond: 1_000_000 });
  return createPublicRouter({
    bearerAuth: (_req, res, next) => {
      res.locals.platformAuth = fakeAuthContext([]);
      next();
    },
    perAppLimiter: bucket,
    perTokenLimiter: bucket,
    auditSink: new InMemoryAuditSink(),
    ...overrides,
  });
}

describe('PF-212 — V1_MIDDLEWARE_ORDER is the contract, checked against the live stack', () => {
  it('the live router layers EQUAL the declared order (no resources mounted)', () => {
    const names = layerNames(buildRouter());
    expect(names).toEqual([...V1_LAYERS_BEFORE_RESOURCES, ...V1_LAYERS_AFTER_RESOURCES]);
  });

  it('the declared prefix and suffix still hold with resources mounted between them', () => {
    const names = layerNames(
      buildRouter({
        mountResources: (r) => {
          r.get(
            '/documents',
            asyncRoute((_req: Request, res: Response) => {
              res.json({ data: [], next_cursor: null });
            }),
          );
          r.use('/nested', Router());
        },
      }),
    );

    const before = names.slice(0, V1_LAYERS_BEFORE_RESOURCES.length);
    const after = names.slice(names.length - V1_LAYERS_AFTER_RESOURCES.length);

    expect(before).toEqual([...V1_LAYERS_BEFORE_RESOURCES]);
    expect(after).toEqual([...V1_LAYERS_AFTER_RESOURCES]);
  });

  it('NO platform middleware hides in the resources region', () => {
    // The one insertion a positional comparison cannot see: a `v1_`-named layer
    // smuggled in between rate_limit and not_found. Every platform layer carries
    // the prefix, so the region can be checked by name rather than by position.
    const names = layerNames(
      buildRouter({
        mountResources: (r) => {
          r.get('/documents', (_req, res) => res.json({ data: [], next_cursor: null }));
        },
      }),
    );
    const region = names.slice(
      V1_LAYERS_BEFORE_RESOURCES.length,
      names.length - V1_LAYERS_AFTER_RESOURCES.length,
    );
    expect(region.filter((n) => n.startsWith('v1_'))).toEqual([]);
  });

  it('ADDING A LAYER WITHOUT EDITING THE CONSTANT FAILS — the anti-vacuity proof', () => {
    // Reproduces the exact mistake the ticket exists to prevent: a lane mounts a
    // platform middleware into the stack and does not update the constant. If
    // this assertion ever stops failing, PF-212 has become decorative.
    const router = buildRouter();
    const stack = (router as unknown as { stack: unknown[] }).stack;
    const rogue = (_req: Request, _res: Response, next: () => void) => next();
    Object.defineProperty(rogue, 'name', { value: 'v1_rogue', configurable: true });
    // Splice it in where a careless `router.use()` before the catch-all would land.
    stack.splice(stack.length - 2, 0, { name: 'v1_rogue', handle: rogue });

    const names = layerNames(router);
    expect(names).not.toEqual([...V1_LAYERS_BEFORE_RESOURCES, ...V1_LAYERS_AFTER_RESOURCES]);
    const region = names.slice(
      V1_LAYERS_BEFORE_RESOURCES.length,
      names.length - V1_LAYERS_AFTER_RESOURCES.length,
    );
    expect(region.filter((n) => n.startsWith('v1_'))).not.toEqual([]);
  });

  it('every declared entry carries a reason — the constant answers p.13, not just p.12', () => {
    for (const entry of V1_MIDDLEWARE_ORDER) {
      expect(entry.why.length, `${entry.name} has no rationale`).toBeGreaterThan(40);
    }
    expect(V1_MIDDLEWARE_ORDER.map((e) => e.name)).toContain(V1_RESOURCES_REGION);
  });
});

describe('PF-213 — audit sits above every layer that can terminate a request', () => {
  it('audit is mounted before body_parser, bearer_auth and rate_limit', () => {
    const names = layerNames(buildRouter());
    const at = (n: string) => names.indexOf(n);
    expect(at('v1_audit')).toBeGreaterThan(at('v1_request_id'));
    expect(at('v1_audit')).toBeLessThan(at('v1_body_parser'));
    expect(at('v1_audit')).toBeLessThan(at('v1_bearer_auth'));
    expect(at('v1_audit')).toBeLessThan(at('v1_rate_limit'));
  });

  it('an UNAUTHENTICATED request produces exactly one audit record, status 401', async () => {
    const { app, auditSink } = createTestPublicApp({
      auth: null,
      mountResources: (r) => {
        r.get('/documents', (_req, res) => res.json({ data: [], next_cursor: null }));
      },
    });
    const res = await request(app).get(`${V1_PREFIX}/documents`);
    expect(res.status).toBe(401);
    expect(auditSink.records).toHaveLength(1);
    expect(auditSink.records[0]?.status).toBe(401);
    // PF-193: never the 'unknown' fallback.
    expect(auditSink.records[0]?.requestId).not.toBe('unknown');
    expect(auditSink.records[0]?.requestId).toBe(res.body.request_id);
  });

  it('a request that EXHAUSTS THE BUCKET produces one audit record, status 429', async () => {
    const oneShot = new InMemoryTokenBucket({ capacity: 1, refillPerSecond: 0.0001 });
    const { app, auditSink } = createTestPublicApp({
      perAppLimiter: oneShot,
      mountResources: (r) => {
        r.get('/documents', (_req, res) => res.json({ data: [], next_cursor: null }));
      },
    });
    await request(app).get(`${V1_PREFIX}/documents`);
    const throttled = await request(app).get(`${V1_PREFIX}/documents`);

    expect(throttled.status).toBe(429);
    expect(auditSink.records).toHaveLength(2);
    expect(auditSink.records[1]?.status).toBe(429);
    expect(auditSink.records[1]?.requestId).not.toBe('unknown');
  });

  it('an OVERSIZED BODY is audited too — the 413 the ticket order would have missed', async () => {
    // The reason `v1_audit` is above `v1_body_parser` and not below it. The
    // parser rejects by calling next(err), which skips every remaining non-error
    // layer; with audit below it, this 413 would leave no record at all.
    const { app, auditSink } = createTestPublicApp({
      mountResources: (r) => {
        r.post('/documents', (_req, res) => res.status(201).json({ data: {} }));
      },
    });
    const res = await request(app)
      .post(`${V1_PREFIX}/documents`)
      .set('content-type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(2 * 1024 * 1024) }));

    // 422, not 413: the code set is closed at six and the status derives from the
    // code. What matters is that it is a CLIENT error carrying the envelope, not
    // a scrubbed 500 an SDK would retry forever. See bodyErrors.ts.
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.details.fields[0].field).toBe('body');
    expect(auditSink.records).toHaveLength(1);
    expect(auditSink.records[0]?.status).toBe(422);
  });

  it('MALFORMED JSON is a client error too, not a 500', async () => {
    const { app } = createTestPublicApp({
      mountResources: (r) => {
        r.post('/documents', (_req, res) => res.status(201).json({ data: {} }));
      },
    });
    const res = await request(app)
      .post(`${V1_PREFIX}/documents`)
      .set('content-type', 'application/json')
      .send('{"title": ');

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
  });
});

describe('PF-211 — a FRESH router: zero middleware shared with internal /api', () => {
  it('a valid Ship session cookie with no bearer token still gets 401', async () => {
    const { app } = createTestPublicApp({
      auth: null,
      mountResources: (r) => {
        r.get('/documents', (_req, res) => res.json({ data: [], next_cursor: null }));
      },
    });
    const res = await request(app)
      .get(`${V1_PREFIX}/documents`)
      // A session cookie shaped exactly like the internal one. If any part of the
      // session/CSRF stack were in this router, this request would be treated as
      // authenticated instead of rejected.
      .set('Cookie', ['connect.sid=s%3Aabcdef.signature; Path=/; HttpOnly'])
      .set('X-CSRF-Token', 'whatever');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
  });

  it('csrfSynchronisedProtection is absent from the v1 router stack, BY NAME', () => {
    const names = layerNames(buildRouter());
    for (const forbidden of [
      'csrfSynchronisedProtection',
      'conditionalCsrf',
      'session',
      'cookieParser',
      'expressInit',
    ]) {
      expect(names, `${forbidden} must not be in the public stack`).not.toContain(forbidden);
    }
  });

  it('the router is a NEW Router instance per call — no shared mutable stack', () => {
    const a = buildRouter();
    const b = buildRouter();
    expect(a).not.toBe(b);
    (a as unknown as { stack: unknown[] }).stack.push({ name: 'contaminant' });
    expect(layerNames(b)).not.toContain('contaminant');
  });
});

describe('PF-216 — /api/v1/openapi.json is reachable with NO Authorization header', () => {
  const mountSpec = (r: Router): void => {
    r.get('/openapi.json', (_req, res) => {
      res.json({ openapi: '3.1.0', paths: {} });
    });
  };

  it('the spec answers 200 + application/json anonymously', async () => {
    const { app } = createTestPublicApp({ auth: null, mountUnauthenticated: mountSpec });
    const res = await request(app).get(`${V1_PREFIX}/openapi.json`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.openapi).toBe('3.1.0');
  });

  it('a resource route with no header still gets 401 — the exception is not a hole', async () => {
    const { app } = createTestPublicApp({
      auth: null,
      mountUnauthenticated: mountSpec,
      mountResources: (r) => {
        r.get('/documents', (_req, res) => res.json({ data: [], next_cursor: null }));
      },
    });
    const res = await request(app).get(`${V1_PREFIX}/documents`);
    expect(res.status).toBe(401);
  });

  it('the spec is INSIDE the v1 stack — it carries request_id and an audit row', async () => {
    // The reason PF-216 rejects mounting the spec outside the router. If it were
    // mounted on the app, both of these would be absent on the single most
    // frequently fetched public endpoint.
    const { app, auditSink } = createTestPublicApp({ auth: null, mountUnauthenticated: mountSpec });
    const res = await request(app).get(`${V1_PREFIX}/openapi.json`);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(auditSink.records).toHaveLength(1);
    expect(auditSink.records[0]?.status).toBe(200);
    expect(auditSink.records[0]?.requestId).toBe(res.headers['x-request-id']);
  });

  it('the allowlist is exact-match, not a prefix — /openapi.json.bak is not exempt', () => {
    expect(isUnauthenticatedV1Path('/api/v1/openapi.json')).toBe(true);
    expect(isUnauthenticatedV1Path('/api/v1/openapi.json.bak')).toBe(false);
    expect(isUnauthenticatedV1Path('/api/v1/openapi')).toBe(false);
    expect(isUnauthenticatedV1Path('/api/v1/documents')).toBe(false);
  });

  it('every listed path is enumerable — the list cannot name a route that does not exist', () => {
    const { app } = createTestPublicApp({ auth: null, mountUnauthenticated: mountSpec });
    const enumerated = enumerateV1Routes(app).map((r) => r.path);
    for (const path of V1_UNAUTHENTICATED_PATHS) {
      expect(enumerated, `${path} is declared unauthenticated but is not mounted`).toContain(path);
    }
  });
});

describe('PF-234 — exactly one version prefix', () => {
  it('no registered route path contains a second version segment', () => {
    const { app } = createTestPublicApp({
      mountResources: (r) => {
        r.get('/documents', (_req, res) => res.json({ data: [], next_cursor: null }));
        r.get('/issues/:id', (_req, res) => res.json({ data: {} }));
      },
    });
    for (const route of enumerateV1Routes(app)) {
      const versionSegments = route.path.split('/').filter((s) => /^v\d+$/.test(s));
      expect(versionSegments, `${route.path} has more than one version segment`).toHaveLength(1);
      expect(route.path.startsWith(`${V1_PREFIX}/`) || route.path === V1_PREFIX).toBe(true);
    }
  });

  it('the public router is mounted at ONE prefix on the app', () => {
    const app = express();
    app.use(V1_PREFIX, buildRouter());
    const stack = (app as unknown as { _router?: { stack: { regexp?: RegExp }[] } })._router?.stack
      ?? (app as unknown as { router: { stack: { regexp?: RegExp }[] } }).router.stack;
    const v1Mounts = stack.filter((l) => l.regexp?.source.includes('v1'));
    expect(v1Mounts).toHaveLength(1);
  });
});
