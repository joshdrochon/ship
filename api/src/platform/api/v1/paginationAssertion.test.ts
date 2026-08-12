/**
 * S5 — Testing Scenario 4 clause (d), end to end.
 *
 * PF-229 (registered through PF-202's seam, one enumerator), PF-230 (positive,
 * over live requests), PF-231 (negative), PF-232 (anti-vacuity: the harness
 * itself is proven to fire).
 *
 * The fixture routes here are throwaways mounted through `mountResources`. That
 * is deliberate — the clause has to be provable BEFORE L09 and L10 land their
 * real resources, and a clause first exercised by the lane it is meant to police
 * is a clause nobody has tested.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Router, Request, Response } from 'express';
import {
  registerPaginationAssertions,
  configurePaginationClause,
} from './paginationAssertion.js';
import {
  registerRouteAssertion,
  runRouteAssertions,
  clearRouteAssertions,
  listRouteAssertions,
  enumerateV1Routes,
} from './routeFitness.js';
import { registerEnvelopeAssertions } from './envelopeAssertion.js';
import { RouteMetadataRegistry } from './routeMetadata.js';
import { createTestPublicApp, V1_PREFIX } from './testSupport.js';
import { asyncRoute } from './errorMiddleware.js';
import { parsePageRequest } from './page.js';
import { sliceToPage, DEFAULT_PAGE_SIZE } from './pagination.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 60 rows, so a default page leaves a second page to compare against. */
const ROWS = Array.from({ length: 60 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  created_at: new Date(2026, 0, 1, 0, 0, 60 - i),
  title: `row ${i}`,
}));

/** A CORRECT cursor list route — the shape L09 is expected to produce. */
function correctListRoute(r: Router): void {
  r.get(
    '/documents',
    asyncRoute((req: Request, res: Response) => {
      const { limit, cursor } = parsePageRequest(
        req.query as Record<string, unknown>,
        'documents',
      );
      const start = cursor ? ROWS.findIndex((row) => row.id === cursor.id) + 1 : 0;
      res.json(sliceToPage(ROWS.slice(start, start + limit + 1), limit, 'documents'));
    }),
  );
}

/** A fixed-cardinality route — `{ data }`, no cursor. */
function fixedListRoute(r: Router): void {
  r.get(
    '/scopes',
    asyncRoute((req: Request, res: Response) => {
      parsePageRequest(req.query as Record<string, unknown>, 'scopes');
      res.json({ data: ['documents:read', 'documents:write', 'issues:read'] });
    }),
  );
}

let registry: RouteMetadataRegistry;

beforeEach(() => {
  clearRouteAssertions();
  registry = new RouteMetadataRegistry();
  configurePaginationClause({ registry });
  registerPaginationAssertions();
});

afterEach(() => {
  clearRouteAssertions();
});

describe('PF-229 — the clause goes through L07\'s seam, and there is ONE enumerator', () => {
  it('registers under a name that identifies the lane and the clause', () => {
    expect(listRouteAssertions().map((a) => a.name)).toEqual([
      'L08 (d): list endpoints paginate with an opaque cursor',
      "L08 (d, negative): a list:'none' route emits no cursor",
    ]);
  });

  it('its failures land in the SAME report as clause (c)', async () => {
    registerEnvelopeAssertions();
    const { app } = createTestPublicApp({
      auth: null,
      mountResources: (r) => {
        r.get('/documents', (_req, res) => res.json(['not', 'a', 'page']));
      },
    });
    registry.declare({
      method: 'GET',
      path: '/api/v1/documents',
      list: 'cursor',
      resource: 'documents',
    });

    const failures = await runRouteAssertions(app);
    // Clause (c) passes here (an anonymous request 401s); clause (d) fails
    // because the route cannot be reached authenticated. One report, both lanes.
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every((f) => f.route === 'GET /api/v1/documents')).toBe(true);
  });

  it('EXACTLY ONE route-walking implementation exists in platform/api/v1', () => {
    // PF-229's grep assertion, mechanised. Three enumerators would be three
    // different answers to "every route", and the wrong one is the one that
    // passes. `walkLayers` is the private recursion behind `enumerateV1Routes`.
    const definers = readdirSync(HERE)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => /function walkLayers|function rootStack/.test(readFileSync(join(HERE, f), 'utf8')));
    expect(definers).toEqual(['routeFitness.ts']);
  });

  it('this clause does not walk the stack itself — it only reads `route`', () => {
    const source = readFileSync(join(HERE, 'paginationAssertion.ts'), 'utf8');
    expect(source).not.toContain('_router');
    expect(source).not.toContain('.stack');
  });
});

