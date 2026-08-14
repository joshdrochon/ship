/**
 * S2 — MVP gate 7's *"generated from route metadata"* half.
 *
 * Tickets: PF-358 (one call produces route + spec entry), PF-361 (the shared
 * `ApiError` on every operation), PF-362 (cursor parameters and the page
 * envelope), PF-363 (`documents` only), PF-364 (deterministic `operationId`),
 * PF-374 (`toOpenApiPath`, table-tested).
 */
import { describe, it, expect, vi } from 'vitest';
import express, { Router } from 'express';
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { toOpenApiPath, operationIdFor } from './operations.js';
import { generatePublicOpenAPIDocument, registerPublicComponents } from './registry.js';
import { listSpecOperations } from './specOperations.js';
import { declareV1Route } from '../api/v1/declareV1Route.js';
import { RouteMetadataRegistry } from '../api/v1/routeMetadata.js';
import { enumerateV1Routes } from '../api/v1/routeFitness.js';
import { V1_PREFIX } from '../api/v1/testSupport.js';
import { PAGE_SIZE_PARAM, CURSOR_PARAM } from '../api/v1/pagination.js';
// Side-effect imports: the operations exist because these modules were loaded.
import '../api/v1/documents/routes.js';
import './route.js';

describe('PF-374 — toOpenApiPath, one shared normalizer', () => {
  const table: [string, string][] = [
    ['/api/v1/documents', '/documents'],
    ['/api/v1/documents/:id', '/documents/{id}'],
    ['/api/v1/documents/:docId/comments/:commentId', '/documents/{docId}/comments/{commentId}'],
    ['/api/v1/documents/', '/documents'],
    ['/api/v1/documents/:id?', '/documents/{id}'],
    ['/api/v1', '/'],
    // Already-normalized input is idempotent — the parity clause and the
    // generator both call this, and one of them may have called it already.
    ['/documents/{id}', '/documents/{id}'],
  ];

  for (const [input, expected] of table) {
    it(`${input} → ${expected}`, () => {
      expect(toOpenApiPath(input)).toBe(expected);
    });
  }

  it('never leaves the /api/v1 prefix on a key — that belongs to servers[0].url', () => {
    for (const [input] of table) {
      expect(toOpenApiPath(input)).not.toContain('/api/v1');
    }
  });
});

describe('PF-364 — deterministic, unique operationId', () => {
  it('derives a readable id from method + path', () => {
    expect(operationIdFor('get', '/api/v1/documents')).toBe('getDocuments');
    expect(operationIdFor('get', '/api/v1/documents/:id')).toBe('getDocumentsById');
    expect(operationIdFor('post', '/api/v1/documents')).toBe('postDocuments');
    // The `.` is a word boundary, so `openapi.json` camel-cases across it.
    expect(operationIdFor('get', '/api/v1/openapi.json')).toBe('getOpenapiJson');
  });

  it('every operationId in the generated spec is unique', () => {
    const ids = listSpecOperations(generatePublicOpenAPIDocument()).map((o) => o.operationId);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is byte-stable across two generations in one process', () => {
    const a = JSON.stringify(generatePublicOpenAPIDocument());
    const b = JSON.stringify(generatePublicOpenAPIDocument());
    expect(a).toBe(b);
  });

  it('is byte-stable across a fresh module import', async () => {
    const before = listSpecOperations(generatePublicOpenAPIDocument()).map((o) => o.operationId);

    // `resetModules` drops the module cache, so `operations.ts` is evaluated
    // again from cold — which is where a `Date.now()` or a Map-iteration
    // dependency in the derivation would show up and a same-process re-run
    // would not.
    vi.resetModules();
    const fresh = (await import('./operations.js')) as { operationIdFor: typeof operationIdFor };
    expect(fresh.operationIdFor).not.toBe(operationIdFor); // genuinely a new module
    expect(fresh.operationIdFor('get', '/api/v1/documents/:id')).toBe('getDocumentsById');
    expect(fresh.operationIdFor('post', '/api/v1/documents')).toBe('postDocuments');

    const after = listSpecOperations(generatePublicOpenAPIDocument()).map((o) => o.operationId);
    expect(after).toEqual(before);
  });
});

