/**
 * PF-079 / PF-080 — Testing Scenario 4(b) (PRD p.5) and the negative matrix.
 *
 * PF-079: every `/api/v1` route declares a registered scope, or an explicit
 * null. Asserted against the real router *and* against fixture routers that
 * deliberately break each rule — because the real v1 router carries no resource
 * routes yet (they are L09's and L10's), so applying the check to it alone would
 * pass vacuously and keep passing until someone noticed. The fixtures prove the
 * mechanism bites; the real-router assertion is what starts biting the moment a
 * route lands.
 *
 * PF-080: four cases, four assertions, each one a different way a scope check
 * can be wrong.
 */
import { describe, it, expect, vi } from 'vitest';
import express, { Router, type RequestHandler } from 'express';
import request from 'supertest';
import { createPublicRouter } from '../platform/api/v1/router.js';
import { auditRouterScopes, mountedRoutes } from '../platform/api/v1/route-audit.js';
import { RouteScopeTable } from '../platform/scopes/route-metadata.js';
import { scopeRegistry, type Scope } from '../platform/scopes/scopes.js';
import { declareRoute, requireScope, PLATFORM_AUTH_LOCAL } from '../platform/scopes/require-scope.js';
import { validateRequestedScopes } from '../platform/scopes/validation.js';
import type { PlatformAuthContext } from '../platform/scopes/auth-context.js';
import { requestIdMiddleware, apiErrorMiddleware } from '../platform/api/v1/errors.js';
import type { IRateLimiter } from '../platform/ratelimit/limiter.js';
import type { IAuditSink } from '../platform/audit/audit.js';

function authContext(scopes: string[]): PlatformAuthContext {
  return {
    appId: 'app_test',
    clientId: 'client_test',
    userId: 'user_test',
    scopes: scopes as Scope[],
    tokenId: 'tok_test',
  };
}

/** A one-route app behind a guard, with the public error envelope. */
function guarded(guard: RequestHandler, scopes: string[]): express.Express {
  const app = express();
  app.use(requestIdMiddleware());
  app.use((_req, res, next) => {
    res.locals[PLATFORM_AUTH_LOCAL] = authContext(scopes);
    next();
  });
  app.get('/thing', guard, (_req, res) => res.json({ ok: true }));
  app.use(apiErrorMiddleware());
  return app;
}

describe('PF-079 · the fitness check catches what it claims to catch', () => {
  it('passes a router whose routes all declare a registered scope', () => {
    const table = new RouteScopeTable<Scope>();
    const router = Router();
    router.get(
      '/documents',
      declareRoute('documents:read', { method: 'get', path: '/documents' }, { registry: scopeRegistry, table }),
      (_req, res) => res.json({}),
    );

    expect(auditRouterScopes(router, { table })).toEqual([]);
  });

  it('fails a route mounted without going through declareRoute, and names it', () => {
    // The forgot case. Nothing in the declaration table knows this route exists,
    // which is why the check walks the router rather than the table.
    const table = new RouteScopeTable<Scope>();
    const router = Router();
    router.post('/documents', (_req, res) => res.json({}));

    const violations = auditRouterScopes(router, { table });

    expect(violations).toHaveLength(1);
    expect(violations[0]!.kind).toBe('undeclared');
    expect(violations[0]!.message).toContain('POST /documents');
  });

  it('fails a route that declared a scope nobody registered, with a different kind', () => {
    // Dispute B6's requirement, restated: "declared nothing" and "declared
    // something that does not exist" are different defects, and reporting both
    // as "missing scope" is what pushes someone toward `scope: null` to make CI
    // quiet. The table is written directly here because declareRoute would have
    // thrown at wiring time (PF-068) — this is the belt to that braces.
    const table = new RouteScopeTable<string>();
    table.declare({ method: 'get', path: '/plugins', scope: 'plugins:read' });
    const router = Router();
    router.get('/plugins', (_req, res) => res.json({}));

    const violations = auditRouterScopes(router, { table });

    expect(violations).toHaveLength(1);
    expect(violations[0]!.kind).toBe('unregistered');
    expect(violations[0]!.message).toContain('plugins:read');
    expect(violations[0]!.message).toContain('GET /plugins');
  });

  it('passes a route that declared scope: null, which is B6’s whole point', () => {
    // L10's PF-271. `GET /api/v1/me` resolves the token's own identity and
    // cannot require one of the seven scopes without making PF-062's
    // exactly-seven assertion false. It declares null, and that is a claim the
    // check honours — while still failing the route above that declared nothing.
    const table = new RouteScopeTable<Scope>();
    const router = Router();
    router.get(
      '/me',
      declareRoute(null, { method: 'get', path: '/me' }, { registry: scopeRegistry, table }),
      (_req, res) => res.json({}),
    );

    expect(auditRouterScopes(router, { table })).toEqual([]);
    expect(scopeRegistry.size).toBe(7);
  });

  it('tells the two failures apart on a router that has both', () => {
    const table = new RouteScopeTable<string>();
    table.declare({ method: 'get', path: '/a', scope: 'nope:nope' });
    const router = Router();
    router.get('/a', (_req, res) => res.json({}));
    router.get('/b', (_req, res) => res.json({}));

    const violations = auditRouterScopes(router, { table });

    expect(violations.map((v) => v.kind).sort()).toEqual(['undeclared', 'unregistered']);
  });

  it('sees routes inside a mounted sub-router', () => {
    const table = new RouteScopeTable<Scope>();
    const inner = Router();
    inner.get('/:id', (_req, res) => res.json({}));
    const outer = Router();
    outer.use('/documents', inner);

    expect(mountedRoutes(outer)).toEqual([{ method: 'get', path: '/:id' }]);
    expect(auditRouterScopes(outer, { table })).toHaveLength(1);
  });
});