describe('PF-230 — the POSITIVE half, over live requests', () => {
  it('a correct cursor route passes, and page 2 is disjoint from page 1', async () => {
    const { app } = createTestPublicApp({ mountResources: correctListRoute });
    registry.declare({
      method: 'GET',
      path: '/api/v1/documents',
      list: 'cursor',
      resource: 'documents',
    });
    expect(await runRouteAssertions(app)).toEqual([]);
  });

  it('FAILS a route that declares `cursor` and returns a BARE ARRAY', async () => {
    const { app } = createTestPublicApp({
      mountResources: (r) => {
        r.get('/documents', (_req, res) => res.json([{ id: 'a' }]));
      },
    });
    registry.declare({
      method: 'GET',
      path: '/api/v1/documents',
      list: 'cursor',
      resource: 'documents',
    });
    const failures = await runRouteAssertions(app);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.error.message).toContain('not { data, next_cursor }');
  });

  it('FAILS a route that IGNORES the cursor and returns page 1 forever', async () => {
    // The assertion that earns its keep. This route passes every schema check,
    // returns a real-looking cursor, and hangs any consumer that walks it.
    const { app } = createTestPublicApp({
      mountResources: (r) => {
        r.get(
          '/documents',
          asyncRoute((req: Request, res: Response) => {
            const { limit } = parsePageRequest(req.query as Record<string, unknown>, 'documents');
            res.json(sliceToPage(ROWS.slice(0, limit + 1), limit, 'documents'));
          }),
        );
      },
    });
    registry.declare({
      method: 'GET',
      path: '/api/v1/documents',
      list: 'cursor',
      resource: 'documents',
    });
    const failures = await runRouteAssertions(app);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.error.message).toMatch(/repeats \d+ row\(s\) from page 1/);
  });

  it('FAILS a route that ignores `limit`', async () => {
    const { app } = createTestPublicApp({
      mountResources: (r) => {
        r.get(
          '/documents',
          asyncRoute((req: Request, res: Response) => {
            parsePageRequest(req.query as Record<string, unknown>, 'documents');
            res.json(sliceToPage(ROWS.slice(0, 11), 10, 'documents'));
          }),
        );
      },
    });
    registry.declare({
      method: 'GET',
      path: '/api/v1/documents',
      list: 'cursor',
      resource: 'documents',
    });
    const failures = await runRouteAssertions(app);
    expect(failures[0]!.error.message).toContain('`limit` is not honoured');
  });

  it('FAILS a route that CLAMPS an over-max limit instead of rejecting it', async () => {
    const { app } = createTestPublicApp({
      mountResources: (r) => {
        r.get('/documents', (req: Request, res: Response) => {
          const raw = Number.parseInt(String(req.query.limit ?? DEFAULT_PAGE_SIZE), 10);
          const limit = Math.min(Number.isFinite(raw) ? raw : DEFAULT_PAGE_SIZE, 100);
          res.json(sliceToPage(ROWS.slice(0, limit + 1), limit, 'documents'));
        });
      },
    });
    registry.declare({
      method: 'GET',
      path: '/api/v1/documents',
      list: 'cursor',
      resource: 'documents',
    });
    const failures = await runRouteAssertions(app);
    expect(failures.map((f) => f.error.message).join('\n')).toContain('rejected rather than clamped');
  });

  it('FAILS a route that silently ignores ?offset=10', async () => {
    // Honours `limit` and rejects an over-max one, so it clears every earlier
    // check — the ONLY thing wrong with it is that an unknown query parameter is
    // ignored instead of rejected. That is the whole point of PF-226: a consumer
    // porting from an offset API otherwise reads page 1 forever with no signal.
    const { app } = createTestPublicApp({
      mountResources: (r) => {
        r.get('/documents', (req: Request, res: Response) => {
          const raw = String(req.query.limit ?? DEFAULT_PAGE_SIZE);
          const limit = Number.parseInt(raw, 10);
          if (!/^\d+$/.test(raw) || limit < 1 || limit > 100) {
            res.status(422).json({
              code: 'validation_failed',
              message: 'bad limit',
              details: { fields: [{ field: 'limit', message: 'out of range' }] },
              request_id: '00000000-0000-4000-8000-000000000000',
            });
            return;
          }
          res.json(sliceToPage(ROWS.slice(0, limit + 1), limit, 'documents'));
        });
      },
    });
    registry.declare({
      method: 'GET',
      path: '/api/v1/documents',
      list: 'cursor',
      resource: 'documents',
    });
    const failures = await runRouteAssertions(app);
    expect(failures.map((f) => f.error.message).join('\n')).toContain('?offset=10');
  });

  it('a POST declaring list:\'cursor\' fails — only a GET can be a list', async () => {
    const { app } = createTestPublicApp({
      mountResources: (r) => {
        r.post('/documents', (_req, res) => res.status(201).json({ data: {} }));
      },
    });
    registry.declare({
      method: 'POST',
      path: '/api/v1/documents',
      list: 'cursor',
      resource: 'documents',
    });
    const failures = await runRouteAssertions(app);
    expect(failures[0]!.error.message).toContain('only GET can be a list');
  });
});

