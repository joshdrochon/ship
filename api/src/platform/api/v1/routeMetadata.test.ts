/**
 * S4 — PF-227 (where the pagination line falls) and PF-228 (route metadata,
 * required, enforced at wiring time).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import {
  RouteMetadataRegistry,
  assertEveryRouteDeclaresList,
  auditRouteMetadata,
  PAGINATION_LINE,
} from './routeMetadata.js';
import { enumerateV1Routes } from './routeFitness.js';
import { createTestPublicApp } from './testSupport.js';

let registry: RouteMetadataRegistry;

beforeEach(() => {
  registry = new RouteMetadataRegistry();
});

describe('PF-228 — `list` is required and there is no default', () => {
  it('accepts a well-formed cursor route', () => {
    expect(() =>
      registry.declare({
        method: 'GET',
        path: '/api/v1/documents',
        list: 'cursor',
        resource: 'documents',
        scope: 'documents:read',
      }),
    ).not.toThrow();
  });

  it('THROWS naming METHOD /path when `list` is missing', () => {
    expect(() =>
      registry.declare({
        method: 'GET',
        path: '/api/v1/documents',
        // @ts-expect-error — the point of the ticket: this must not compile OR run
        list: undefined,
      }),
    ).toThrow(/GET \/api\/v1\/documents: route metadata is missing the required `list` field/);
  });

  it('THROWS when list:\'cursor\' carries no resource — cursors are bound to a collection', () => {
    expect(() =>
      registry.declare({ method: 'GET', path: '/api/v1/issues', list: 'cursor' }),
    ).toThrow(/must also declare `resource`/);
  });

  it('THROWS on a duplicate declaration rather than letting the last one win', () => {
    registry.declare({ method: 'GET', path: '/api/v1/scopes', list: 'none' });
    expect(() =>
      registry.declare({ method: 'GET', path: '/api/v1/scopes', list: 'none' }),
    ).toThrow(/declared twice/);
  });

  it('accepts list: false for a non-collection route', () => {
    expect(() =>
      registry.declare({ method: 'POST', path: '/api/v1/documents', list: false }),
    ).not.toThrow();
    expect(registry.get('POST', '/api/v1/documents')?.list).toBe(false);
  });

  it('GET and POST on one path are two separate records', () => {
    registry.declare({ method: 'GET', path: '/api/v1/documents', list: 'cursor', resource: 'documents' });
    registry.declare({ method: 'POST', path: '/api/v1/documents', list: false });
    expect(registry.list()).toHaveLength(2);
    expect(registry.get('GET', '/api/v1/documents')?.list).toBe('cursor');
    expect(registry.get('POST', '/api/v1/documents')?.list).toBe(false);
  });

  it('carries L03\'s scope on the SAME record — one metadata object per route', () => {
    registry.declare({
      method: 'GET',
      path: '/api/v1/documents',
      list: 'cursor',
      resource: 'documents',
      scope: 'documents:read',
    });
    const record = registry.get('GET', '/api/v1/documents')!;
    expect(record.scope).toBe('documents:read');
    expect(record.list).toBe('cursor');
  });

  it('auditRouteMetadata reports a route with no scope (L03 PF-072)', () => {
    registry.declare({ method: 'GET', path: '/api/v1/documents', list: 'cursor', resource: 'documents' });
    expect(auditRouteMetadata(registry)).toEqual([
      { route: 'GET /api/v1/documents', problem: 'no scope declared (L03 PF-072)' },
    ]);
  });
});

describe('PF-228 — enforcement at WIRING time, against the live stack', () => {
  it('a mounted route with no metadata record throws, naming METHOD /path', () => {
    const { app } = createTestPublicApp({
      mountResources: (r) => {
        r.get('/documents', (_req, res) => res.json({ data: [], next_cursor: null }));
      },
    });

    expect(() => assertEveryRouteDeclaresList(app, enumerateV1Routes, registry)).toThrow(
      /GET \/api\/v1\/documents/,
    );
    expect(() => assertEveryRouteDeclaresList(app, enumerateV1Routes, registry)).toThrow(
      /route\(s\) mounted with no metadata record/,
    );
  });

  it('passes once the route is declared', () => {
    const { app } = createTestPublicApp({
      mountResources: (r) => {
        r.get('/documents', (_req, res) => res.json({ data: [], next_cursor: null }));
      },
    });
    registry.declare({
      method: 'GET',
      path: '/api/v1/documents',
      list: 'cursor',
      resource: 'documents',
    });
    expect(() => assertEveryRouteDeclaresList(app, enumerateV1Routes, registry)).not.toThrow();
  });

  it('reports EVERY undeclared route, not just the first', () => {
    const { app } = createTestPublicApp({
      mountResources: (r) => {
        r.get('/documents', (_req, res) => res.json({ data: [] }));
        r.post('/documents', (_req, res) => res.status(201).json({ data: {} }));
        r.get('/issues', (_req, res) => res.json({ data: [] }));
      },
    });
    let message = '';
    try {
      assertEveryRouteDeclaresList(app, enumerateV1Routes, registry);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('3 /api/v1 route(s)');
    expect(message).toContain('GET /api/v1/documents');
    expect(message).toContain('POST /api/v1/documents');
    expect(message).toContain('GET /api/v1/issues');
  });

  it('an app with no v1 routes passes vacuously — and that is honest, not a hole', () => {
    // The vacuous case is genuinely fine HERE: zero mounted routes means zero
    // routes missing metadata. The non-vacuity that matters belongs to clause
    // (d) itself (PF-230 fails when zero list routes are enumerated), not to
    // this wiring check.
    const bare = express();
    expect(() => assertEveryRouteDeclaresList(bare, enumerateV1Routes, registry)).not.toThrow();
  });

  it('exempt paths are skipped — the seam for routes another lane owns entirely', () => {
    const { app } = createTestPublicApp({
      mountResources: (r) => {
        r.get('/documents', (_req, res) => res.json({ data: [] }));
      },
    });
    expect(() =>
      assertEveryRouteDeclaresList(app, enumerateV1Routes, registry, ['/api/v1/documents']),
    ).not.toThrow();
  });
});

describe('PF-227 — the pagination line, written down', () => {
  it('the rule is bounded-by-code vs bounded-by-data, NOT small vs large', () => {
    expect(PAGINATION_LINE.test).toContain('bounded-by-code');
    expect(PAGINATION_LINE.test).toContain('not small vs. large');
    expect(PAGINATION_LINE.rule).toContain('database table');
    expect(PAGINATION_LINE.rule).toContain('no next_cursor');
  });

  it('the registry endpoints declare `none` EXPLICITLY, not by omission', () => {
    // PF-231's premise. `none` has to be a positive declaration, because the
    // whole point of the negative clause is that a route cannot opt out of
    // pagination by saying nothing.
    registry.declare({ method: 'GET', path: '/api/v1/scopes', list: 'none' });
    registry.declare({ method: 'GET', path: '/api/v1/events', list: 'none' });
    expect(registry.get('GET', '/api/v1/scopes')?.list).toBe('none');
    expect(registry.get('GET', '/api/v1/events')?.list).toBe('none');
  });

  it('the rule is documented in platform/README.md and docs/architecture.md', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));

    const readme = readFileSync(join(here, '..', '..', 'README.md'), 'utf8');
    const architecture = readFileSync(
      join(here, '..', '..', '..', '..', '..', 'docs', 'architecture.md'),
      'utf8',
    );

    for (const [name, text] of [['platform/README.md', readme], ['docs/architecture.md', architecture]] as const) {
      expect(text, `${name} does not record the pagination line (PF-227)`).toMatch(
        /bounded by code|bounded-by-code/i,
      );
    }
  });
});
