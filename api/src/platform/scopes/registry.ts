/**
 * ScopeRegistry — scopes as data (OCP).
 *
 * Adding a scope is a registration here, never a middleware edit. The registry
 * is what lets the 403 name the missing scope, and what the fitness test walks
 * to assert every public route declares one.
 */
import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../api/v1/errors.js';

export const SCOPES = [
  'documents:read',
  'documents:write',
  'issues:read',
  'issues:write',
  'sprints:read',   // public contract name; maps onto Ship's internal `weeks` model
  'sprints:write',
  'webhooks:manage',
] as const;

export type Scope = (typeof SCOPES)[number];

export interface ScopeDefinition {
  scope: Scope;
  description: string;
}

class ScopeRegistry {
  private defs = new Map<Scope, ScopeDefinition>();

  register(def: ScopeDefinition): void {
    this.defs.set(def.scope, def);
  }

  has(scope: string): scope is Scope {
    return this.defs.has(scope as Scope);
  }

  list(): ScopeDefinition[] {
    return [...this.defs.values()];
  }
}

export const scopeRegistry = new ScopeRegistry();

// Registered at module load — the whole point: data, not code.
scopeRegistry.register({ scope: 'documents:read',  description: 'Read documents' });
scopeRegistry.register({ scope: 'documents:write', description: 'Create and update documents' });
scopeRegistry.register({ scope: 'issues:read',     description: 'Read issues' });
scopeRegistry.register({ scope: 'issues:write',    description: 'Create and update issues' });
scopeRegistry.register({ scope: 'sprints:read',    description: 'Read sprints' });
scopeRegistry.register({ scope: 'sprints:write',   description: 'Create and update sprints' });
scopeRegistry.register({ scope: 'webhooks:manage', description: 'Manage webhook subscriptions' });

/** What bearer auth attaches to the request once a token resolves. */
export interface PlatformAuthContext {
  appId: string;
  clientId: string;
  userId: string | null; // null for machine-to-machine (first-party agent) tokens
  scopes: Scope[];
  tokenId: string;
}

/**
 * Middleware factory: require a granted scope or 403 that NAMES it.
 * Assumes bearerTokenMiddleware has populated res.locals.platformAuth.
 */
export function requireScope(scope: Scope) {
  if (!scopeRegistry.has(scope)) {
    // Fail at wiring time, not request time — an unregistered scope is a defect.
    throw new Error(`requireScope: unregistered scope "${scope}"`);
  }
  return (req: Request, res: Response, next: NextFunction): void => {
    const auth = res.locals.platformAuth as PlatformAuthContext | undefined;
    if (!auth) {
      next(new ApiError('unauthorized', 'Authentication required.'));
      return;
    }
    if (!auth.scopes.includes(scope)) {
      // Shape fixed by the `details` policy (L07 PF-198): a `forbidden` envelope
      // carries exactly `details.missing_scope`. It was `{required_scope,
      // granted_scopes}` while this file was L01 scaffolding — `apiErrorBodySchema`
      // is `.strict()`, so the old shape now fails the envelope test.
      //
      // `granted_scopes` was dropped rather than renamed: p.3 asks the 403 to name
      // the scope that was MISSING, and echoing the full grant back is a second,
      // route-independent fact that belongs in the token introspection response,
      // not in an error body.
      next(
        new ApiError('forbidden', `Missing required scope: ${scope}`, {
          details: { missing_scope: scope },
        }),
      );
      return;
    }
    next();
  };
}
