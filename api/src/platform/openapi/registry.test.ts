/**
 * S1 — the public generator exists, is separate from the internal one, and a
 * generation failure stops the boot.
 *
 * Tickets: PF-351, PF-352, PF-353, PF-354, PF-355, PF-356, PF-357.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import * as zodToOpenapi from '@asteasolutions/zod-to-openapi';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  publicRegistry,
  generatePublicOpenAPIDocument,
  generatePublicOpenAPIDocumentOrDie,
  registerPublicComponents,
  snapshotPublicRegistry,
  PUBLIC_API_VERSION,
  PUBLIC_API_SERVER_URL,
  PUBLIC_SECURITY_SCHEME,
  API_ERROR_COMPONENT,
} from './registry.js';
// Both route modules are imported for their SIDE EFFECT: every operation is
// registered by the `declareV1Route()` call at the top of its module.
import '../api/v1/documents/routes.js';
import './route.js';
import { scopeRegistry } from '../scopes/scopes.js';
import { apiErrorBodySchema } from '../api/v1/errors.js';
// The INTERNAL registry, imported HERE and only here — this test's job is to
// prove the two documents do not overlap, which cannot be done without touching
// both. `platform/openapi/**` itself imports it nowhere, and the grep below is
// what keeps that true.
// Through the barrel, not the bare registry: `openapi/index.ts` imports
// `schemas/index.ts`, and those imports are what run the ~130 `registerPath()`
// calls. Importing `registry.js` alone yields an EMPTY internal document, which
// would make the disjointness assertion below pass without checking anything.
import { generateOpenAPIDocument, registry as internalRegistry } from '../../openapi/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('PF-351 — the public registry is not the internal one', () => {
  it('is a distinct OpenAPIRegistry instance', () => {
    expect(publicRegistry).toBeInstanceOf(OpenAPIRegistry);
    expect(publicRegistry).not.toBe(internalRegistry);
    expect(publicRegistry.definitions.length).toBeGreaterThan(0);
  });

  /**
   * **PF-351's acceptance criterion is wrong as written, and this is the
   * corrected assertion.**
   *
   * The ticket asks for zero overlap between the two documents' `paths` KEYS.
   * Measured: they overlap on `/documents` and `/documents/{id}`, and they do so
   * *because both specs are correct*. A `paths` key is relative to `servers[0]`,
   * the internal document declares `servers: [{url: '/api'}]` and the public one
   * `[{url: '/api/v1'}]`, so the same key under two different servers is two
   * different URLs. Requiring the keys to differ would mean requiring the public
   * resource to be named something other than `documents` — which is a naming
   * change with no benefit, made to satisfy a comparison rather than a property.
   *
   * The property the ticket was reaching for is that the two documents describe
   * **different surfaces**, and that is asserted three ways below: fully
   * qualified URLs are disjoint, the internal-only surface is absent from the
   * public document, and the public document is exactly its own three paths.
   */
  it('describes a different SURFACE from the internal 3.0 document', () => {
    const publicDoc = generatePublicOpenAPIDocument();
    const internalDoc = generateOpenAPIDocument();

    const qualify = (base: string | undefined, paths: object | undefined): string[] =>
      Object.keys(paths ?? {}).map((path) => `${base ?? ''}${path}`);

    const publicUrls = qualify(publicDoc.servers?.[0]?.url, publicDoc.paths);
    const internalUrls = new Set(qualify(internalDoc.servers?.[0]?.url, internalDoc.paths));

    expect(publicUrls.length).toBeGreaterThan(0);
    expect(
      internalUrls.size,
      'the internal registry should hold ~130 registerPath calls across ~90 paths; if this ' +
        'is small the comparison below is vacuous',
    ).toBeGreaterThan(50);

    const overlap = publicUrls.filter((url) => internalUrls.has(url));
    expect(
      overlap,
      'One shared registry instance would publish the entire internal surface as public ' +
        'contract (finding F12). These two documents describe different APIs.',
    ).toEqual([]);
  });

  it('no internal-only path appears in the public document', () => {
    const publicPaths = new Set(Object.keys(generatePublicOpenAPIDocument().paths ?? {}));
    const internalPaths = Object.keys(generateOpenAPIDocument().paths ?? {});

    // Everything the internal spec documents that the public resource set does
    // not cover. If the registries were ever shared, ~87 of these would appear.
    const leaked = internalPaths.filter(
      (path) => publicPaths.has(path) && !path.startsWith('/documents'),
    );
    expect(leaked).toEqual([]);

    // Ship's internal name for the sprints resource is deliberately NOT written
    // here — PF-077 keeps that string in `api/v1/resource-map.ts` alone, and a
    // test naming it would be the leak the map exists to prevent.
    for (const internalOnly of ['/auth/login', '/issues', '/programs', '/team']) {
      expect(
        publicPaths.has(internalOnly),
        `${internalOnly} is internal surface and must not be in the public contract`,
      ).toBe(false);
    }
  });

  it('no file under platform/openapi/ imports api/src/openapi/ — except this test', () => {
    const offenders: string[] = [];
    for (const file of walk(HERE)) {
      if (file.endsWith('registry.test.ts')) continue;
      const source = readFileSync(file, 'utf8');
      // Any relative hop out of platform/ into the internal openapi tree.
      if (/from\s+['"][^'"]*\.\.\/\.\.\/openapi\//.test(source)) {
        offenders.push(file.slice(HERE.length + 1));
      }
    }
    expect(
      offenders,
      'Reuse the npm dependency, duplicate nothing else. Importing the internal registry ' +
        'is how ~130 internal /api paths become public contract.',
    ).toEqual([]);
  });
});