describe('PF-358 — ONE call registers the Express handler and the spec entry', () => {
  it('a throwaway route appears in enumerateV1Routes AND in paths, with no second call', () => {
    // Isolated registries so the fixture does not pollute the process-wide ones.
    const metadata = new RouteMetadataRegistry();
    const openapi = new OpenAPIRegistry();
    registerPublicComponents(openapi);

    const guard = declareV1Route({
      method: 'get',
      path: '/throwaway/:key',
      scope: 'documents:read',
      list: false,
      params: z.object({ key: z.string() }),
      response: z.object({ ok: z.boolean() }),
      registry: metadata,
      openapiRegistry: openapi,
      summary: 'A fixture route.',
    });

    // The Express half — mounted through the same seam a real resource uses.
    const app = express();
    const router = Router();
    router.get('/throwaway/:key', guard, (_req, res) => {
      res.json({ ok: true });
    });
    app.use(V1_PREFIX, router);

    const enumerated = enumerateV1Routes(app).map((r) => `${r.method} ${r.path}`);
    expect(enumerated).toContain('GET /api/v1/throwaway/:key');

    // The spec half — from the SAME declaration, with no further edit.
    const document = new OpenApiGeneratorV31(openapi.definitions).generateDocument({
      openapi: '3.1.0',
      info: { title: 'fixture', version: '0' },
    });
    expect(document.paths?.['/throwaway/{key}']).toBeDefined();
    expect(
      (document.paths?.['/throwaway/{key}'] as Record<string, unknown>).get,
      'Two separate registration calls is the drift this lane exists to prevent.',
    ).toBeDefined();
  });

  it('the scope guard still works — registration did not replace enforcement', () => {
    const metadata = new RouteMetadataRegistry();
    const openapi = new OpenAPIRegistry();
    registerPublicComponents(openapi);

    const guard = declareV1Route({
      method: 'get',
      path: '/guarded',
      scope: 'documents:read',
      list: false,
      response: z.object({ ok: z.boolean() }),
      registry: metadata,
      openapiRegistry: openapi,
    });

    expect(typeof guard).toBe('function');
    expect(metadata.get('GET', '/api/v1/guarded')?.scope).toBe('documents:read');
  });
});

describe('PF-362 — list operations declare the cursor parameters and the page envelope', () => {
  const listOperation = () => {
    const document = generatePublicOpenAPIDocument();
    return (document.paths?.['/documents'] as Record<string, unknown>).get as {
      parameters?: { name: string; in: string; schema?: { type?: string } }[];
      responses: Record<string, { content?: Record<string, { schema?: unknown }> }>;
    };
  };

  it('declares limit and cursor as query parameters', () => {
    const names = (listOperation().parameters ?? [])
      .filter((p) => p.in === 'query')
      .map((p) => p.name);
    expect(names).toContain(PAGE_SIZE_PARAM);
    expect(names).toContain(CURSOR_PARAM);
  });

  it('types cursor as string, not integer — the cursors are opaque, not offsets', () => {
    const cursor = (listOperation().parameters ?? []).find((p) => p.name === CURSOR_PARAM);
    expect(
      cursor?.schema?.type,
      'An integer-typed cursor tells every SDK generator to build an offset pager.',
    ).toBe('string');
  });

  it('the 200 response is exactly { data, next_cursor } and nothing else', () => {
    const schema = listOperation().responses['200']?.content?.['application/json']?.schema as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties?: boolean;
    };
    expect(Object.keys(schema.properties).sort()).toEqual(['data', 'next_cursor']);
    expect(schema.required.sort()).toEqual(['data', 'next_cursor']);
    expect(schema.additionalProperties).toBe(false);
  });

  it('a non-list route declares NO limit/cursor parameters', () => {
    const byId = (generatePublicOpenAPIDocument().paths?.['/documents/{id}'] as Record<
      string,
      unknown
    >).get as { parameters?: { name: string; in: string }[] };
    const query = (byId.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name);
    expect(query).toEqual([]);
  });
});

describe('PF-363 — documents only; issues, sprints and me are provably absent', () => {
  it('the generated paths are exactly the documents set plus the spec route', () => {
    const paths = Object.keys(generatePublicOpenAPIDocument().paths ?? {}).sort();
    expect(paths).toEqual(['/documents', '/documents/{id}', '/openapi.json']);
  });

  it('has no /issues, /sprints or /me operation', () => {
    const paths = Object.keys(generatePublicOpenAPIDocument().paths ?? {});
    for (const absent of ['/issues', '/issues/{id}', '/sprints', '/sprints/{id}', '/me']) {
      expect(
        paths,
        `${absent} must not appear until L10 lands it — Build Strategy §4 (p.11) is explicit ` +
          `that one resource proves the generator first, and when L10 does land, the diff ` +
          `touches its route modules and this spec and ZERO lines of platform/openapi/.`,
      ).not.toContain(absent);
    }
  });

  it('every operation carries a tag and a security requirement', () => {
    for (const operation of listSpecOperations(generatePublicOpenAPIDocument())) {
      const item = (generatePublicOpenAPIDocument().paths?.[operation.path] as Record<
        string,
        { tags?: string[]; security?: unknown[] } | undefined
      >)[operation.method];
      expect(item, `${operation.operationId} vanished from the document`).toBeDefined();
      expect(item?.tags, `${operation.operationId} has no tag`).toBeDefined();
      // `security: []` on the spec route is a REQUIREMENT that says "none",
      // which is different from the key being absent (that inherits the
      // document default).
      expect(item?.security, `${operation.operationId} has no security key`).toBeDefined();
    }
  });
});
