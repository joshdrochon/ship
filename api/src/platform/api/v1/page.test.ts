/**
 * S3 — the page envelope and the query-validation matrix.
 *
 * PF-223 (one shape, .strict()), PF-224 (next_cursor present-and-null),
 * PF-225 (limit rejected not clamped), PF-226 (strict query allowlist).
 *
 * The `limit`/`offset`/`fields` cases run over real HTTP against the public
 * router, not against `parseLimit` alone: the ticket's criterion is that they
 * return the envelope with `details.fields[0].field` set, and that is a property
 * of the handler plus the error middleware, not of the parser.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import request from 'supertest';
import type { Router, Request, Response } from 'express';
import {
  pageSchema,
  anyPageSchema,
  assertLastPageShape,
  parseLimit,
  parseCursor,
  parsePageRequest,
  assertAllowedQueryParams,
  POINTED_REJECTIONS,
} from './page.js';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  encodeCursor,
  sliceToPage,
} from './pagination.js';
import { createTestPublicApp, V1_PREFIX } from './testSupport.js';
import { asyncRoute } from './errorMiddleware.js';

const RESOURCE = 'documents';

describe('PF-223 — pageSchema is the ONE list-response shape', () => {
  const schema = pageSchema(z.object({ id: z.string() }));

  it('accepts { data, next_cursor }', () => {
    expect(schema.safeParse({ data: [{ id: 'a' }], next_cursor: 'abc' }).success).toBe(true);
    expect(schema.safeParse({ data: [], next_cursor: null }).success).toBe(true);
  });

  it('REJECTS a bare array', () => {
    expect(schema.safeParse([{ id: 'a' }]).success).toBe(false);
  });

  it('REJECTS an extra top-level key — `total` is a second pagination protocol', () => {
    const result = schema.safeParse({ data: [], next_cursor: null, total: 0 });
    expect(result.success).toBe(false);
  });

  it('REJECTS data: null and a missing data key', () => {
    expect(schema.safeParse({ data: null, next_cursor: null }).success).toBe(false);
    expect(schema.safeParse({ next_cursor: null }).success).toBe(false);
  });

  it('accepts data: [] on an empty result', () => {
    expect(schema.safeParse({ data: [], next_cursor: null }).success).toBe(true);
  });

  it('there is exactly ONE definition — the schema and the serializer share it', () => {
    // Same discipline as PF-199. `anyPageSchema` is built from `pageSchema`, so a
    // change to the shape cannot reach the fitness clause and miss the serializer.
    expect(anyPageSchema.safeParse({ data: [1, 'two', null], next_cursor: null }).success).toBe(true);
    expect(anyPageSchema.safeParse({ data: [], next_cursor: null, meta: {} }).success).toBe(false);
  });
});

describe('PF-224 — next_cursor is PRESENT and null on the last page', () => {
  it('an absent key fails, an explicit null passes', () => {
    expect(() => assertLastPageShape({ data: [], next_cursor: null })).not.toThrow();
    expect(() => assertLastPageShape({ data: [] })).toThrow(/ABSENT/);
  });

  it('the naive `== null` check would pass both — which is why it is not used', () => {
    const absent: Record<string, unknown> = { data: [] };
    const explicit: Record<string, unknown> = { data: [], next_cursor: null };
    // Both are `== null`. Only one is correct.
    expect(absent.next_cursor == null).toBe(true);
    expect(explicit.next_cursor == null).toBe(true);
    // The check that tells them apart:
    expect('next_cursor' in absent).toBe(false);
    expect('next_cursor' in explicit).toBe(true);
  });

  it('exactly 25 rows at page size 25 is ONE request with no phantom final page', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      id: `id-${i}`,
      created_at: new Date(2026, 0, 1, 0, 0, i),
    }));
    const page = sliceToPage(rows, 25, RESOURCE);
    expect(page.data).toHaveLength(25);
    expect(page.next_cursor).toBeNull();
  });
});

describe('PF-225 — limit is REJECTED, not clamped', () => {
  it('absent limit is the default', () => {
    expect(parseLimit(undefined)).toBe(DEFAULT_PAGE_SIZE);
  });

  it('accepts the boundaries', () => {
    expect(parseLimit('1')).toBe(1);
    expect(parseLimit(String(MAX_PAGE_SIZE))).toBe(MAX_PAGE_SIZE);
  });

  it.each(['0', '-1', '101', 'abc', '1.5', '', ' 5 ', '1e2', '0x10', 'Infinity'])(
    'rejects ?limit=%s naming `limit`',
    (raw) => {
      let thrown: unknown;
      try {
        parseLimit(raw);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `?limit=${raw} was accepted`).toBeDefined();
      const details = (thrown as { details: { fields: { field: string }[] } }).details;
      expect(details.fields[0]!.field).toBe('limit');
      expect((thrown as { code: string }).code).toBe('validation_failed');
    },
  );

  it('does NOT clamp 500 to 100 — the reason the decision went this way', () => {
    // A clamp makes `while (data.length === limit)` loop forever: data.length is
    // 100, limit is 500, the condition is never satisfied and never false.
    expect(() => parseLimit('500')).toThrow();
  });

  it('rejects a repeated ?limit=1&limit=2 (an array), rather than picking one', () => {
    expect(() => parseLimit(['1', '2'])).toThrow();
  });
});

describe('PF-226 — the strict query-param allowlist', () => {
  it('accepts limit and cursor', () => {
    expect(() => assertAllowedQueryParams({ limit: '10', cursor: 'abc' })).not.toThrow();
  });

  it('accepts a route\'s own declared filters', () => {
    expect(() => assertAllowedQueryParams({ type: 'wiki' }, ['type'])).not.toThrow();
    expect(() => assertAllowedQueryParams({ type: 'wiki' })).toThrow();
  });

  it.each(Object.keys(POINTED_REJECTIONS))('rejects ?%s with a POINTED message', (param) => {
    let thrown: unknown;
    try {
      assertAllowedQueryParams({ [param]: 'x' });
    } catch (err) {
      thrown = err;
    }
    const details = (thrown as { details: { fields: { field: string; message: string }[] } }).details;
    expect(details.fields[0]!.field).toBe(param);
    expect(details.fields[0]!.message).toBe(POINTED_REJECTIONS[param]);
  });

  it('the offset and page messages point at the cursor — a porting consumer is told what to use', () => {
    expect(POINTED_REJECTIONS.offset).toContain('cursor');
    expect(POINTED_REJECTIONS.page).toContain('cursor');
  });

  it('`fields` is rejected — that is what makes "sparse fieldsets are out of scope" checkable', () => {
    expect(() => assertAllowedQueryParams({ fields: 'title' })).toThrow();
    expect(POINTED_REJECTIONS.fields).toMatch(/not supported/i);
  });

  it('reports EVERY unknown parameter, not just the first', () => {
    let thrown: unknown;
    try {
      assertAllowedQueryParams({ offset: '1', fields: 'title', nonsense: 'x' });
    } catch (err) {
      thrown = err;
    }
    const details = (thrown as { details: { fields: unknown[] } }).details;
    expect(details.fields).toHaveLength(3);
  });

  it('an unknown parameter\'s message lists what IS accepted', () => {
    let thrown: unknown;
    try {
      assertAllowedQueryParams({ nonsense: 'x' }, ['type']);
    } catch (err) {
      thrown = err;
    }
    const details = (thrown as { details: { fields: { message: string }[] } }).details;
    expect(details.fields[0]!.message).toContain('cursor, limit, type');
  });

  it('the allowlist runs BEFORE limit parsing — a porting consumer hears about offset', () => {
    // `?offset=10&limit=999` is one request with two problems. The one that
    // matters is the offset: it tells them their entire pagination model is wrong.
    let thrown: unknown;
    try {
      parsePageRequest({ offset: '10', limit: '999' }, RESOURCE);
    } catch (err) {
      thrown = err;
    }
    const details = (thrown as { details: { fields: { field: string }[] } }).details;
    expect(details.fields.map((f) => f.field)).toEqual(['offset']);
  });
});

describe('PF-218 — parseCursor produces the envelope naming `cursor`', () => {
  it.each([
    ['not-base64', 'not-base64!!'],
    ['empty', ''],
    ['base64 of {}', Buffer.from('{}', 'utf8').toString('base64url')],
    [
      'a cursor for another resource',
      encodeCursor({
        id: '00000000-0000-4000-8000-000000000000',
        timestamp: '2026-01-01T00:00:00.000Z',
        resource: 'issues',
      }),
    ],
  ])('rejects %s', (_name, raw) => {
    let thrown: unknown;
    try {
      parseCursor(raw, RESOURCE);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code: string }).code).toBe('validation_failed');
    const details = (thrown as { details: { fields: { field: string }[] } }).details;
    expect(details.fields[0]!.field).toBe('cursor');
  });

  it('an absent cursor is page 1, not an error', () => {
    expect(parseCursor(undefined, RESOURCE)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Over real HTTP, through the public router and its error middleware.
// ─────────────────────────────────────────────────────────────────────────────

function listRoute(r: Router): void {
  r.get(
    '/documents',
    asyncRoute((req: Request, res: Response) => {
      const { limit } = parsePageRequest(req.query as Record<string, unknown>, RESOURCE, ['type']);
      const rows = Array.from({ length: limit }, (_, i) => ({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        created_at: new Date(2026, 0, 1, 0, 0, i),
      }));
      res.json(sliceToPage(rows, limit, RESOURCE));
    }),
  );
}

describe('S3 over HTTP — the envelope really comes back', () => {
  it('?limit=101 returns 422 with details.fields[0].field === "limit"', async () => {
    const { app } = createTestPublicApp({ mountResources: listRoute });
    const res = await request(app).get(`${V1_PREFIX}/documents?limit=101`);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.details.fields[0].field).toBe('limit');
    expect(res.body.request_id).toBeTruthy();
  });

  it('?offset=10 returns 422 naming `offset`', async () => {
    const { app } = createTestPublicApp({ mountResources: listRoute });
    const res = await request(app).get(`${V1_PREFIX}/documents?offset=10`);
    expect(res.status).toBe(422);
    expect(res.body.details.fields[0].field).toBe('offset');
    expect(res.body.details.fields[0].message).toContain('cursor');
  });

  it('?fields=title returns 422 naming `fields`', async () => {
    const { app } = createTestPublicApp({ mountResources: listRoute });
    const res = await request(app).get(`${V1_PREFIX}/documents?fields=title`);
    expect(res.status).toBe(422);
    expect(res.body.details.fields[0].field).toBe('fields');
  });

  it('?cursor=not-base64 returns 422 naming `cursor`', async () => {
    const { app } = createTestPublicApp({ mountResources: listRoute });
    const res = await request(app).get(`${V1_PREFIX}/documents?cursor=not-base64!!`);
    expect(res.status).toBe(422);
    expect(res.body.details.fields[0].field).toBe('cursor');
  });

  it('no `limit` returns exactly 25 rows and passes pageSchema', async () => {
    const { app } = createTestPublicApp({ mountResources: listRoute });
    const res = await request(app).get(`${V1_PREFIX}/documents`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(DEFAULT_PAGE_SIZE);
    expect(anyPageSchema.safeParse(res.body).success).toBe(true);
    assertLastPageShape(res.body);
  });

  it('a route\'s declared filter passes; an undeclared one does not', async () => {
    const { app } = createTestPublicApp({ mountResources: listRoute });
    expect((await request(app).get(`${V1_PREFIX}/documents?type=wiki`)).status).toBe(200);
    expect((await request(app).get(`${V1_PREFIX}/documents?parent=x`)).status).toBe(422);
  });
});
