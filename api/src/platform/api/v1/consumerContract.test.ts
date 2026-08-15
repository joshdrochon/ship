/**
 * S6 — the contract L17/L18's SDK compiles against, and the versioning policy.
 *
 * PF-233 (consumer-shaped walk), PF-234 (additive-only within v1, structurally
 * enforced).
 *
 * ## The rule this file lives by
 *
 * It may import NOTHING from the pagination internals. No `decodeCursor`, no
 * `encodeCursor`, no `CursorPayload`, no database access, no server-side row
 * counting. Everything it knows, it learns from an HTTP response body.
 *
 * That constraint IS the test. `client.documents.iterate()` (PRD p.4 — *"cursors
 * handled internally; consumer code never sees them"*) is an async iterator that
 * has exactly this much information, and if a test needs more than this to walk
 * three pages then the cursor is not opaque and the SDK cannot be written. A
 * spec that reaches into `decodeCursor` to check its own work proves the server
 * is self-consistent, which is not the property anyone needs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Router, Request, Response } from 'express';
import { createTestPublicApp, V1_PREFIX } from './testSupport.js';
import { asyncRoute } from './errorMiddleware.js';
import { parsePageRequest } from './page.js';
import { sliceToPage } from './pagination.js';
import { enumerateV1Routes } from './routeFitness.js';
import { architectureText } from '../../../test/architectureDoc.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 7 rows: at page size 3 that is three pages, the last one short. */
const ROWS = Array.from({ length: 7 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  created_at: new Date(2026, 0, 1, 0, 0, 7 - i),
  title: `row ${i}`,
}));

