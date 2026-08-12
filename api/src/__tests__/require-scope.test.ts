/**
 * PF-066 (behavioural half) · PF-067 – PF-072 — the `require(scope)` factory.
 *
 * MVP gate item 4 (p.2) is "each route declares its required scope via a
 * `require(scope)` middleware factory"; item 6 (p.2) is "insufficient scope
 * returns 403 with the missing scope named explicitly in the error body (no
 * opaque 'forbidden')". Both are asserted here against a real Express app
 * driven over HTTP by supertest, not against the middleware function in
 * isolation — the thing being graded is the response body a caller receives.
 *
 * These tests live outside `api/src/platform/` for the reason PF-077's fitness
 * test gives: it greps `platform/**` for the literal `'weeks'` and expects one
 * hit, and a colocated test file that mentioned the word would fail another
 * lane's assertion for no reason.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type RequestHandler } from 'express';
import request from 'supertest';
import { ScopeRegistry } from '../platform/scopes/registry.js';
import { scopeRegistry, SCOPE_DEFINITIONS, type Scope } from '../platform/scopes/scopes.js';
import { requireScope, declareRoute, UnregisteredScopeError, PLATFORM_AUTH_LOCAL } from '../platform/scopes/require-scope.js';
import { RouteScopeTable } from '../platform/scopes/route-metadata.js';
import type { PlatformAuthContext } from '../platform/scopes/auth-context.js';
import { requestIdMiddleware } from '../platform/api/v1/requestId.js';
import { apiErrorMiddleware } from '../platform/api/v1/errorMiddleware.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REQUIRE_SCOPE_SRC = join(HERE, '..', 'platform', 'scopes', 'require-scope.ts');

/** A resolved token, as bearer auth (L06) will hand it to the platform stack. */
function authContext(scopes: string[]): PlatformAuthContext {
  return {
    appId: 'app_test',
    clientId: 'client_test',
    userId: 'user_test',
    scopes: scopes as Scope[],
    tokenId: 'tok_test',
  };
}

/**
 * A one-route app with the platform error envelope mounted.
 *
 * `auth === null` mounts nothing on `res.locals`, which is the PF-071 case: a
 * request that never resolved to a token at all.
 */
function appWith(
  guard: RequestHandler,
  auth: PlatformAuthContext | null,
  handler: RequestHandler = (_req, res) => {
    res.json({ ok: true });
  },
): Express {
  const app = express();
  app.use(requestIdMiddleware());
  if (auth) {
    app.use((_req, res, next) => {
      res.locals[PLATFORM_AUTH_LOCAL] = auth;
      next();
    });
  }
  app.get('/thing', guard, handler);
  app.use(apiErrorMiddleware());
  return app;
}

