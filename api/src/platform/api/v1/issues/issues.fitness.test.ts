/**
 * PF-282 / PF-292 — what the v1 issues module may NOT contain, checked by grep
 * over the module's own source, plus the two structural facts that decide
 * whether this resource is real.
 *
 * Every rule here is one a LINT RULE CANNOT SEE:
 *
 *   - `pool.query` inlined in a handler is not an import violation. A handler
 *     that re-implements the list query rather than calling `issueService`
 *     passes PF-009/PF-010 and still breaks p.3's boundary — and it is the
 *     likelier mistake, because inlining one small SELECT never feels like an
 *     architectural decision at the moment it is made.
 *   - `.publish(` in a route is not an import violation either, once some other
 *     module has legitimately imported the bus.
 *
 * Greps run over source text with comments stripped, because this directory's
 * files discuss the things they forbid — describing a rule must not be
 * indistinguishable from breaking it.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { routeMetadata } from '../routeMetadata.js';
import { scopeRegistry } from '../../../scopes/scopes.js';
import { issueSchema, ISSUE_PROJECTION_FIELDS } from './issues.schema.js';
import './routes.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

function sourceFiles(): { name: string; code: string; raw: string }[] {
  return readdirSync(MODULE_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((name) => {
      const raw = readFileSync(join(MODULE_DIR, name), 'utf8');
      return {
        name,
        raw,
        code: raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
      };
    });
}

const production = () => sourceFiles().filter((f) => !f.name.endsWith('.test.ts'));

describe('PF-244 (applied to issues) · the v1 issues module holds no SQL', () => {
  it('has files to check — the check is not vacuous', () => {
    // The failure this guards against is the one L10 found in L03's own fitness
    // test (F36): a green check over zero subjects is not evidence of anything.
    const names = production().map((f) => f.name);
    expect(names).toContain('routes.ts');
    expect(names).toContain('issues.schema.ts');
  });

  for (const marker of [
    'pool.query',
    'client.query',
    'INSERT INTO',
    'SELECT ',
    'DELETE FROM',
    'UPDATE ',
  ]) {
    it(`contains no \`${marker.trim()}\``, () => {
      const offenders = production()
        .filter((f) => f.code.includes(marker))
        .map((f) => f.name);

      expect(
        offenders,
        `${offenders.join(', ')} contains \`${marker}\`. Data access belongs in ` +
          `issueService (api/src/services/issues.ts) — the same function ` +
          `api/src/routes/issues.ts calls, which is what makes the Public/Internal ` +
          `Boundary diagram in docs/architecture.md a fact rather than a drawing.`,
      ).toEqual([]);
    });
  }
});

describe('PF-292 · the publish site is not in the route layer', () => {
  it('no file under api/v1/issues contains `.publish(`', () => {
    // PRD p.3: "Domain layer publishes on writes — never the route layer."
    const offenders = production()
      .filter((f) => f.code.includes('.publish('))
      .map((f) => f.name);

    expect(
      offenders,
      `${offenders.join(', ')} publishes an event from the route layer. ` +
        `issue.created / issue.assigned / issue.status_changed all fire inside ` +
        `services/issues.ts, so the internal POST /api/issues produces them too. ` +
        `A publish here means two publish sites, and the one nobody remembers is ` +
        `the one that stops firing.`,
    ).toEqual([]);
  });

  it('no file under api/v1/issues imports an events or webhooks module', () => {
    const offenders = production()
      .filter((f) => /from '.*(webhooks|events)[^']*'/.test(f.code))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });
});

describe('PF-251 · the Zod lives adjacent to the handler', () => {
  it('routes.ts imports its schemas from the sibling file, not from api/src/openapi', () => {
    // PRD p.11: "Every public route's request/response schema lives in Zod
    // adjacent to the handler; the generator walks them." The alternative —
    // `api/src/openapi/schemas/` — is 22 files of detached `registerPath()`
    // calls, i.e. a hand-written spec that drifts from the routes it describes.
    const routes = production().find((f) => f.name === 'routes.ts')!;
    expect(routes.code).toContain("from './issues.schema.js'");
    expect(routes.code).not.toMatch(/from '.*openapi\/schemas/);
  });

  it('the module imports nothing from api/src/routes or api/src/middleware', () => {
    // The one-way door (PRD p.11). The ESLint fence covers this too; asserted
    // here as well because a fence that is disabled for one line is silent.
    for (const file of production()) {
      expect(file.code, `${file.name} reaches back into the internal surface`).not.toMatch(
        /from '.*\/(routes|middleware)\//,
      );
    }
  });
});

describe('PF-282 · the projection is an allowlist, enforced structurally', () => {
  it('issueSchema is .strict(), so an added key is a parse failure', () => {
    const result = issueSchema.safeParse({
      id: '00000000-0000-4000-8000-000000000000',
      document_type: 'issue',
      title: 't',
      ticket_number: 1,
      state: 'todo',
      priority: 'medium',
      assignee_id: null,
      belongs_to: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      created_by: null,
      properties: { leaked: true },
    });
    expect(result.success, '`properties` was accepted by issueSchema').toBe(false);
  });

  it('the projection names no internal column', () => {
    for (const forbidden of ['properties', 'content', 'yjs_state', 'position', 'workspace_id']) {
      expect(ISSUE_PROJECTION_FIELDS as readonly string[]).not.toContain(forbidden);
    }
  });
});

describe('Testing Scenario 4 · the four issues routes are declared, not merely mounted', () => {
  const expected = [
    { method: 'GET', path: '/api/v1/issues', scope: 'issues:read', list: 'cursor' },
    { method: 'GET', path: '/api/v1/issues/:id', scope: 'issues:read', list: false },
    { method: 'POST', path: '/api/v1/issues', scope: 'issues:write', list: false },
    { method: 'PATCH', path: '/api/v1/issues/:id', scope: 'issues:write', list: false },
  ] as const;

  for (const route of expected) {
    it(`${route.method} ${route.path} declares ${route.scope} and list=${route.list}`, () => {
      const metadata = routeMetadata.get(route.method, route.path);
      expect(metadata, `${route.method} ${route.path} has no metadata record`).toBeDefined();
      expect(metadata!.scope).toBe(route.scope);
      expect(metadata!.list).toBe(route.list);
      expect(metadata!.response, 'no response schema — L13 cannot document it').toBeDefined();
    });
  }

  it('every scope these routes declare is REGISTERED — not invented', () => {
    // p.3 registers exactly seven scopes and PF-062 asserts exactly seven. A
    // route declaring `issues:list` would satisfy "declares a scope" and still
    // be unenforceable, because `requireScope` resolves against the registry.
    const registered = new Set<string>(scopeRegistry.names());
    for (const route of expected) {
      expect(registered.has(route.scope), `${route.scope} is not in the scope registry`).toBe(true);
    }
  });

  it('the list route binds its cursors to `issues`', () => {
    // PF-218. Without the binding a `/documents` cursor decodes perfectly here
    // and returns a plausible wrong page.
    expect(routeMetadata.get('GET', '/api/v1/issues')!.resource).toBe('issues');
  });
});
