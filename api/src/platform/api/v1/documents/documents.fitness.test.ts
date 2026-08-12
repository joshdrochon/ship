/**
 * PF-244 / PF-251 / PF-262 / PF-265 — what the v1 documents module may not
 * contain, checked by grep over the module's own source.
 *
 * Every rule here is one that a LINT RULE CANNOT SEE, which is why these are
 * tests and not eslint config:
 *
 *   - `pool.query` inlined in a handler is not an import violation. A handler
 *     that re-implements the list query rather than calling the service passes
 *     PF-009/PF-010 and still breaks p.3's boundary — and it is the likelier
 *     mistake, because inlining one small SELECT never feels like an
 *     architectural decision at the moment it is made.
 *   - `.publish(` in a route is not an import violation either once some other
 *     module has legitimately imported the bus.
 *
 * The greps run over source text with comments stripped, because this
 * directory's files discuss the things they forbid — describing the rule must
 * not be indistinguishable from breaking it.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

describe('PF-244 · the v1 documents module holds no SQL', () => {
  const files = sourceFiles();

  it('has files to check — the check is not vacuous', () => {
    // The failure this guards against is the one this lane found in L03's own
    // fitness test: a green check over zero subjects is not evidence of anything.
    expect(files.map((f) => f.name).sort()).toContain('routes.ts');
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  for (const marker of ['pool.query', 'client.query', 'INSERT INTO', 'SELECT ', 'DELETE FROM', 'UPDATE ']) {
    it(`contains no \`${marker.trim()}\``, () => {
      const offenders = files
        .filter((f) => !f.name.endsWith('.test.ts'))
        .filter((f) => f.code.includes(marker))
        .map((f) => f.name);

      expect(
        offenders,
        `${offenders.join(', ')} contains \`${marker}\`. Data access belongs in ` +
          `documentService (api/src/services/documents.ts) — the same function the ` +
          `internal route calls. A handler with its own query makes ` +
          `docs/architecture.md's Public/Internal Boundary diagram false again.`,
      ).toEqual([]);
    });
  }

  it('imports nothing from api/src/routes/** or api/src/middleware/**', () => {
    // The ESLint fence (PF-009/PF-010) also catches this at build time. Asserted
    // here too because the fence is configuration and configuration can be
    // narrowed by someone who does not know why it is wide.
    for (const file of files) {
      expect(file.code, `${file.name}`).not.toMatch(/from\s+['"][^'"]*\/routes\//);
      expect(file.code, `${file.name}`).not.toMatch(/from\s+['"][^'"]*\/middleware\//);
    }
  });
});

describe('PF-251 · schemas live adjacent to the handler', () => {
  const files = sourceFiles();

  it('no file imports api/src/openapi/schemas/', () => {
    // p.11: "Every public route's request/response schema lives in Zod adjacent
    // to the handler; the generator walks them." `api/src/openapi/schemas/` is 22
    // files and ~130 detached `registerPath()` calls — a hand-written spec that
    // drifts from the routes it describes, which is the failure mode L13 exists
    // to keep out. This is the shape PF-351–378 is written against; changing it
    // later is a change to the generator, not to a route.
    for (const file of files) {
      expect(file.code, `${file.name}`).not.toMatch(/from\s+['"][^'"]*openapi\/schemas/);
    }
  });

  it('the request and response schemas are in this directory', () => {
    const names = files.map((f) => f.name);
    expect(names).toContain('documents.schema.ts');
  });
});

describe('PF-262 · the route layer publishes nothing', () => {
  const files = sourceFiles().filter((f) => !f.name.endsWith('.test.ts'));

  it('contains no `.publish(`', () => {
    // PRD p.3: "Domain layer publishes on writes — never the route layer."
    // L14's `document.created` goes inside `documentService.create`, which
    // already takes an injected bus (PF-262), so PF-404 is an added call rather
    // than a re-plumbing.
    const offenders = files
      .filter((f) => /\.publish\s*\(/.test(f.code))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it('imports no events module', () => {
    for (const file of files) {
      expect(file.code, `${file.name}`).not.toMatch(/from\s+['"][^'"]*webhooks\/(bus|events)/);
    }
  });
});

describe('PF-256 · `position` is never a sort key here', () => {
  const files = sourceFiles().filter((f) => !f.name.endsWith('.test.ts'));

  // `documents.position` is what the INTERNAL list sorts on and what
  // drag-reorder rewrites. Paginating on it means a user reordering a sidebar
  // corrupts a concurrent API walk — exactly what p.3's "cursors are stable
  // across reordering operations" forbids. The public sort is
  // `(created_at DESC, id DESC)`, on columns nothing rewrites.
  //
  // The check is NOT a bare `\bposition\b` grep. `documents.schema.ts` names the
  // column on purpose, in `REJECTED_INTERNAL_FIELDS` — rejecting a field by name
  // is the opposite of sorting by it, and a grep that cannot tell those apart
  // pushes an author to stop naming the field, which is how `position` becomes
  // silently writable. So: the handler module must not name it at all, and the
  // schema module may name it only as a rejection.

  it('routes.ts — the module that builds the request — never names `position`', () => {
    const routes = files.find((f) => f.name === 'routes.ts');
    expect(routes, 'routes.ts must exist for this check to mean anything').toBeTruthy();
    expect(/\bposition\b/.test(routes!.code)).toBe(false);
  });

  it('the schema names `position` only inside the rejected-fields list', () => {
    const schema = files.find((f) => f.name === 'documents.schema.ts');
    const mentions = schema!.code.match(/\bposition\b/g) ?? [];
    // Exactly one mention, and it is inside REJECTED_INTERNAL_FIELDS.
    expect(mentions).toHaveLength(1);
    expect(schema!.code).toMatch(/REJECTED_INTERNAL_FIELDS[\s\S]*'position'/);
  });

  it('no module under this directory sorts, orders or paginates by it', () => {
    for (const file of files) {
      expect(file.code, `${file.name}`).not.toMatch(/ORDER\s+BY[^;]*position/i);
      expect(file.code, `${file.name}`).not.toMatch(/sort[^\n]*position/i);
    }
  });
});
