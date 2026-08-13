/**
 * S5 — Testing Scenario 4 clause (a), both directions, over the REAL app.
 *
 * Tickets: PF-373 (forward parity, registered through L07's seam), PF-375
 * (reverse parity), PF-376 (loud on an empty enumeration or an empty spec),
 * PF-377 (this is what fails the build on drift), PF-378 (`listSpecOperations`
 * is L18's seam and nothing more).
 *
 * PRD p.11: *"The fitness test that asserts spec ↔ route parity is the single
 * best defense against drift."*
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { Router } from 'express';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpenAPIObject } from 'openapi3-ts/oas31';
import { createApp } from '../../app.js';
import { testDeps } from '../../deps.js';
import {
  enumerateV1Routes,
  runRouteAssertions,
  listRouteAssertions,
  clearRouteAssertions,
} from '../api/v1/routeFitness.js';
import { V1_PREFIX } from '../api/v1/testSupport.js';
import { generatePublicOpenAPIDocument } from './registry.js';
import {
  registerOpenApiParityAssertions,
  assertSpecMatchesRoutes,
  assertRouteHasSpecEntry,
  configureParityClause,
} from './specParity.js';
import { listSpecOperations } from './specOperations.js';
import { toOpenApiPath } from './operations.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function realApp() {
  return createApp(testDeps());
}

afterEach(() => {
  configureParityClause({});
});

describe('PF-373 — clause (a) runs through L07\'s seam, not a second route walk', () => {
  beforeEach(() => {
    clearRouteAssertions();
  });

  afterEach(() => {
    clearRouteAssertions();
  });

  it('registers itself as a named assertion', () => {
    registerOpenApiParityAssertions();
    const names = listRouteAssertions().map((a) => a.name);
    expect(names).toContain('L13 (a): every route has an OpenAPI entry');
  });

  it('does not define its own enumerator', () => {
    // Three enumerators would be three different answers to "every route", and
    // the subtly wrong one is the one that passes. L07's audit notes raise this
    // from the other side; this is the check.
    const source = readFileSync(join(HERE, 'specParity.ts'), 'utf8');
    expect(source).toMatch(/registerRouteAssertion/);
    expect(source).not.toMatch(/_router|layer\.route|walkLayers/);
  });

  it('green over every route the REAL app mounts', async () => {
    registerOpenApiParityAssertions();
    const app = realApp();

    const routes = enumerateV1Routes(app);
    expect(routes.length, 'PF-376: an empty enumeration passes vacuously').toBeGreaterThan(0);

    const failures = await runRouteAssertions(app);
    expect(
      failures.map((f) => `${f.assertion} | ${f.route} | ${f.error.message}`),
    ).toEqual([]);
  });

  it('FAILS, naming METHOD /path, for a route with no spec entry', async () => {
    registerOpenApiParityAssertions();

    // A route mounted with a bare `router.get()` — i.e. bypassing
    // `declareV1Route` — which is precisely how a route comes to have no
    // operation. Mounted on its own app so the real one stays clean.
    const app = express();
    const router = Router();
    router.get('/undocumented', (_req, res) => res.json({}));
    app.use(V1_PREFIX, router);

    const failures = await runRouteAssertions(app);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.route).toBe('GET /api/v1/undocumented');
    expect(failures[0]?.error.message).toMatch(/has no OpenAPI entry/);
  });

  it('FAILS when a path is documented for one method and mounted for another', () => {
    const spec: OpenAPIObject = {
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
      paths: { '/thing': { get: { responses: {} } } },
    };
    configureParityClause({ spec });

    expect(() =>
      assertRouteHasSpecEntry({
        route: { method: 'POST', path: `${V1_PREFIX}/thing`, handlers: [] },
        app: express(),
      }),
    ).toThrow(/declares no `post`/);
  });
});

describe('PF-375 — reverse parity: every spec operation maps to a mounted route', () => {
  it('green over the real app', () => {
    const app = realApp();
    assertSpecMatchesRoutes(enumerateV1Routes(app), generatePublicOpenAPIDocument());
  });

  it('FAILS on a hand-added path with no route, naming it', () => {
    const app = realApp();
    const spec = generatePublicOpenAPIDocument();
    // The direction "hand-written specs lie within a week" actually describes: a
    // documented endpoint that does not exist. The forward walk cannot see it.
    (spec.paths as Record<string, unknown>)['/phantom'] = {
      get: { operationId: 'getPhantom', responses: {} },
    };

    expect(() => assertSpecMatchesRoutes(enumerateV1Routes(app), spec)).toThrow(
      /GET \/phantom \(getPhantom\)/,
    );
  });
});

describe('PF-376 — parity fails loudly on an empty input, with distinct messages', () => {
  const spec = generatePublicOpenAPIDocument();

  it('an empty enumeration is an error, not 100% coverage', () => {
    expect(() => assertSpecMatchesRoutes([], spec)).toThrow(/ZERO routes/);
    // 0 of 0 documented is 100%, and p.6 sets the target at 100%.
    expect(() => assertSpecMatchesRoutes([], spec)).toThrow(/0 of 0 routes documented is 100%/);
  });

  it('an empty spec is a DIFFERENT error', () => {
    const empty: OpenAPIObject = { openapi: '3.1.0', info: { title: 't', version: '1' }, paths: {} };
    const routes = enumerateV1Routes(realApp());
    expect(() => assertSpecMatchesRoutes(routes, empty)).toThrow(/ZERO paths/);
  });

  it('the two messages are distinguishable — the causes are unrelated', () => {
    const empty: OpenAPIObject = { openapi: '3.1.0', info: { title: 't', version: '1' }, paths: {} };
    const routes = enumerateV1Routes(realApp());

    let emptyRoutes = '';
    let emptySpec = '';
    try {
      assertSpecMatchesRoutes([], spec);
    } catch (e) {
      emptyRoutes = (e as Error).message;
    }
    try {
      assertSpecMatchesRoutes(routes, empty);
    } catch (e) {
      emptySpec = (e as Error).message;
    }
    expect(emptyRoutes).not.toBe(emptySpec);
  });
});

describe('PF-373/375 — the real app: every mounted route is documented and vice versa', () => {
  it('the two sets are equal, and non-empty', () => {
    const app = realApp();
    // `toOpenApiPath`, not a hand-rolled prefix strip — PF-374's whole point is
    // that one function normalizes for both sides. A second normalizer here
    // would make this assertion measure my string handling, not parity.
    const mounted = enumerateV1Routes(app)
      .map((r) => `${r.method.toLowerCase()} ${toOpenApiPath(r.path)}`)
      .sort();
    const documented = listSpecOperations(generatePublicOpenAPIDocument())
      .map((o) => `${o.method} ${o.path}`)
      .sort();

    expect(mounted.length).toBeGreaterThan(0);
    expect(documented).toEqual(mounted);
  });

  it('covers L09\'s three real routes, L10\'s /me, and the spec endpoint', () => {
    // FLIPPED BY L10 (PF-271/PF-294), not deleted. This exact-equality assertion
    // was written so that a new resource could not enter the spec unnoticed;
    // `GET /me` is that new resource, and this is where it gets noticed.
    //
    // What did NOT change is the point of PF-294: no file under
    // `platform/openapi/` other than the two enumerating TESTS. The generator
    // (`registry.ts`, `operations.ts`, `route.ts`, `specParity.ts`,
    // `staticCopy.ts`) took a fourth operation with no edit at all — it learned
    // about `/me` from the same `declareV1Route()` call that recorded the scope
    // and built the guard.
    const documented = listSpecOperations(generatePublicOpenAPIDocument()).map(
      (o) => `${o.method.toUpperCase()} ${o.path}`,
    );
    expect(documented.sort()).toEqual([
      'GET /documents',
      'GET /documents/{id}',
      'GET /me',
      'GET /openapi.json',
      'POST /documents',
    ]);
  });
});

describe('PF-378 — listSpecOperations is L18\'s seam, and nothing more', () => {
  it('returns {operationId, method, path, scopes} and is non-empty for documents', () => {
    const operations = listSpecOperations(generatePublicOpenAPIDocument());
    expect(operations.length).toBeGreaterThan(0);

    const list = operations.find((o) => o.operationId === 'getDocuments');
    expect(list).toEqual({
      operationId: 'getDocuments',
      method: 'get',
      path: '/documents',
      scopes: ['documents:read'],
    });
  });

  it('reports the unauthenticated operation as requiring no scopes', () => {
    const spec = listSpecOperations(generatePublicOpenAPIDocument()).find(
      (o) => o.path === '/openapi.json',
    );
    expect(spec?.scopes).toEqual([]);
  });

  it('ignores non-operation keys on a path item', () => {
    const doc: OpenAPIObject = {
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
      paths: {
        '/a': {
          summary: 'not an operation',
          description: 'nor this',
          parameters: [],
          get: { operationId: 'getA', responses: {} },
        },
      },
    };
    expect(listSpecOperations(doc).map((o) => o.operationId)).toEqual(['getA']);
  });

  it('imports nothing from sdk/ — L13 asserts nothing about the SDK', () => {
    for (const file of walk(HERE)) {
      const source = readFileSync(file, 'utf8');
      expect(
        /from\s+['"](@ship\/sdk|[^'"]*\/sdk\/)/.test(source),
        `${file.slice(HERE.length + 1)} imports the SDK. Scenario 5's second half is L18's.`,
      ).toBe(false);
    }
  });
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}