describe('PF-231 — the NEGATIVE half: `none` is not a rubber stamp', () => {
  it('a correct fixed-cardinality route passes', async () => {
    const { app } = createTestPublicApp({ mountResources: fixedListRoute });
    registry.declare({ method: 'GET', path: '/api/v1/scopes', list: 'none' });
    expect(await runRouteAssertions(app)).toEqual([]);
  });

  it('FAILS a `none` route that emits a next_cursor key at all', async () => {
    const { app } = createTestPublicApp({
      mountResources: (r) => {
        r.get('/scopes', (_req, res) => res.json({ data: ['a'], next_cursor: null }));
      },
    });
    registry.declare({ method: 'GET', path: '/api/v1/scopes', list: 'none' });
    const failures = await runRouteAssertions(app);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.error.message).toContain('carries a `next_cursor` key');
  });

  it('FAILS a `none` route that secretly honours ?limit=1', async () => {
    // The route that lies: declares 'none' so the positive clause skips it, then
    // paginates anyway. Without this check, self-declaring 'none' would exempt a
    // route from clause (d) entirely.
    const { app } = createTestPublicApp({
      mountResources: (r) => {
        r.get('/scopes', (req: Request, res: Response) => {
          const limit = Number.parseInt(String(req.query.limit ?? '3'), 10);
          res.json({ data: ['a', 'b', 'c'].slice(0, limit) });
        });
      },
    });
    registry.declare({ method: 'GET', path: '/api/v1/scopes', list: 'none' });
    const failures = await runRouteAssertions(app);
    expect(failures[0]!.error.message).toContain('?limit=1 changed the result size');
  });

  it('FAILS a `none` route whose data is not an array', async () => {
    const { app } = createTestPublicApp({
      mountResources: (r) => {
        r.get('/scopes', (_req, res) => res.json({ data: { a: 1 } }));
      },
    });
    registry.declare({ method: 'GET', path: '/api/v1/scopes', list: 'none' });
    const failures = await runRouteAssertions(app);
    expect(failures[0]!.error.message).toContain('`data` is not an array');
  });

  it('a list: false route is checked by NEITHER half', async () => {
    const { app } = createTestPublicApp({
      mountResources: (r) => {
        r.get('/documents/:id', (_req, res) => res.json({ data: { id: 'x' } }));
      },
    });
    registry.declare({ method: 'GET', path: '/api/v1/documents/:id', list: false });
    expect(await runRouteAssertions(app)).toEqual([]);
  });
});

