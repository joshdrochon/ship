/**
 * PF-061 – PF-066 — the ScopeRegistry, as data.
 *
 * MVP gate item 6 (PRD p.2) is "ScopeRegistry has scopes-as-data". The two ways
 * that claim goes quietly false are (a) the scope list drifts from the type, and
 * (b) the registry grows a dependency on the HTTP stack, at which point "scopes
 * are data" becomes "scopes are middleware with a Map in front". Both are
 * asserted here rather than reviewed.
 *
 * These tests live outside `api/src/platform/` on purpose. PF-077's fitness test
 * greps every file under `platform/**` for the literal `'weeks'` and expects
 * exactly one hit; a test file colocated under `platform/` that so much as
 * mentions the word would fail a *different* lane's assertion for no reason.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ScopeRegistry,
  DuplicateScopeError,
  MalformedScopeError,
  type ScopeDefinition,
} from '../platform/scopes/registry.js';
import { scopeRegistry, SCOPE_DEFINITIONS, type Scope } from '../platform/scopes/scopes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY_SRC = join(HERE, '..', 'platform', 'scopes', 'registry.ts');

describe('PF-061 · the registry is a data structure, not a middleware', () => {
  it('imports nothing from express and nothing from the public router', () => {
    // The bare-Node half of the criterion. A `Map` behind four methods needs no
    // HTTP stack, and the moment it imports one, "scopes are data" stops being
    // true in the only sense that matters — you can no longer add a scope
    // without reasoning about requests.
    const src = readFileSync(REGISTRY_SRC, 'utf8');
    // Comments are stripped first: this file's own header explains why it does
    // not import from `../api/v1/`, and a naive substring search over the whole
    // source would read that explanation as the violation it forbids.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const specifiers = [...code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);

    expect(
      specifiers,
      `platform/scopes/registry.ts must import nothing at all. It references: ${specifiers.join(', ')}`,
    ).toEqual([]);
    expect(code).not.toMatch(/express/);
    expect(code).not.toMatch(/api\/v1/);
  });

  it('exposes register / has / get / list on a fresh instance, with no app around it', () => {
    const registry = new ScopeRegistry<'plugins:read'>();

    expect(registry.list()).toEqual([]);
    expect(registry.has('plugins:read')).toBe(false);
    expect(registry.get('plugins:read')).toBeUndefined();

    const def: ScopeDefinition<'plugins:read'> = {
      scope: 'plugins:read',
      resource: 'plugins',
      action: 'read',
      description: 'Read installed plugins',
    };
    registry.register(def);

    expect(registry.has('plugins:read')).toBe(true);
    expect(registry.get('plugins:read')).toEqual(def);
    expect(registry.list()).toEqual([def]);
    expect(registry.size).toBe(1);
  });
});

describe('PF-062 · exactly seven scopes, registered at module load', () => {
  const EXPECTED = [
    'documents:read',
    'documents:write',
    'issues:read',
    'issues:write',
    'sprints:read',
    'sprints:write',
    'webhooks:manage',
  ];

  it('registers the seven the PRD names — no more, no fewer', () => {
    // Compared against a literal so the test fails on BOTH a missing entry and
    // an extra one. `toEqual` on the sorted arrays would pass if the registry
    // returned the same names in a different order, which is fine; it would not
    // pass if an eighth scope were invented to make some route's fitness test go
    // green. That is the failure this exists to catch — see the `me` route,
    // which declares `scope: null` rather than growing the list to eight.
    expect(scopeRegistry.names()).toEqual(EXPECTED);
    expect(scopeRegistry.size).toBe(7);
  });

  it('fails if a scope is added to the data and not to this test', () => {
    expect(SCOPE_DEFINITIONS.map((d) => d.scope)).toEqual(EXPECTED);
  });
});

describe('PF-063 · every definition carries resource, action and description', () => {
  it('round-trips `${resource}:${action}` back to the scope name', () => {
    for (const d of scopeRegistry.list()) {
      expect(`${d.resource}:${d.action}`, `scope "${d.scope}" does not round-trip`).toBe(d.scope);
    }
  });

  it('gives every scope non-empty prose a consent screen could show verbatim', () => {
    for (const d of scopeRegistry.list()) {
      expect(d.description.trim().length, `scope "${d.scope}" has an empty description`).toBeGreaterThan(0);
      // Prose, not a repeat of the machine name. A `description` of
      // "documents:read" would satisfy "non-empty" and be worthless in both of
      // the two places it is shown (consent screen, 403 body).
      expect(d.description).not.toBe(d.scope);
      expect(d.description).toMatch(/\s/);
    }
  });

  it('rejects a registration whose name and parts disagree', () => {
    const registry = new ScopeRegistry();
    expect(() =>
      registry.register({
        scope: 'documents:read',
        resource: 'documents',
        action: 'write', // <- disagrees with the name
        description: 'Read documents',
      }),
    ).toThrow(MalformedScopeError);
    expect(registry.size).toBe(0);
  });

  it('rejects an empty description', () => {
    const registry = new ScopeRegistry();
    expect(() =>
      registry.register({ scope: 'a:b', resource: 'a', action: 'b', description: '   ' }),
    ).toThrow(/empty description/);
    expect(registry.size).toBe(0);
  });
});

describe('PF-064 · Scope is derived from the data, not hand-written', () => {
  it('rejects an unregistered name at compile time', () => {
    // If `Scope` is ever replaced by a hand-written union that happens to
    // include `documents:delete`, or widened to `string`, the @ts-expect-error
    // below stops firing and `pnpm type-check` fails. That is the assertion —
    // the runtime expectation under it is incidental.
    // @ts-expect-error 'documents:delete' is not a registered scope
    const notAScope: Scope = 'documents:delete';
    expect(notAScope).toBe('documents:delete');
  });

  it('accepts every registered name at compile time', () => {
    const all: Scope[] = [
      'documents:read',
      'documents:write',
      'issues:read',
      'issues:write',
      'sprints:read',
      'sprints:write',
      'webhooks:manage',
    ];
    expect(all).toHaveLength(7);
  });
});

describe('PF-065 · duplicate registration fails loudly, never shadows', () => {
  const def: ScopeDefinition = {
    scope: 'documents:read',
    resource: 'documents',
    action: 'read',
    description: 'Read documents',
  };

  it('throws, names the scope, and leaves the registry the size it was', () => {
    const registry = new ScopeRegistry();
    registry.register(def);
    const sizeBefore = registry.size;

    expect(() =>
      registry.register({ ...def, description: 'Read EVERYTHING, including your drafts' }),
    ).toThrow(DuplicateScopeError);
    expect(() => registry.register(def)).toThrow(/documents:read/);

    expect(registry.size).toBe(sizeBefore);
    // The thing a silent overwrite would have changed: the description the 403
    // body and the consent screen both read back.
    expect(registry.get('documents:read')?.description).toBe('Read documents');
  });

  it('is why the production registry cannot be re-registered into a different shape', () => {
    expect(() =>
      scopeRegistry.register({
        scope: 'documents:read',
        resource: 'documents',
        action: 'read',
        description: 'anything at all',
      }),
    ).toThrow(DuplicateScopeError);
    expect(scopeRegistry.size).toBe(7);
  });
});

describe('PF-066 · Open/Closed — a new scope is a registration, not an edit', () => {
  it('registers a scope the production registry has never heard of', () => {
    // The registry half of the criterion. The other half — driving a
    // `requireScope('plugins:read')`-guarded handler to 200 and 403 with an
    // empty diff over `require-scope.ts` — needs the middleware factory and so
    // lands with PF-067 on the next slice. See the lane report: PF-066 sits in
    // S1 but its Deps column names PF-067, which is an S2 ticket.
    const registry = new ScopeRegistry<'plugins:read'>();
    registry.register({
      scope: 'plugins:read',
      resource: 'plugins',
      action: 'read',
      description: 'Read installed plugins',
    });

    expect(registry.has('plugins:read')).toBe(true);
    expect(registry.get('plugins:read')?.description).toBe('Read installed plugins');
    // Adding it changed nothing about the production registry — the two are
    // separate instances, which is what lets a test add a scope without
    // mutating global state that another test file would then observe.
    expect(scopeRegistry.has('plugins:read')).toBe(false);
    expect(scopeRegistry.size).toBe(7);
  });
});
