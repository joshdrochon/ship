/**
 * PF-263 / PF-264 / PF-265 — the publish site, the unregressed internal surface,
 * and exactly one mounted resource.
 *
 * These are the three checks that are about what this lane did NOT change, plus
 * the substrate L14 lands on.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { pool } from '../../../../db/client.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBearerTestApp, type BearerTestApp } from '../../../oauth/bearerTestSupport.js';
import { createDocumentService } from '../../../../services/documents.js';
import { mountDocuments } from './routes.js';
import { createApp } from '../../../../app.js';
import { enumerateV1Routes } from '../routeFitness.js';
import { routeMetadata } from '../routeMetadata.js';

const BASELINE = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../../../docs/baseline-part1.json', import.meta.url)), 'utf8'),
) as {
  routes: Record<string, { queriesPerRequest: number }>;
  budget?: { maxRegressionPercent?: number };
};

describe('PF-265 · documents is the only resource mounted', () => {
  const app = createApp();

  it('enumerateV1Routes returns exactly the three documents routes + the spec', () => {
    // Build Strategy §4 (p.11): "Get the generator working end-to-end with one
    // resource (documents) before adding issues, sprints, and me." L13 proves
    // out against this resource alone (PF-363) and asserts the same thing from
    // the generator's side.
    //
    // `/openapi.json` joined this list when L13 landed (PF-365). It is not a
    // resource — it is the contract describing the three below, mounted through
    // the `mountUnauthenticated` seam rather than `mountResources`. The
    // resource-only claim is the assertion below it, which is the one Build
    // Strategy §4 is actually about.
    const routes = enumerateV1Routes(app)
      .map((r) => `${r.method} ${r.path}`)
      .sort();

    expect(routes).toEqual([
      'GET /api/v1/documents',
      'GET /api/v1/documents/:id',
      'GET /api/v1/openapi.json',
      'POST /api/v1/documents',
    ]);
  });

  it('no mounted route path matches /issues, /sprints or /me', () => {
    const paths = enumerateV1Routes(app).map((r) => r.path);
    for (const absent of ['/api/v1/issues', '/api/v1/sprints', '/api/v1/me']) {
      expect(paths.filter((p) => p.startsWith(absent)), `${absent} is mounted`).toEqual([]);
    }
  });

  it('every mounted route carries a complete metadata record', () => {
    // PF-248 from the reading side. `createApp()` already throws at wiring time
    // on a missing `list` or `scope`; this asserts the record is actually
    // populated rather than merely present, which is what L13's generator needs.
    for (const route of enumerateV1Routes(app)) {
      const metadata = routeMetadata.get(route.method, route.path);
      expect(metadata, `${route.method} ${route.path} has no metadata record`).toBeDefined();
      expect(metadata!.list, `${route.method} ${route.path}.list`).toBeDefined();
      expect(metadata!.scope, `${route.method} ${route.path}.scope`).toBeDefined();
      expect(metadata!.response, `${route.method} ${route.path}.response`).toBeDefined();
      if (metadata!.list === 'cursor') {
        expect(metadata!.resource, `${route.method} ${route.path}.resource`).toBe('documents');
      }
    }
  });

  it('the OpenAPI spec route IS mounted now — L13 landed it (PF-365)', () => {
    // This assertion used to read `.not.toContain`, recording the absence as a
    // fact while L13 was unwritten. Flipped rather than deleted: the path was
    // already named in `V1_UNAUTHENTICATED_PATHS` before anything served it, and
    // the interesting property is that the list and the router now agree.
    const paths = enumerateV1Routes(app).map((r) => r.path);
    expect(paths).toContain('/api/v1/openapi.json');
  });
});

describe('PF-264 · the internal surface and its query budget are unchanged', () => {
  const app = createApp();
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  let sessionCookie: string;
  let csrfToken: string;
  let workspaceId: string;
  let userId: string;

  beforeAll(async () => {
    const workspace = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `L09 budget ${runId}`,
    ]);
    workspaceId = workspace.rows[0].id;

    const user = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Budget User') RETURNING id`,
      [`l09-budget-${runId}@ship.local`],
    );
    userId = user.rows[0].id;

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [workspaceId, userId],
    );

    await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by)
       SELECT $1, 'wiki', 'Budget doc ' || g, $2 FROM generate_series(1, 25) g`,
      [workspaceId, userId],
    );

    const sessionId = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [sessionId, userId, workspaceId],
    );
    sessionCookie = `session_id=${sessionId}`;

    const csrf = await request(app).get('/api/csrf-token').set('Cookie', sessionCookie);
    csrfToken = csrf.body.token;
    const connectSid = csrf.headers['set-cookie']?.[0]?.split(';')[0] || '';
    if (connectSid) sessionCookie = `${sessionCookie}; ${connectSid}`;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM documents WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM workspace_memberships WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
  });

  /** Counts queries issued through the shared pool during one request. */
  async function countQueries(run: () => Promise<unknown>): Promise<number> {
    const real = pool.query.bind(pool);
    let count = 0;
    // Same instrumentation `api/src/scripts/measure-baseline.ts` uses to produce
    // the denominator, so the two numbers are measured the same way.
    (pool as unknown as { query: unknown }).query = (...args: unknown[]) => {
      count += 1;
      return (real as (...a: unknown[]) => unknown)(...args);
    };
    try {
      await run();
    } finally {
      (pool as unknown as { query: unknown }).query = real;
    }
    return count;
  }

  it('GET /api/documents issues no more queries than the Part 1 baseline', async () => {
    // The regression a naive service extraction introduces, named exactly: the
    // list's admin check is folded into the SELECT as an uncorrelated scalar
    // subquery, and moving the query behind a service is the moment someone
    // "tidies" that into a separate `isWorkspaceAdmin()` call — one extra pool
    // checkout and round trip on the app's hottest endpoint, per request.
    //
    // Warm first: the session lookup and CSRF machinery issue their own queries
    // on a cold request, and those are not what this measures.
    await request(app).get('/api/documents').set('Cookie', sessionCookie);

    const measured = await countQueries(async () => {
      const res = await request(app).get('/api/documents').set('Cookie', sessionCookie);
      expect(res.status).toBe(200);
    });

    const budget = BASELINE.routes['GET /api/documents']!.queriesPerRequest;
    expect(
      measured,
      `GET /api/documents now issues ${measured} queries against a Part 1 baseline of ` +
        `${budget}. MVP gate item 9 (p.2) caps regression at +10%, and query count is ` +
        `an integer — one extra query is a >10% regression on a 3-query route.`,
    ).toBeLessThanOrEqual(budget);
  });

  it('GET /api/documents/:id issues no more queries than the baseline', async () => {
    const one = await pool.query<{ id: string }>(
      `SELECT id FROM documents WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    );
    const id = one.rows[0]!.id;

    await request(app).get(`/api/documents/${id}`).set('Cookie', sessionCookie);

    const measured = await countQueries(async () => {
      await request(app).get(`/api/documents/${id}`).set('Cookie', sessionCookie);
    });

    expect(measured).toBeLessThanOrEqual(BASELINE.routes['GET /api/documents/:id']!.queriesPerRequest);
  });

  it('the internal list still returns a bare array, not a page envelope', async () => {
    // The two surfaces return different shapes and that is deliberate. The
    // internal list is a bare array the Ship frontend has consumed since Part 1;
    // the public one is `{data, next_cursor}`. Unifying them would be a breaking
    // change to the frontend for no external benefit.
    const res = await request(app).get('/api/documents').set('Cookie', sessionCookie);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).not.toHaveProperty('next_cursor');
  });

  it('the internal list still carries the internal-only columns the public one omits', async () => {
    // `position`, `ticket_number`, `properties`, `visibility` and `workspace_id`
    // are all in the internal list's SELECT and in none of the public bodies
    // (PF-252). This is the divergence asserted from the internal side.
    //
    // Deliberately NOT asserting the flattened `state`/`priority` keys: the
    // handler assigns `row.state = props.state`, and `JSON.stringify` drops a
    // key whose value is `undefined`, so those appear only on rows that actually
    // carry the property. That was true before this lane and is not something
    // the extraction changed.
    const res = await request(app).get('/api/documents').set('Cookie', sessionCookie);

    for (const column of ['position', 'ticket_number', 'properties', 'visibility', 'workspace_id']) {
      expect(res.body[0], `internal list is missing ${column}`).toHaveProperty(column);
    }
  });
});

describe('PF-263 · TS-6 substrate — a created id resolves through the public read path', () => {
  let harness: BearerTestApp;
  let workspaceId: string;
  let userId: string;

  beforeAll(async () => {
    const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const workspace = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `L09 ts6 ${runId}`,
    ]);
    workspaceId = workspace.rows[0].id;
    const user = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'TS6 User') RETURNING id`,
      [`l09-ts6-${runId}@ship.local`],
    );
    userId = user.rows[0].id;
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [workspaceId, userId],
    );

    harness = await createBearerTestApp({
      workspaceId,
      userId,
      mountResources: (router) =>
        mountDocuments(router, { db: pool, service: createDocumentService() }),
    });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM documents WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspace_memberships WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
  });

  it('the id returned by POST resolves to 200 through GET by id', async () => {
    // p.8's drill table requires "Document created; document.created event
    // published on the bus; subscribers receive POST". A subscriber that cannot
    // then FETCH the document has an event pointing at nothing, so the half this
    // lane can assert today is that the id in the create response is resolvable
    // through the same contract a subscriber has.
    const write = `Bearer ${(await harness.mint(['documents:write'])).access_token}`;
    const read = `Bearer ${(await harness.mint(['documents:read'])).access_token}`;

    const created = await request(harness.app)
      .post('/api/v1/documents')
      .set('Authorization', write)
      .send({ title: 'Round trip' });
    expect(created.status).toBe(201);

    const fetched = await request(harness.app)
      .get(`/api/v1/documents/${created.body.id}`)
      .set('Authorization', read);

    expect(fetched.status).toBe(200);
    expect(fetched.body.id).toBe(created.body.id);
    expect(fetched.body).toEqual(created.body);
  });

  it('the service already carries the bus, so PF-404 is an added call not a re-plumbing', async () => {
    // The other half of PF-263 — capturing the `document.created` envelope and
    // resolving ITS id — cannot be written yet, and this says so as an
    // assertion rather than leaving a silent gap.
    //
    // The event does not exist: `documentService.create` takes the bus (PF-262)
    // and does not publish, because publishing is L14's PF-404. This lane is
    // tier 3 and L14 is tier 4. That is the cross-tier back-edge the lane file
    // flags and the spine does not record — L14 blocks on L09, and PF-263 blocks
    // on L14. It is a genuine cycle in the dependency graph, not a re-pointable
    // mistake, and it is why PF-263 is the last ticket in the lane.
    //
    // What IS assertable now is that the seam is the right shape. Whoever lands
    // PF-404 adds `bus.publish(...)` inside `create()` after COMMIT and then
    // writes the envelope assertion here, with no signature and no route file
    // touched.
    const recorded: unknown[] = [];
    const bus = { publish: (e: unknown) => recorded.push(e), subscribe: () => {} };
    const service = createDocumentService({ bus: bus as never });

    expect(service.bus, 'the injected bus must reach the service').toBe(bus);

    const created = await service.create(
      { workspaceId, userId, db: pool },
      { title: 'Bus seam', documentType: 'wiki' },
    );
    expect(created.id).toBeTruthy();

    // Today: nothing published. When PF-404 lands this expectation flips to
    // `toHaveLength(1)` and the envelope's id is resolved through GET by id —
    // the same "the test tells you what to do when it starts failing" discipline
    // L08 used for the F15 constraint this lane just closed.
    expect(
      recorded,
      'documentService.create now publishes. L14 PF-404 has landed — replace this ' +
        'with the envelope assertion: capture document.created and assert ' +
        'GET /api/v1/documents/{envelope.data.id} returns 200 with the same id.',
    ).toHaveLength(0);
  });
});