describe('PF-079 · applied to the real public router', () => {
  const noopLimiter: IRateLimiter = {
    consume: () => ({ allowed: true, limit: 1000, remaining: 999, resetAt: new Date(0) }),
  } as unknown as IRateLimiter;
  const noopSink: IAuditSink = { record: async () => {} } as unknown as IAuditSink;

  const router = createPublicRouter({
    bearerAuth: (_req, _res, next) => next(),
    perAppLimiter: noopLimiter,
    perTokenLimiter: noopLimiter,
    auditSink: noopSink,
  });

  it('has no route that fails to declare a scope', () => {
    const violations = auditRouterScopes(router);
    expect(
      violations.map((v) => v.message),
      `Routes on /api/v1 with no usable scope declaration:\n${violations.map((v) => `  - ${v.message}`).join('\n')}`,
    ).toEqual([]);
  });

  it('is honest that this is currently vacuous', () => {
    // Stated as an assertion rather than a comment, so it starts failing the day
    // L09 or L10 mounts the first resource route — at which point whoever lands
    // it deletes this test, and the one above stops being a formality. A green
    // check over zero routes is not evidence of anything.
    expect(
      mountedRoutes(router),
      'A resource route now exists on /api/v1. Delete this test — the check above is real now.',
    ).toEqual([]);
  });
});

describe('PF-080 · the negative matrix', () => {
  it('(a) documents:read on a documents:write route → 403 naming documents:write', async () => {
    const res = await request(guarded(requireScope('documents:write'), ['documents:read'])).get(
      '/thing',
    );

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
    expect(res.body.details.required_scope).toBe('documents:write');
  });

  it('(b) an authorize request for documents:delete comes back as invalid_scope, listing it', () => {
    // RFC 6749 §3.3. L04 turns this into the actual `invalid_scope` response;
    // L03's half is that the unknown name is separated out and reportable, so
    // the client developer is told which name was wrong.
    const { valid, unknown } = validateRequestedScopes(['documents:read', 'documents:delete']);

    expect(unknown).toEqual(['documents:delete']);
    expect(valid).toEqual(['documents:read']);
    expect(unknown.length > 0, 'a non-empty unknown list is what makes this invalid_scope').toBe(
      true,
    );
  });

  it('(c) a token with no scopes at all → 403, not 500', async () => {
    const handler = vi.fn<RequestHandler>((_req, res) => res.json({ ok: true }));
    const app = express();
    app.use(requestIdMiddleware());
    app.use((_req, res, next) => {
      res.locals[PLATFORM_AUTH_LOCAL] = authContext([]);
      next();
    });
    app.get('/thing', requireScope('documents:read'), handler);
    app.use(apiErrorMiddleware());

    const res = await request(app).get('/thing');

    expect(res.status).toBe(403);
    expect(res.status).not.toBe(500);
    expect(res.body.details.granted_scopes).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('(d) issues:write on a documents:write route → 403 naming documents:write', async () => {
    // The check is "has this scope", not "has any scope". A guard that tested
    // `auth.scopes.length > 0` would pass every other case in this matrix.
    const res = await request(guarded(requireScope('documents:write'), ['issues:write'])).get(
      '/thing',
    );

    expect(res.status).toBe(403);
    expect(res.body.details.required_scope).toBe('documents:write');
    expect(res.body.details.granted_scopes).toEqual(['issues:write']);
  });

  it('(d′) the same route with the right scope reaches the handler', async () => {
    // The positive control the matrix needs. Without it, a guard that 403'd
    // unconditionally would pass (a), (c) and (d).
    const res = await request(guarded(requireScope('documents:write'), ['documents:write'])).get(
      '/thing',
    );

    expect(res.status).toBe(200);
  });
});
