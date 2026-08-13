/**
 * PF-271 / PF-274 / PF-294 / PF-295 — what the v1 `me` module may not contain,
 * and what the shipped route must satisfy.
 *
 * Same shape and same reasoning as `documents/documents.fitness.test.ts`: every
 * rule here is one a LINT RULE CANNOT SEE. An inlined `pool.query` in a handler
 * is not an import violation, and a `.publish(` in a route is not one either
 * once some other module has legitimately imported the bus.
 *
 * The greps run over source text with comments stripped, because this
 * directory's files discuss the things they forbid — describing a rule must not
 * be indistinguishable from breaking it.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp } from '../../../../app.js';
import { enumerateV1Routes } from '../routeFitness.js';
import { routeMetadata } from '../routeMetadata.js';
import { scopeRegistry } from '../../../scopes/scopes.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '../../../../../..');

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

describe('the v1 me module holds no SQL and no internal imports', () => {
  const files = sourceFiles();

  it('has files to check — the check is not vacuous', () => {
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
        `${offenders.join(', ')} contains \`${marker}\`. The user lookup belongs in ` +
          `identityService (api/src/services/identity.ts), which takes plain values and ` +
          `not a request — that is what makes PF-273's "resolves from the token, never ` +
          `from a session" a property of the code rather than of the test.`,
      ).toEqual([]);
    });
  }

  it('imports nothing from api/src/routes/** or api/src/middleware/**', () => {
    for (const file of files) {
      expect(file.code, `${file.name}`).not.toMatch(/from\s+['"][^'"]*\/routes\//);
      expect(file.code, `${file.name}`).not.toMatch(/from\s+['"][^'"]*\/middleware\//);
    }
  });

  it('contains no `.publish(` and imports no events module', () => {
    // PRD p.3: "Domain layer publishes on writes — never the route layer."
    // `me` performs no write and therefore raises no event, but the grep is
    // lane-wide and a reader should not have to wonder whether this directory is
    // an exception.
    for (const file of files.filter((f) => !f.name.endsWith('.test.ts'))) {
      expect(file.code, `${file.name}`).not.toContain('.publish(');
      expect(file.code, `${file.name}`).not.toMatch(/from\s+['"][^'"]*webhooks\//);
    }
  });

  it('never reads req.userId, req.workspaceId or a session — PF-273 by grep', () => {
    // The wrong implementation of this route, spelled out. `me` answering "who
    // is this browser" would pass a naive test, because a test that sets up both
    // a session and a token usually gives them to the same person.
    for (const file of files.filter((f) => !f.name.endsWith('.test.ts'))) {
      expect(file.code, `${file.name}`).not.toMatch(/req\.(userId|workspaceId|session)/);
      expect(file.code, `${file.name}`).not.toContain('requireAuth');
    }
  });
});

describe('PF-274 · no secret can reach the body, by construction', () => {
  const files = sourceFiles().filter((f) => !f.name.endsWith('.test.ts'));

  it('the app projection is built field by field, never spread from the app row', () => {
    // `...app` in the response object would put `clientSecretHash` on the wire
    // verbatim. The route builds `{client_id, name}` explicitly for this reason,
    // and this is the assertion that keeps it that way.
    for (const file of files) {
      expect(file.code, `${file.name} spreads an app row into a response`).not.toMatch(
        /\.\.\.\s*app\b/,
      );
    }
  });

  it('the handler names no secret field at all', () => {
    // `routes.ts` ONLY, and the exclusion is deliberate rather than convenient:
    // `me.schema.ts` names `client_secret` and `client_secret_hash` on purpose,
    // in `REJECTED_INTERNAL_ME_FIELDS`, so that `me.routes.test.ts` can assert
    // their absence from the wire by iterating data instead of restating a list
    // that drifts. Forbidding the name everywhere would forbid the mechanism
    // that checks for it.
    const handler = files.find((f) => f.name === 'routes.ts');
    expect(handler, 'routes.ts is missing').toBeDefined();
    expect(handler!.code).not.toContain('clientSecretHash');
    expect(handler!.code).not.toContain('client_secret');
  });
});

describe('PF-271 · the route ships with an explicitly declared null scope', () => {
  const app = createApp();

  it('GET /api/v1/me is mounted by the composition root', () => {
    const mounted = enumerateV1Routes(app).map((r) => `${r.method} ${r.path}`);
    expect(mounted).toContain('GET /api/v1/me');
  });

  it('its metadata carries scope: null — declared, not absent', () => {
    // The distinction B6 exists for. `null` and `undefined` are different
    // claims: `undefined` is "nobody thought about it" and fails
    // `assertEveryRouteDeclaresScope` at wiring time; `null` is "this route
    // requires none", which the audit honours.
    const metadata = routeMetadata.get('GET', '/api/v1/me');
    expect(metadata, 'GET /api/v1/me has no metadata record').toBeDefined();
    expect(metadata!.scope).toBeNull();
    expect(metadata!.scope).not.toBeUndefined();
  });

  it('declares list: false — it is not a collection', () => {
    // NOT `'none'`, which PF-275 asked for. `'none'` means "a collection whose
    // cardinality is bounded by code" and L08's negative clause asserts such a
    // route's body has an ARRAY at `data`. `me` returns one object. See the long
    // note in `routes.ts`.
    expect(routeMetadata.get('GET', '/api/v1/me')!.list).toBe(false);
  });

  it('no eighth scope was invented to carry it', () => {
    // PRD p.3 registers exactly seven and PF-062 asserts exactly seven; MVP gate
    // item 6 resolves through that assertion. Inventing `me:read` would have
    // satisfied a fitness test by breaking a graded one.
    expect(scopeRegistry.size).toBe(7);
    expect(scopeRegistry.list().map((s) => s.scope)).not.toContain('me:read');
  });
});

describe('PF-294 · /me landed with zero lines changed under platform/openapi/', () => {
  it('the generator is byte-identical to pf/integration; only its tests moved', () => {
    // The pairing L13's PF-363 declares from the generator's side: if adding a
    // resource requires editing the generator, Build Strategy §4's "one resource
    // first" bought nothing.
    //
    // Measured against the merge-base rather than against a file list, so it
    // cannot be satisfied by a reviewer's memory of what was touched.
    const changed = execFileSync(
      'git',
      ['diff', '--name-only', 'pf/integration...HEAD', '--', 'api/src/platform/openapi/'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);

    const nonTest = changed.filter((f) => !f.endsWith('.test.ts'));

    expect(
      nonTest,
      `${nonTest.join(', ')} changed under platform/openapi/. The generator learns about a ` +
        `new route from the declareV1Route() call in the route module; needing an edit here ` +
        `means it is not generic and the next resource will need one too.`,
    ).toEqual([]);

    // Anything that DID change under this directory is an enumerating
    // assertion, flipped deliberately with a note saying what it replaced. The
    // exemption is narrow on purpose: a `.test.ts` here can only assert, so
    // changing one cannot make the generator less generic — but it CAN hide a
    // route, which is why the change has to be visible rather than silent.
    expect(
      changed.filter((f) => !f.endsWith('.test.ts')),
      'a non-test file under platform/openapi/ changed',
    ).toEqual([]);
  });
});
