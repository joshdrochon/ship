/**
 * PF-062 / PF-064 — the seven canonical scopes, registered at module load.
 *
 * THIS IS THE REGISTRATION FILE. Adding a scope is an edit here and nowhere
 * else — not to `require-scope.ts`, not to any route, not to any middleware.
 * That is the Open/Closed claim `docs/architecture.md` makes about this module,
 * and PF-066 asserts it by registering a scope the production registry has never
 * heard of and driving a guarded handler to both 200 and 403 with an empty diff
 * over `require-scope.ts`.
 *
 * The seven names come from the PRD (p.3) and are not ours to invent. Note in
 * particular that there is no scope for the authenticated identity: `GET
 * /api/v1/me` declares `scope: null` explicitly rather than being given an
 * eighth scope, because inventing one would break the exact-seven assertion the
 * MVP gate's item 6 rests on. See `route-metadata.ts` for how a declared null is
 * told apart from a forgotten declaration.
 */
import { ScopeRegistry, type ScopeDefinition } from './registry.js';

/**
 * The scope table. `as const` is load-bearing: `Scope` is derived from this
 * array, so the type and the data cannot disagree. A hand-written union beside
 * the data would be two sources of truth, and the one nobody updates is the one
 * the compiler trusts.
 */
export const SCOPE_DEFINITIONS = [
  {
    scope: 'documents:read',
    resource: 'documents',
    action: 'read',
    description: 'Read documents in your workspace',
  },
  {
    scope: 'documents:write',
    resource: 'documents',
    action: 'write',
    description: 'Create and update documents in your workspace',
  },
  {
    scope: 'issues:read',
    resource: 'issues',
    action: 'read',
    description: 'Read issues in your workspace',
  },
  {
    scope: 'issues:write',
    resource: 'issues',
    action: 'write',
    description: 'Create and update issues in your workspace',
  },
  {
    scope: 'sprints:read',
    resource: 'sprints',
    action: 'read',
    description: 'Read sprints in your workspace',
  },
  {
    scope: 'sprints:write',
    resource: 'sprints',
    action: 'write',
    description: 'Create and update sprints in your workspace',
  },
  {
    scope: 'webhooks:manage',
    resource: 'webhooks',
    action: 'manage',
    description: 'Create, update and delete webhook subscriptions',
  },
] as const satisfies readonly ScopeDefinition[];

/**
 * PF-064 — derived from the registration data, never hand-written.
 *
 * `requireScope('documents:delete')` is therefore a compile error, and a
 * `@ts-expect-error` fixture in the test suite fails `pnpm type-check` if that
 * ever stops being true.
 */
export type Scope = (typeof SCOPE_DEFINITIONS)[number]['scope'];

/** The process-wide registry. Populated below, at module load. */
export const scopeRegistry = new ScopeRegistry<Scope>();

for (const def of SCOPE_DEFINITIONS) {
  scopeRegistry.register(def);
}
