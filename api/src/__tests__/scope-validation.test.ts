/**
 * PF-073 – PF-076 — scope decisions at grant time.
 *
 * These are the functions L04 (`/oauth/authorize`) and L05 (device grant) call.
 * They are tested here as pure functions, before either lane exists, which is
 * the whole reason they were written as pure functions.
 *
 * Outside `api/src/platform/` for PF-077's reason: that fitness test greps
 * `platform/**` for the literal `'weeks'` and expects exactly one hit.
 */
import { describe, it, expect } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { ScopeRegistry } from '../platform/scopes/registry.js';
import { scopeRegistry, type Scope } from '../platform/scopes/scopes.js';
import {
  validateRequestedScopes,
  resolveGrantedScopes,
  reconcileTokenScopes,
  resolveScopeUpgrade,
} from '../platform/scopes/validation.js';
import { requireScope, PLATFORM_AUTH_LOCAL, UNRECOGNIZED_SCOPES_LOCAL, getUnrecognizedScopes } from '../platform/scopes/require-scope.js';
import type { PlatformAuthContext } from '../platform/scopes/auth-context.js';
import { requestIdMiddleware } from '../platform/api/v1/requestId.js';
import { apiErrorMiddleware } from '../platform/api/v1/errorMiddleware.js';

function authContext(scopes: string[]): PlatformAuthContext {
  return {
    appId: 'app_test',
    clientId: 'client_test',
    userId: 'user_test',
    scopes: scopes as Scope[],
    tokenId: 'tok_test',
    workspaceId: 'ws_test',
  };
}

describe('PF-073 · validateRequestedScopes splits known from unknown', () => {
  it('returns every registered name as valid', () => {
    const result = validateRequestedScopes(['documents:read', 'issues:write']);
    expect(result.valid).toEqual(['documents:read', 'issues:write']);
    expect(result.unknown).toEqual([]);
  });

  it('puts an unregistered name in unknown so L04 can emit invalid_scope', () => {
    // PF-080(b). RFC 6749 §3.3: the authorization request fails with
    // `invalid_scope`, and the name has to be reportable for the client
    // developer to have any chance of fixing it.
    const result = validateRequestedScopes(['documents:read', 'documents:delete']);
    expect(result.valid).toEqual(['documents:read']);
    expect(result.unknown).toEqual(['documents:delete']);
  });

  it('returns empty-valid for an empty request — never all scopes', () => {
    // The failure this exists to prevent is silent and maximal: a client that
    // omits `scope` getting a token that can do everything in the registry.
    const result = validateRequestedScopes([]);
    expect(result.valid).toEqual([]);
    expect(result.unknown).toEqual([]);
    expect(result.valid).not.toEqual(scopeRegistry.names());
  });

  it('deduplicates on both sides', () => {
    const result = validateRequestedScopes([
      'documents:read',
      'documents:read',
      'nope:nope',
      'nope:nope',
    ]);
    expect(result.valid).toEqual(['documents:read']);
    expect(result.unknown).toEqual(['nope:nope']);
  });

  it('is pure — no Express, no DB, and it runs against an injected registry', () => {
    const registry = new ScopeRegistry<'plugins:read'>();
    registry.register({
      scope: 'plugins:read',
      resource: 'plugins',
      action: 'read',
      description: 'Read installed plugins',
    });

    const result = validateRequestedScopes(['plugins:read', 'documents:read'], registry);
    expect(result.valid).toEqual(['plugins:read']);
    // Production's scopes are unknown to this registry, which is the proof that
    // the function reads the registry it is handed and not a global.
    expect(result.unknown).toEqual(['documents:read']);
  });
});

describe('PF-074 · granted scopes are the intersection of app registration and consent', () => {
  const cases: Array<{ name: string; app: Scope[]; user: Scope[]; expected: Scope[] }> = [
    {
      name: 'app-subset — the app asked for less than the user approved',
      app: ['documents:read'],
      user: ['documents:read', 'documents:write'],
      expected: ['documents:read'],
    },
    {
      name: 'user-subset — the user approved less than the app asked for',
      app: ['documents:read', 'documents:write'],
      user: ['documents:read'],
      expected: ['documents:read'],
    },
    {
      name: 'disjoint — nothing in common',
      app: ['documents:read'],
      user: ['issues:write'],
      expected: [],
    },
    {
      name: 'identical',
      app: ['documents:read', 'issues:read'],
      user: ['documents:read', 'issues:read'],
      expected: ['documents:read', 'issues:read'],
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(resolveGrantedScopes(c.app, c.user)).toEqual(c.expected);
    });
  }

  it('a scope the app never registered can never reach a token', () => {
    // The security property, stated as its own test rather than left implicit in
    // the table. The consent payload arrives over the network from a browser; if
    // it could add a scope, the app's registration would be decoration.
    const granted = resolveGrantedScopes(
      ['documents:read'],
      ['documents:read', 'documents:write', 'webhooks:manage'],
    );
    expect(granted).toEqual(['documents:read']);
    expect(granted).not.toContain('webhooks:manage');
  });

  it('orders by the app registration, so a token scope list is stable', () => {
    expect(
      resolveGrantedScopes(['issues:read', 'documents:read'], ['documents:read', 'issues:read']),
    ).toEqual(['issues:read', 'documents:read']);
  });
});

