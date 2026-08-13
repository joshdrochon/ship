/**
 * PF-359 — Zod schemas live adjacent to the handler. **Enforced, not asked for.**
 *
 * PRD p.11: *"Every public route's request/response schema lives in Zod adjacent
 * to the handler; the generator walks them."*
 *
 * The counter-example is in this repository and is the reason the rule exists:
 * `api/src/openapi/schemas/` is 22 files and ~130 `registerPath()` calls in a
 * directory detached from every handler, with no test binding a registration to
 * a route (finding F12). A convention would not have stopped that; a walk does.
 *
 * ## What "adjacent" means here, precisely
 *
 * A module that calls `declareV1Route(...)` must obtain its `request` /
 * `response` / `params` schemas from **its own file or a sibling in the same
 * directory**. Not from a shared schema tree, and not from another resource's
 * directory. Two exemptions, both structural rather than convenient:
 *
 *   - `../page.js`, `../errors.js` and friends inside `platform/api/v1/` are the
 *     SHARED wire shapes — the page envelope and the error envelope. They are
 *     shared on purpose (PF-361, PF-362 both require it), and a second copy of
 *     either beside each handler is the thing those tickets forbid.
 *   - `zod` itself.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const V1_DIR = join(HERE, '../api/v1');
const PLATFORM_DIR = join(HERE, '..');

/** Every `.ts` under `dir`, recursively, excluding test files. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** Files that call `declareV1Route(` — i.e. the route modules. */
function routeModules(): { file: string; source: string }[] {
  return sources(V1_DIR)
    .concat(sources(HERE))
    .filter((file) => !file.endsWith('declareV1Route.ts'))
    .map((file) => ({ file, source: readFileSync(file, 'utf8') }))
    .filter(({ source }) => /\bdeclareV1Route\s*\(/.test(source));
}

describe('PF-359 — request/response Zod lives beside its handler', () => {
  it('there is at least one route module to check', () => {
    // Anti-vacuity. A walk that finds nothing asserts nothing and reports green.
    expect(routeModules().length).toBeGreaterThan(0);
  });

  it('every route module sources its schemas from its own file or a sibling', () => {
    const violations: string[] = [];

    for (const { file, source } of routeModules()) {
      for (const match of source.matchAll(/from\s+['"](\.[^'"]*)['"]/g)) {
        const specifier = match[1]!;
        // Only imports that look like schema modules matter here; a route module
        // legitimately imports services, errors and the pagination helpers.
        if (!/schema/i.test(specifier)) continue;

        const isSibling = specifier.startsWith('./');
        const isSharedV1 = /^\.\.\/(page|errors|pagination)\.js$/.test(specifier);
        if (isSibling || isSharedV1) continue;

        violations.push(`${file.slice(PLATFORM_DIR.length + 1)} imports ${specifier}`);
      }
    }

    expect(
      violations,
      'A schema that lives away from its handler drifts from it — that is the failure mode ' +
        'PRD p.11 names, and `api/src/openapi/schemas/` is the worked example of it in this repo.',
    ).toEqual([]);
  });

  it('NO file under platform/ imports api/src/openapi/schemas/', () => {
    const offenders: string[] = [];
    for (const file of sources(PLATFORM_DIR)) {
      const source = readFileSync(file, 'utf8');
      if (/from\s+['"][^'"]*openapi\/schemas\//.test(source)) {
        offenders.push(file.slice(PLATFORM_DIR.length + 1));
      }
    }
    expect(
      offenders,
      "The internal 22-file detached schemas/ tree is the counter-example this rule keeps " +
        'out of the public layer.',
    ).toEqual([]);
  });

  it('the documents resource keeps its schemas in a sibling *.schema.ts', () => {
    // Named explicitly rather than left to the general walk, because "the rule
    // holds over the set we have" and "the one resource we shipped follows it"
    // are different claims and the second is the one a reader wants.
    const routes = join(V1_DIR, 'documents/routes.ts');
    const source = readFileSync(routes, 'utf8');
    expect(source).toMatch(/from\s+['"]\.\/documents\.schema\.js['"]/);
    expect(statSync(join(V1_DIR, 'documents/documents.schema.ts')).isFile()).toBe(true);
  });
});