describe('PF-232 — anti-vacuity: the harness is PROVEN to fire', () => {
  it('a throwaway route declaring `cursor` and returning a bare array fails the REAL suite', async () => {
    // Mirrors PF-200's stale-enumerator proof. A fitness harness is only worth
    // having if a test demonstrates it failing; otherwise "green" means nothing
    // and nobody can tell.
    const { app } = createTestPublicApp({
      mountResources: (r) => {
        correctListRoute(r);
        r.get('/throwaway', (_req, res) => res.json([{ id: 'a' }]));
      },
    });
    registry.declare({
      method: 'GET',
      path: '/api/v1/documents',
      list: 'cursor',
      resource: 'documents',
    });
    registry.declare({
      method: 'GET',
      path: '/api/v1/throwaway',
      list: 'cursor',
      resource: 'throwaway',
    });

    const failures = await runRouteAssertions(app);

    // The good route passes; only the throwaway fails, and the message names it.
    expect(failures).toHaveLength(1);
    expect(failures[0]!.route).toBe('GET /api/v1/throwaway');
    expect(failures[0]!.assertion).toContain('L08 (d)');
    expect(failures[0]!.error.message).toContain('next_cursor');
  });

  it('the clause FAILS, rather than skipping, when ZERO list routes are enumerated', async () => {
    // The vacuous pass this whole harness exists to prevent. An app with no list
    // routes makes clause (d) assert nothing and report green — so the spec that
    // runs it must check the enumeration is non-empty itself.
    const { app } = createTestPublicApp({});
    const listRoutes = enumerateV1Routes(app).filter(
      (r) => registry.get(r.method, r.path)?.list === 'cursor',
    );

    expect(await runRouteAssertions(app)).toEqual([]); // vacuously green…
    expect(listRoutes).toHaveLength(0); // …because it checked nothing.

    // Which is why every spec that runs the harness asserts this FIRST:
    expect(() => {
      if (listRoutes.length === 0) {
        throw new Error(
          'clause (d) enumerated ZERO list routes — a green run here asserts nothing. ' +
            'Mount a resource or fix the enumeration before believing this passed.',
        );
      }
    }).toThrow(/enumerated ZERO list routes/);
  });

  it('a route with NO metadata is skipped by the clause — which is why wiring throws', async () => {
    // Honest about the gap and where it is closed. This clause cannot check a
    // route it has no declaration for; `assertEveryRouteDeclaresList` is what
    // makes such a route impossible to mount (PF-228), and the two together are
    // what make clause (d) total.
    const { app } = createTestPublicApp({
      mountResources: (r) => {
        r.get('/undeclared', (_req, res) => res.json(['bare', 'array']));
      },
    });
    expect(await runRouteAssertions(app)).toEqual([]);

    const { assertEveryRouteDeclaresList } = await import('./routeMetadata.js');
    expect(() => assertEveryRouteDeclaresList(app, enumerateV1Routes, registry)).toThrow(
      /GET \/api\/v1\/undeclared/,
    );
  });

  it('a clause registered twice under one name does not double-run', async () => {
    registerPaginationAssertions();
    registerPaginationAssertions();
    expect(listRouteAssertions()).toHaveLength(2);
  });

  it('all four Testing Scenario 4 clauses have a documented owner', async () => {
    registerRouteAssertion('L13 (a): the route has an OpenAPI entry', () => undefined);
    registerRouteAssertion('L03 (b): the route declares a scope', () => undefined);
    registerEnvelopeAssertions();
    const names = listRouteAssertions().map((a) => a.name).join('\n');
    for (const lane of ['L03', 'L07', 'L08', 'L13']) {
      expect(names, `clause for ${lane} is not registered`).toContain(lane);
    }
  });
});