describe('PF-352 — extendZodWithOpenApi is called twice in one process, harmlessly', () => {
  it('.openapi() survives both extensions and neither clobbers the prototype', () => {
    // Both modules have been imported by this file (the internal one above, the
    // platform one through ./registry.js), so both `extendZodWithOpenApi(z)`
    // calls have already run against the same zod singleton. That is the exact
    // condition PF-352 names — and the one a focused unit test would never
    // reproduce, because it only happens in a process that loads both.
    const schema = z.object({ a: z.string() });
    expect(typeof (schema as { openapi?: unknown }).openapi).toBe('function');

    const described = schema.openapi({ description: 'still works' });
    expect(described._def.openapi?.metadata?.description).toBe('still works');

    // Idempotent: extending a third time must not break what already works.
    zodToOpenapi.extendZodWithOpenApi(z);
    expect(z.string().openapi({ description: 'after' })._def.openapi?.metadata?.description).toBe(
      'after',
    );
  });
});

describe('PF-353 / PF-354 — the generator is V31 and the dependency is pinned', () => {
  it('emits openapi === "3.1.0"', () => {
    expect(generatePublicOpenAPIDocument().openapi).toBe('3.1.0');
  });

  it('returns a typed OpenAPIObject, not unknown', () => {
    // The compile-time half: these property accesses do not typecheck against
    // `unknown`, so `pnpm type-check` is the assertion. The runtime half:
    const document = generatePublicOpenAPIDocument();
    expect(document.info.title).toBe('Ship Public API');
    expect(document.paths).toBeTypeOf('object');
  });

  it('the installed build exports OpenApiGeneratorV31', () => {
    expect(typeof zodToOpenapi.OpenApiGeneratorV31).toBe('function');
  });

  it('@asteasolutions/zod-to-openapi is pinned to an exact version', () => {
    const pkg = JSON.parse(
      readFileSync(join(HERE, '../../../package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    const declared = pkg.dependencies['@asteasolutions/zod-to-openapi'];
    expect(
      declared,
      'A range like "7" lets a minor bump change 3.1 emission between two CI runs, ' +
        'silently rewriting the published contract.',
    ).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('PF-355 — info and servers make the base URL derivable', () => {
  it('info.version comes from the one exported constant', () => {
    expect(generatePublicOpenAPIDocument().info.version).toBe(PUBLIC_API_VERSION);
  });

  it('servers[0].url + a paths key reconstructs a real route path', () => {
    const document = generatePublicOpenAPIDocument();
    expect(document.servers?.[0]?.url).toBe(PUBLIC_API_SERVER_URL);
    // The reachability half — that the reconstructed URL actually answers — is
    // asserted against a booted app in `route.test.ts`, which is where an app
    // exists. Here: the concatenation is well-formed and has no doubled prefix.
    for (const path of Object.keys(document.paths ?? {})) {
      const full = `${document.servers?.[0]?.url}${path}`;
      expect(full.startsWith('/api/v1/')).toBe(true);
      expect(full).not.toContain('/api/v1/api/v1');
    }
  });
});

describe('PF-356 — the security scheme carries the scope list from ScopeRegistry', () => {
  const schemes = () =>
    generatePublicOpenAPIDocument().components?.securitySchemes as Record<
      string,
      { type: string; flows?: Record<string, { scopes: Record<string, string> }> }
    >;

  it('is OAuth2, not http-bearer — an http scheme cannot express scopes at all', () => {
    const scheme = schemes()[PUBLIC_SECURITY_SCHEME];
    expect(scheme?.type).toBe('oauth2');
  });

  it('every flow\'s scopes object deep-equals scopeRegistry.list()', () => {
    const expected = Object.fromEntries(
      scopeRegistry.list().map((def) => [def.scope, def.description]),
    );
    expect(Object.keys(expected)).toHaveLength(7); // PF-062's exactly-seven

    const scheme = schemes()[PUBLIC_SECURITY_SCHEME];
    for (const [flowName, flow] of Object.entries(scheme?.flows ?? {})) {
      expect(flow.scopes, `flow ${flowName}`).toEqual(expected);
    }
  });
});

describe('PF-361 — one shared ApiError component, generated from L07\'s schema', () => {
  it('components.schemas.ApiError exists and is generated, not restated', () => {
    const schemas = generatePublicOpenAPIDocument().components?.schemas ?? {};
    expect(schemas[API_ERROR_COMPONENT]).toBeDefined();
    // Generated from the discriminated union, so it is a oneOf over the six codes.
    const component = schemas[API_ERROR_COMPONENT] as { oneOf?: unknown[] };
    expect(component.oneOf).toHaveLength(apiErrorBodySchema.options.length);
  });

  it('every operation declares 401 and 500 — except the unauthenticated spec route', async () => {
    const { V1_UNAUTHENTICATED_PATHS } = await import('../api/v1/router.js');
    const { toOpenApiPath } = await import('./operations.js');
    const anonymous = new Set(V1_UNAUTHENTICATED_PATHS.map(toOpenApiPath));

    const document = generatePublicOpenAPIDocument();
    const missing: string[] = [];

    for (const [path, item] of Object.entries(document.paths ?? {})) {
      for (const [method, operation] of Object.entries(item as Record<string, unknown>)) {
        const responses = (operation as { responses?: Record<string, unknown> }).responses ?? {};
        if (!('500' in responses)) missing.push(`${method.toUpperCase()} ${path}: no 500`);
        // A route mounted above bearer auth cannot produce a 401, and declaring
        // one it can never return would be exactly the hand-written lie this
        // generator exists to make impossible.
        if (!anonymous.has(path) && !('401' in responses)) {
          missing.push(`${method.toUpperCase()} ${path}: no 401`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});

describe('PF-357 — a generation failure refuses the boot', () => {
  /** `z.function()` has no OpenAPI representation; the generator throws on it. */
  function ungenerable(registry: OpenAPIRegistry): void {
    registry.registerPath({
      method: 'get',
      path: '/broken',
      responses: {
        200: { description: 'nope', content: { 'application/json': { schema: z.function() } } },
      },
    });
  }

  it('generatePublicOpenAPIDocumentOrDie throws, naming the offending method + path', () => {
    const registry = new OpenAPIRegistry();
    registerPublicComponents(registry);
    ungenerable(registry);

    expect(() => generatePublicOpenAPIDocumentOrDie(registry)).toThrow(/GET \/broken/);
    expect(() => generatePublicOpenAPIDocumentOrDie(registry)).toThrow(/refusing to start/);
  });

  it('createApp() throws and opens no socket when the registry cannot generate', async () => {
    // Registered on the PROCESS-WIDE registry, because that is what createApp
    // generates from — an injected fixture registry would test a seam nothing
    // uses. Restored in `finally` through the documented escape hatch.
    const restore = snapshotPublicRegistry();
    const { createApp } = await import('../../app.js');
    const { testDeps } = await import('../../deps.js');

    // Sanity: it boots cleanly before the sabotage. Without this the assertion
    // below could pass for an unrelated reason.
    expect(() => createApp(testDeps())).not.toThrow();

    ungenerable(publicRegistry);
    try {
      expect(() => createApp(testDeps())).toThrow(/OpenAPI document could not be generated/);
    } finally {
      restore();
    }

    // And it boots again once the bad registration is gone — proving the throw
    // was the sabotage and not a leaked side effect.
    expect(() => createApp(testDeps())).not.toThrow();
  });
});

/** Every `.ts` under `dir`, recursively. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}