describe('PF-075 · token scopes are re-validated against the registry at request time', () => {
  it('separates still-registered names from ones the registry has forgotten', () => {
    const { effective, unrecognized } = reconcileTokenScopes([
      'documents:read',
      'legacy:permission',
    ]);
    expect(effective).toEqual(['documents:read']);
    expect(unrecognized).toEqual(['legacy:permission']);
  });

  it('403s naming the required scope when the token only carried a deregistered one', async () => {
    // The scenario: a token was issued carrying `plugins:read` while that scope
    // existed. It has since been removed. The token still presents it, and it
    // now grants nothing — a permission must not outlive the definition of the
    // thing it permitted.
    const app = express();
    app.use(requestIdMiddleware());
    app.use((_req, res, next) => {
      res.locals[PLATFORM_AUTH_LOCAL] = authContext(['plugins:read', 'documents:read']);
      next();
    });
    app.get('/thing', requireScope('documents:write'), (_req, res) => res.json({ ok: true }));
    app.use(apiErrorMiddleware());

    const res = await request(app).get('/thing');

    expect(res.status).toBe(403);
    expect(res.body.details.missing_scope).toBe('documents:write');
    // `plugins:read` is not in the production registry, so it is not reported as
    // something the caller has.
    expect(res.body.details.granted_scopes).toEqual(['documents:read']);
    expect(res.body.details.unrecognized_scopes).toEqual(['plugins:read']);
  });

  it('records the mismatch on res.locals for the audit trail rather than dropping it', async () => {
    // p.4 requires the audit row to record `scope used`. L12 owns the sink; this
    // asserts the value is *available* to it, which is L03's half. Noted in the
    // lane report: if L12 ships no scope field, this is where the value stops.
    let seen: string[] | undefined;
    const captureAudit: RequestHandler = (_req, res, next) => {
      seen = getUnrecognizedScopes(res);
      next();
    };

    const app = express();
    app.use(requestIdMiddleware());
    app.use((_req, res, next) => {
      res.locals[PLATFORM_AUTH_LOCAL] = authContext(['documents:read', 'gone:away']);
      next();
    });
    app.get('/thing', requireScope('documents:read'), captureAudit, (_req, res) =>
      res.json({ ok: true }),
    );
    app.use(apiErrorMiddleware());

    const res = await request(app).get('/thing');

    // The request still succeeds — the scope it needed is fine — and the stale
    // name is still recorded. A silent drop here is how nobody finds out that a
    // deregistration broke a live integration.
    expect(res.status).toBe(200);
    expect(seen).toEqual(['gone:away']);
  });

  it('leaves the locals key absent when every scope is still recognized', async () => {
    let present = true;
    const check: RequestHandler = (_req, res, next) => {
      present = UNRECOGNIZED_SCOPES_LOCAL in res.locals;
      next();
    };

    const app = express();
    app.use(requestIdMiddleware());
    app.use((_req, res, next) => {
      res.locals[PLATFORM_AUTH_LOCAL] = authContext(['documents:read']);
      next();
    });
    app.get('/thing', requireScope('documents:read'), check, (_req, res) => res.json({ ok: true }));
    app.use(apiErrorMiddleware());

    await request(app).get('/thing');

    expect(present).toBe(false);
  });
});

describe('PF-076 · scope upgrades are re-consent with union (D4)', () => {
  it('requires consent when the request adds anything', () => {
    const upgrade = resolveScopeUpgrade(['documents:read'], ['documents:write']);
    expect(upgrade.requiresConsent).toBe(true);
    expect(upgrade.added).toEqual(['documents:write']);
  });

  it('shows the union, not the delta, so the screen matches the resulting token', () => {
    // Both halves of the ticket's assertion that can be made without L04: the
    // consent set is the union, and it is therefore what the fresh token will
    // carry. The other half — that a consent screen is actually rendered — is
    // L04's `/oauth/authorize` and cannot be asserted here; see the lane report.
    const upgrade = resolveScopeUpgrade(['documents:read'], ['documents:write']);
    expect(upgrade.consentScopes).toEqual(['documents:read', 'documents:write']);
  });

  it('does not burn a consent screen when the existing grant already covers the request', () => {
    const upgrade = resolveScopeUpgrade(
      ['documents:read', 'documents:write'],
      ['documents:read'],
    );
    expect(upgrade.requiresConsent).toBe(false);
    expect(upgrade.added).toEqual([]);
    expect(upgrade.consentScopes).toEqual(['documents:read', 'documents:write']);
  });

  it('treats a first grant as an upgrade from nothing', () => {
    const upgrade = resolveScopeUpgrade([], ['documents:read']);
    expect(upgrade.requiresConsent).toBe(true);
    expect(upgrade.consentScopes).toEqual(['documents:read']);
  });

  it('never loses an existing grant — the union is a superset of both inputs', () => {
    // The property that makes "a fresh token replaces the old" safe. If the
    // union dropped anything, an upgrade would silently revoke a permission the
    // client was relying on, and the client would find out at the next 403.
    const existing: Scope[] = ['documents:read', 'issues:read'];
    const requested: Scope[] = ['documents:write'];
    const { consentScopes } = resolveScopeUpgrade(existing, requested);

    for (const scope of [...existing, ...requested]) {
      expect(consentScopes).toContain(scope);
    }
    expect(consentScopes).toHaveLength(3);
  });
});