function documentsRoute(r: Router): void {
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

/**
 * What an SDK's `iterate()` is, reduced to its essentials. Reads `data` and
 * `next_cursor` off the body, passes the cursor back verbatim, stops on null.
 * It knows nothing else and needs nothing else.
 */
async function* iterate(
  app: Parameters<typeof request>[0],
  path: string,
  pageSize: number,
): AsyncGenerator<{ id: string; title: string }> {
  let cursor: string | null = null;
  for (let guard = 0; guard < 20; guard++) {
    const query = cursor === null ? `?limit=${pageSize}` : `?limit=${pageSize}&cursor=${cursor}`;
    const res = await request(app).get(`${path}${query}`);
    if (res.status !== 200) throw new Error(`page fetch returned ${res.status}`);
    for (const item of res.body.data) yield item;
    cursor = res.body.next_cursor;
    if (cursor === null) return;
  }
  throw new Error('iterator did not terminate — next_cursor never became null');
}

describe('PF-233 — the SDK-shaped walk, using only { data, next_cursor }', () => {
  it('walks three pages and sees all seven rows, once each', async () => {
    const { app } = createTestPublicApp({ mountResources: documentsRoute });
    const seen: { id: string }[] = [];
    for await (const item of iterate(app, `${V1_PREFIX}/documents`, 3)) seen.push(item);

    expect(seen).toHaveLength(7);
    expect(new Set(seen.map((r) => r.id)).size).toBe(7);
    expect(seen.map((r) => r.id)).toEqual(ROWS.map((r) => r.id));
  });

  it('the cursor is passed back VERBATIM — no decoding, no re-encoding', async () => {
    // The property that makes the payload changeable later. If a consumer had to
    // understand the cursor to use it, the payload would be a public API.
    const { app } = createTestPublicApp({ mountResources: documentsRoute });
    const page1 = await request(app).get(`${V1_PREFIX}/documents?limit=3`);
    const cursor = page1.body.next_cursor as string;

    const page2 = await request(app).get(`${V1_PREFIX}/documents?limit=3&cursor=${cursor}`);
    expect(page2.status).toBe(200);
    // Not URL-encoded by the client, and it still works — base64url needs none.
    expect(cursor).toBe(encodeURIComponent(cursor));
  });

  it('the walk terminates on next_cursor === null, not on a short page', async () => {
    // A consumer that stops when `data.length < limit` breaks the moment the
    // server returns a short page for any other reason (a filter, a permission
    // check). `next_cursor` is the only termination signal.
    const { app } = createTestPublicApp({ mountResources: documentsRoute });
    const last = await request(app).get(`${V1_PREFIX}/documents?limit=100`);
    expect(last.body.data).toHaveLength(7);
    expect(last.body.next_cursor).toBeNull();
    expect('next_cursor' in last.body).toBe(true);
  });

  it('THIS FILE IMPORTS NO CURSOR INTERNALS — the constraint, mechanised', () => {
    const source = readFileSync(join(HERE, 'consumerContract.test.ts'), 'utf8');
    // The iterator above must not be able to cheat. If any of these ever appear,
    // the walk is no longer proving what a real SDK consumer can do.
    for (const forbidden of ['decodeCursor', 'encodeCursor', 'CursorPayload', 'keysetPredicate']) {
      const uses = source
        .split('\n')
        .filter((line) => line.includes(forbidden) && !line.trim().startsWith('*'))
        .filter((line) => !line.includes('forbidden'));
      expect(uses, `${forbidden} is used outside a comment`).toEqual([]);
    }
  });

  it('a consumer never has to read the cursor to know it is on the last page', async () => {
    const { app } = createTestPublicApp({ mountResources: documentsRoute });
    let pages = 0;
    let cursor: string | null = null;
    do {
      const query = cursor === null ? '?limit=3' : `?limit=3&cursor=${cursor}`;
      const res = await request(app).get(`${V1_PREFIX}/documents${query}`);
      pages += 1;
      cursor = res.body.next_cursor;
    } while (cursor !== null && pages < 10);

    expect(pages).toBe(3); // 3 + 3 + 1
  });
});

describe('PF-234 — additive-only within v1, enforced structurally', () => {
  it('the public router is mounted at exactly ONE version prefix', () => {
    const { app } = createTestPublicApp({ mountResources: documentsRoute });
    const stack =
      (app as unknown as { _router?: { stack: { regexp?: RegExp }[] } })._router?.stack ?? [];
    const versionMounts = stack.filter((l) => /v\d+/.test(l.regexp?.source ?? ''));
    expect(versionMounts).toHaveLength(1);
  });

  it('no registered route path contains a SECOND version segment', () => {
    // The failure this catches: `/api/v1/v2/documents`, or a resource router
    // mounted at `/v2` inside the v1 router during a migration. Either produces
    // two versions served from one stack with one set of middleware.
    const { app } = createTestPublicApp({
      mountResources: (r) => {
        documentsRoute(r);
        r.get('/issues/:id', (_req, res) => res.json({ data: {} }));
      },
    });
    const routes = enumerateV1Routes(app);
    expect(routes.length).toBeGreaterThan(0);

    for (const route of routes) {
      const versionSegments = route.path.split('/').filter((s) => /^v\d+$/.test(s));
      expect(versionSegments, `${route.path} carries ${versionSegments.length} version segments`)
        .toHaveLength(1);
      expect(versionSegments[0]).toBe('v1');
    }
  });

  it('CATCHES a route smuggling a second version segment', () => {
    const { app } = createTestPublicApp({
      mountResources: (r) => {
        r.get('/v2/documents', (_req, res) => res.json({ data: [], next_cursor: null }));
      },
    });
    const offenders = enumerateV1Routes(app).filter(
      (route) => route.path.split('/').filter((s) => /^v\d+$/.test(s)).length > 1,
    );
    expect(offenders.map((o) => o.path)).toEqual(['/api/v1/v2/documents']);
  });

  it('the policy is written down in docs/architecture.md, with its rejected option', () => {
    const architecture = architectureText();
    expect(architecture).toMatch(/additive-only within v1/i);
    expect(architecture).toMatch(/\/api\/v2\//);
    // The rejected option matters as much as the chosen one: p.16 offers three
    // and a doc that records only the winner is a doc that will be re-litigated.
    expect(architecture).toMatch(/deprecation|sunset/i);
  });

  it('no sunset or deprecation headers are emitted this week', async () => {
    // The other half of the decision. Shipping the header without the lifecycle
    // behind it is a promise the project cannot keep.
    const { app } = createTestPublicApp({ mountResources: documentsRoute });
    const res = await request(app).get(`${V1_PREFIX}/documents`);
    expect(res.headers).not.toHaveProperty('sunset');
    expect(res.headers).not.toHaveProperty('deprecation');
  });
});