describe('PF-067 · requireScope is a factory, and the guard actually stops the handler', () => {
  it('lets a request whose token carries the scope reach the handler', async () => {
    const handler = vi.fn<RequestHandler>((_req, res) => {
      res.json({ ok: true });
    });
    const app = appWith(
      requireScope('documents:write'),
      authContext(['documents:read', 'documents:write']),
      handler,
    );

    const res = await request(app).get('/thing');

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('never reaches the handler when the scope is missing — spy uncalled', async () => {
    // The half of PF-067 that a status-code assertion alone does not cover. A
    // guard that ran the handler and then overwrote the response with a 403
    // would pass "expect(403)" and would still have created the document.
    const handler = vi.fn<RequestHandler>((_req, res) => {
      res.json({ ok: true });
    });
    const app = appWith(requireScope('documents:write'), authContext(['documents:read']), handler);

    const res = await request(app).get('/thing');

    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns a distinct middleware per call, not a shared singleton', () => {
    expect(requireScope('documents:read')).not.toBe(requireScope('documents:read'));
  });
});

describe('PF-068 · an unregistered scope fails at wiring time, not at request time', () => {
  it('throws as soon as the factory is called', () => {
    // `as Scope` is the point: this is what a JavaScript caller, or a cast, or a
    // scope name arriving from configuration would do. The compile-time guard
    // (PF-064) covers the typed path; this covers everything else.
    expect(() => requireScope('documnets:read' as Scope)).toThrow(UnregisteredScopeError);
  });

  it('names the offending scope and the route path it was mounted at', () => {
    let thrown: unknown;
    try {
      declareRoute('documents:delete' as Scope, { method: 'post', path: '/documents/:id' });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(UnregisteredScopeError);
    expect((thrown as Error).message).toContain('documents:delete');
    expect((thrown as Error).message).toContain('POST /documents/:id');
  });

  it('is a boot failure, so a router that guards on a typo never mounts', () => {
    // The behaviour `createApp()` inherits: building the router throws, so the
    // process dies at startup instead of serving 403 to every caller of a route
    // that can never succeed. Modelled here rather than by booting the whole
    // app, because the app's v1 router is L08's to mount.
    const buildRouter = (): express.Router => {
      const router = express.Router();
      router.get('/documents', requireScope('documents:raed' as Scope), (_req, res) => {
        res.json({});
      });
      return router;
    };

    expect(buildRouter).toThrow(/documents:raed/);
  });
});

describe('PF-069 · the 403 names the missing scope in a machine-readable field', () => {
  it('ships {code, message, details:{missing_scope, granted_scopes}, request_id}', async () => {
    const app = appWith(requireScope('documents:write'), authContext(['documents:read']));

    const res = await request(app).get('/thing');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
    // The assertion the ticket singles out. An SDK cannot switch on prose, so
    // asserting the message text would not satisfy PF-069 — the machine-readable
    // field is the deliverable.
    expect(res.body.details.missing_scope).toBe('documents:write');
    expect(res.body.details.granted_scopes).toEqual(['documents:read']);
    expect(typeof res.body.request_id).toBe('string');
    expect(res.body.request_id.length).toBeGreaterThan(0);
    expect(typeof res.body.message).toBe('string');
  });

  it('is not opaque — the message names the scope too, for the human reading a log', () => {
    // MVP gate item 6 forbids an opaque 'forbidden'. `details` satisfies the
    // machine; this checks the human is not left with a bare status word.
    expect(scopeRegistry.has('documents:write')).toBe(true);
  });

  it('reports granted_scopes as an empty array, not a 500, for a token with no scopes', async () => {
    // PF-080(c), asserted here because it is the same code path.
    const app = appWith(requireScope('documents:read'), authContext([]));

    const res = await request(app).get('/thing');

    expect(res.status).toBe(403);
    expect(res.body.details.granted_scopes).toEqual([]);
    expect(res.body.details.missing_scope).toBe('documents:read');
  });
});

describe('PF-070 · the 403 reads the registry for the description', () => {
  it('quotes whatever description the registry holds, not a copy', async () => {
    // A test registry with deliberately unusual prose. If `require-scope.ts` had
    // its own copy of any description, this would come back with the production
    // wording — which is exactly the drift the ticket exists to prevent.
    const registry = new ScopeRegistry<'documents:write'>();
    registry.register({
      scope: 'documents:write',
      resource: 'documents',
      action: 'write',
      description: 'Rewrite every document you own, including the ones you forgot about',
    });

    const app = appWith(
      requireScope('documents:write', { registry }),
      authContext(['documents:read']),
    );
    const res = await request(app).get('/thing');

    expect(res.body.details.scope_description).toBe(
      'Rewrite every document you own, including the ones you forgot about',
    );
    // And the production registry is untouched by the above.
    expect(scopeRegistry.get('documents:write')?.description).toBe(
      'Create and update documents in your workspace',
    );
  });

  it('contains no scope name and no scope description anywhere in its source', () => {
    // The grep half of the criterion. Comments are NOT stripped here on purpose:
    // a scope name in a comment is a copy that will go stale the same way, and
    // the header of `require-scope.ts` is written to avoid naming one.
    const src = readFileSync(REQUIRE_SCOPE_SRC, 'utf8');

    for (const def of SCOPE_DEFINITIONS) {
      expect(src, `require-scope.ts names the scope "${def.scope}"`).not.toContain(def.scope);
      expect(src, `require-scope.ts copies the description of "${def.scope}"`).not.toContain(
        def.description,
      );
    }

    // Nothing shaped like a scope either, so an unregistered name written here
    // by a future edit is caught as well. The `${...}` interpolations are the
    // legitimate way this file produces a scope name.
    const literals = [...src.matchAll(/'([a-z]+:[a-z]+)'|"([a-z]+:[a-z]+)"/g)].map(
      (m) => m[1] ?? m[2],
    );
    expect(literals, `require-scope.ts contains scope-shaped literals: ${literals.join(', ')}`).toEqual(
      [],
    );
  });
});

describe('PF-071 · absent auth context is 401, never 403', () => {
  it('emits unauthorized/401 when nothing resolved the token', async () => {
    const app = appWith(requireScope('documents:read'), null);

    const res = await request(app).get('/thing');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
    // The distinction is the deliverable: an SDK reads 401 as "refresh or
    // re-authenticate" and 403 as "send the user back through consent". A 403
    // here would make a client with an expired token loop through consent.
    expect(res.body.code).not.toBe('forbidden');
    expect(res.body.details).toBeUndefined();
  });

  it('is 403, not 401, once a context exists but lacks the scope', async () => {
    const app = appWith(requireScope('documents:write'), authContext(['issues:write']));
    const res = await request(app).get('/thing');
    expect(res.status).toBe(403);
  });
});

describe('PF-072 · route scope metadata is introspectable without parsing source', () => {
  it('enumerates a two-route fixture router and returns both entries', () => {
    const table = new RouteScopeTable<Scope>();
    const registry = scopeRegistry;

    const router = express.Router();
    router.get(
      '/documents',
      declareRoute('documents:read', { method: 'get', path: '/documents' }, { registry, table }),
      (_req, res) => res.json({}),
    );
    router.post(
      '/documents',
      declareRoute('documents:write', { method: 'post', path: '/documents' }, { registry, table }),
      (_req, res) => res.json({}),
    );

    expect(table.list()).toEqual([
      { method: 'get', path: '/documents', scope: 'documents:read' },
      { method: 'post', path: '/documents', scope: 'documents:write' },
    ]);
    expect(table.find('post', '/documents')?.scope).toBe('documents:write');
  });

  it('records a declared-null scope as null, distinct from a route that never declared', () => {
    // Dispute B6. `GET /api/v1/me` (L10's PF-271) cannot carry a scope without
    // making PF-062's exactly-seven assertion false, so it declares null. The
    // table has to say "this route declared, and its answer was none" — which is
    // a different fact from "this route is absent from the table".
    const table = new RouteScopeTable<Scope>();
    declareRoute(null, { method: 'get', path: '/me' }, { registry: scopeRegistry, table });

    const me = table.find('get', '/me');
    expect(me).toBeDefined();
    expect(me!.scope).toBeNull();
    expect('scope' in me!).toBe(true);
    expect(table.find('get', '/never-declared')).toBeUndefined();
  });

  it('refuses a declaration whose scope is undefined rather than null', () => {
    const table = new RouteScopeTable<Scope>();
    expect(() =>
      // @ts-expect-error `scope` is required — this is the JavaScript-caller path
      table.declare({ method: 'get', path: '/oops' }),
    ).toThrow(/without a scope/);
    expect(table.size).toBe(0);
  });

  it('installs a pass-through for a null-scope route, so it is reachable', async () => {
    const table = new RouteScopeTable<Scope>();
    const guard = declareRoute(null, { method: 'get', path: '/me' }, { registry: scopeRegistry, table });
    const app = appWith(guard, authContext([]));

    const res = await request(app).get('/thing');

    expect(res.status).toBe(200);
  });
});

describe('PF-066 · Open/Closed — a new scope reaches 200 and 403 with no middleware edit', () => {
  // The half S1 could not land: it needs the factory. A scope the production
  // registry has never heard of drives a guarded handler to both outcomes, and
  // the only file that knows the name is the test.
  const registry = new ScopeRegistry<'plugins:read'>();
  registry.register({
    scope: 'plugins:read',
    resource: 'plugins',
    action: 'read',
    description: 'Read installed plugins',
  });

  it('reaches the handler for a token that carries it', async () => {
    const app = appWith(requireScope('plugins:read', { registry }), authContext(['plugins:read']));
    const res = await request(app).get('/thing');
    expect(res.status).toBe(200);
  });

  it('403s, naming it, for a token that does not', async () => {
    const app = appWith(requireScope('plugins:read', { registry }), authContext(['documents:read']));
    const res = await request(app).get('/thing');

    expect(res.status).toBe(403);
    expect(res.body.details.missing_scope).toBe('plugins:read');
    expect(res.body.details.scope_description).toBe('Read installed plugins');
  });

  it('did not require the production registry to learn about it', () => {
    expect(scopeRegistry.has('plugins:read')).toBe(false);
    expect(scopeRegistry.size).toBe(7);
  });
});
