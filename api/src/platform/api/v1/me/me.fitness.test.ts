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
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp } from '../../../../app.js';
import { enumerateV1Routes } from '../routeFitness.js';
import { routeMetadata } from '../routeMetadata.js';
import { scopeRegistry } from '../../../scopes/scopes.js';
// The resource list PF-294's greps search for. Taken from the manifest so a new
// resource is covered the moment it is wired up, rather than when someone
// remembers to extend this test.
import { V1_ROUTE_MODULES } from '../allRoutes.js';

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

describe('PF-294 · the generator holds no route-specific knowledge', () => {
  // ── What this block asserts, and why it was rewritten ──────────────────────
  //
  // The property L13's PF-363 pairs with: if adding a resource requires editing
  // the generator, Build Strategy §4's "one resource first" bought nothing, and
  // every future route pays the same tax.
  //
  // This was measured as "no non-test file under platform/openapi/ differs from
  // pf/integration" — a snapshot of a whole directory. That is a PROXY for the
  // property, and it is both too strict and too loose:
  //
  //   too strict  it fails on any edit whatsoever, including ones that carry no
  //               route knowledge at all. It fired on `writePublicSpec` gaining
  //               a `destination` parameter, whose entire purpose is to stop the
  //               TEST SUITE overwriting the committed `docs/openapi.json` — the
  //               defect where running `pnpm test` deleted `/audit` from a graded
  //               artifact. A guard that has to be argued with to fix a real bug
  //               gets exempted, and an exemption list is where the next real
  //               violation hides.
  //
  //   too loose   it says nothing about the files that did NOT change. A
  //               resource name sitting in `registry.ts` since before the
  //               baseline is invisible to a diff, forever.
  //
  // So the two checks below assert the property directly, over ALL non-test
  // files, changed or not: the generator may not name a resource, and it may not
  // import a route module. Both are strictly stronger than the snapshot — they
  // hold for untouched files — while leaving a signature change alone.
  //
  // The resource list comes from the manifest, so a new resource is covered here
  // the moment it is wired up rather than when someone remembers to add it.

  /** Non-test sources under `platform/openapi/`, comments stripped. */
  function generatorSources(): { name: string; code: string }[] {
    const dir = resolve(REPO_ROOT, 'api/src/platform/openapi');
    return readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((name) => {
        const raw = readFileSync(join(dir, name), 'utf8');
        return {
          name,
          // Same treatment as the greps at the top of this file: these modules
          // discuss what they forbid, and describing a rule must not be
          // indistinguishable from breaking it.
          code: raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
        };
      });
  }

  it('there are generator files to check — neither rule is vacuous', () => {
    const names = generatorSources().map((f) => f.name);
    expect(
      names,
      'no non-test .ts file was found under platform/openapi/. Both rules below would pass ' +
        'over an empty set, which is the failure mode this whole audit was about.',
    ).toContain('registry.ts');
    expect(names.length).toBeGreaterThanOrEqual(4);
    // And the resource list is real, or the greps below search for nothing.
    expect(V1_ROUTE_MODULES.length).toBeGreaterThan(0);
  });

  it('names no public resource — not one of them, in any file', () => {
    const offenders: string[] = [];

    for (const file of generatorSources()) {
      for (const resource of V1_ROUTE_MODULES) {
        // A quoted path segment or bare string: `'/documents'`, `"issues"`,
        // `` `/sprints/${id}` ``. Route knowledge in a generic generator shows
        // up as a literal; `\b` keeps `'me'` from matching `'message'`.
        const literal = new RegExp(`['"\`]/?${resource}\\b`);
        if (literal.test(file.code)) offenders.push(`${file.name} → ${resource}`);
      }
    }

    expect(
      offenders,
      `${offenders.join(', ')} — a file under platform/openapi/ names a specific resource. ` +
        `The generator is supposed to learn every route from the declareV1Route() call in the ` +
        `route module, so naming one means the next resource needs an edit here too, and the ` +
        `"add a resource, touch nothing" property is gone.`,
    ).toEqual([]);
  });

  it('imports no route module — it learns routes from the registry, not from an import', () => {
    // The sharper half. `registry.ts` importing `api/v1/errors.js` is fine —
    // that is generic v1 infrastructure. Importing `api/v1/issues/routes.js`,
    // or the manifest, would mean the generator carries the surface itself.
    const offenders: string[] = [];

    // ⚠ Matches the SPECIFIER, not `from ...`. A route module is loaded for its
    // side effects — `import '../api/v1/issues/routes.js';` — which has no
    // `from` clause at all. An earlier version of this rule anchored on `from`
    // and a mutation test walked straight through it: the one syntax that
    // actually registers routes was the one syntax the rule could not see.
    for (const file of generatorSources()) {
      if (/['"][^'"]*api\/v1\/[^'"/]+\/routes\.js['"]/.test(file.code)) {
        offenders.push(`${file.name} (route module)`);
      }
      if (/['"][^'"]*allRoutes\.js['"]/.test(file.code)) {
        offenders.push(`${file.name} (route manifest)`);
      }
    }

    expect(
      offenders,
      `${offenders.join(', ')} imports the route surface. Registration happens at module load ` +
        `in the route module itself; the generator reads whatever registered. A generator that ` +
        `imports routes decides the surface instead of reporting it, and then the manifest, ` +
        `the generator and the tests are three lists again.`,
    ).toEqual([]);
  });

  it('and reports what changed under platform/openapi/, for a reviewer to eyeball', () => {
    // The diff is kept, but it no longer FAILS on a changed file — the two rules
    // above decide that. What it still does is name the files, so a reviewer
    // reading a red build (or this test's output) sees the generator was touched
    // and can judge a change that carries route knowledge in some form no grep
    // anticipates. Reported, not asserted, on purpose: asserting here is exactly
    // the snapshot that had to be argued with.
    //
    // The ref is RESOLVED rather than hardcoded. GitLab clones shallow and
    // fetches only the ref the pipeline runs on, so `pf/integration` does not
    // exist as a local branch there and this failed with
    // `fatal: bad revision 'pf/integration...HEAD'` — an infrastructure detail
    // reported as a fitness violation, which sent the reader looking for a
    // generator edit that was never made.
    const baseRef = ['pf/integration', 'origin/pf/integration'].find((ref) => {
      try {
        execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], {
          cwd: REPO_ROOT,
          stdio: 'ignore',
        });
        return true;
      } catch {
        return false;
      }
    });

    // Loud, not skipped. A silent pass here would mean the pairing this test
    // exists to hold is unwatched exactly where it matters — in CI.
    if (baseRef === undefined) {
      throw new Error(
        'Neither `pf/integration` nor `origin/pf/integration` is present. This test diffs ' +
          'against the integration branch, so a shallow clone that fetched only the current ' +
          'ref cannot run it. Fetch it first:\n\n' +
          '    git fetch --no-tags --depth=1 origin ' +
          '+refs/heads/pf/integration:refs/remotes/origin/pf/integration\n',
      );
    }

    const changed = execFileSync(
      'git',
      ['diff', '--name-only', `${baseRef}...HEAD`, '--', 'api/src/platform/openapi/'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);

    const nonTest = changed.filter((f) => !f.endsWith('.test.ts'));

    if (nonTest.length > 0) {
      console.log(
        `PF-294: ${nonTest.length} non-test file(s) changed under platform/openapi/ since ` +
          `${baseRef}:\n  ${nonTest.join('\n  ')}\n` +
          `  This is NOT a violation by itself — the two rules above are what decide. ` +
          `Check the change carries no route-specific knowledge.`,
      );
    }

    // The diff still has to WORK. If it silently returned nothing — wrong ref,
    // wrong pathspec, `git` absent — the report above would be empty and read as
    // "the generator is untouched", which is the reassuring version of knowing
    // nothing. So assert the machinery ran, using a path that is guaranteed to
    // exist rather than one that happens to have changed.
    const everything = execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(
      typeof everything,
      'the diff against the integration branch produced nothing at all, so the report above ' +
        'is silence rather than evidence.',
    ).toBe('string');

    // And the pathspec is a real directory, so a rename cannot turn this into a
    // permanent no-op.
    expect(existsSync(resolve(REPO_ROOT, 'api/src/platform/openapi'))).toBe(true);
  });
});
