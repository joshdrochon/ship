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
import { RecordingEventBus } from '../../../webhooks/bus.js';
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

  it('enumerateV1Routes returns the documents routes, the spec, and L10’s /me', () => {
    // Build Strategy §4 (p.11): "Get the generator working end-to-end with one
    // resource (documents) before adding issues, sprints, and me."
    //
    // FLIPPED BY L10, not deleted. This assertion was written to be exact — the
    // three documents routes and nothing else — so that the day a second
    // resource landed, whoever landed it had to come here and say so. That is
    // the day. `GET /api/v1/me` is L10's PF-271; the "before" in Build Strategy
    // §4 is a sequencing instruction that has now been satisfied, not a
    // permanent ceiling, and PF-294 is the proof it was satisfied properly:
    // adding `me` changed zero lines under `platform/openapi/`.
    //
    // `/openapi.json` joined this list when L13 landed (PF-365). It is not a
    // resource — it is the contract describing the rest, mounted through the
    // `mountUnauthenticated` seam rather than `mountResources`.
    //
    // Still an exact equality rather than a `toContain`, and updated again by
    // L10's slice S2: `/issues` is here now. Keeping it exact is what forces the
    // next lane to come to this line and say what it added, which is the whole
    // reason it was written this way.
    // EXTENDED AGAIN BY L15, for the same reason and by the same rule: the six
    // `/webhooks` methods are PF-428, and landing them meant coming here and
    // saying so rather than loosening the assertion.
    //
    // Still an exact equality rather than a `toContain`. `issues` and `sprints`
    // are the rest of L10 and are NOT here yet, so this list keeps doing the job
    // it was written for.
    const routes = enumerateV1Routes(app)
      .map((r) => `${r.method} ${r.path}`)
      .sort();

    expect(routes).toEqual([
      'DELETE /api/v1/webhooks/:id',
      // ADDED BY F113 — PRD p.4's audit trail, on the public API so the portal
      // can read it the same way any other client would (p.10).
      'GET /api/v1/audit',
      'GET /api/v1/documents',
      'GET /api/v1/documents/:id',
      'GET /api/v1/issues',
      'GET /api/v1/issues/:id',
      'GET /api/v1/me',
      'GET /api/v1/openapi.json',
      'GET /api/v1/sprints',
      'GET /api/v1/sprints/:id',
      'GET /api/v1/webhooks',
      // NOTE: this list is `.sort()`ed, so `/webhooks/:id` precedes
      // `/webhooks/deliveries` — ':' sorts before 'd'. That is the LEXICAL order
      // and it is the opposite of the MOUNT order, which puts `/deliveries`
      // first so Express does not match it as an id. Do not "fix" one to match
      // the other; `deliveries.routes.test.ts` asserts the mount order directly.
      'GET /api/v1/webhooks/:id',
      // EXTENDED BY L16 (PF-464): the delivery log's two reads. They are what
      // makes p.4's "visible in the developer portal" checkable at the API layer
      // before L22 renders anything.
      'GET /api/v1/webhooks/deliveries',
      'GET /api/v1/webhooks/deliveries/:id',
      'PATCH /api/v1/issues/:id',
      'PATCH /api/v1/sprints/:id',
      'PATCH /api/v1/webhooks/:id',
      'POST /api/v1/documents',
      'POST /api/v1/issues',
      'POST /api/v1/sprints',
      'POST /api/v1/webhooks',
      'POST /api/v1/webhooks/:id/rotate',
      // ADDED BY L16 (PF-476): the exact path p.4 names for replay. It is the
      // operator's re-entry into the ladder and the thing the demo clicks.
      'POST /api/v1/webhooks/deliveries/:id/replay',
    ]);
  });

  it('/me IS mounted now — L10 landed it (PF-271), closing MVP gate item 8', () => {
    // This assertion used to read "no mounted route path matches /issues,
    // /sprints or /me". Flipped in the same spirit as the `/openapi.json` one
    // below it: the absence was recorded as a fact while the lane was unwritten,
    // and the interesting property now is that the route the SDK's `.me()` has
    // always called actually exists. `sdkGate.test.ts` §1 asserts the other
    // half — that the call resolves rather than 404s.
    const paths = enumerateV1Routes(app).map((r) => r.path);
    expect(paths).toContain('/api/v1/me');
  });

  it('/issues IS mounted now — L10 slice S2 landed it (PF-277–283)', () => {
    // Flipped in the same spirit as `/me` above it: the absence was recorded as
    // a fact while the slice was unwritten, and this is the day it shipped. The
    // interesting property now is that all three read/write routes are present,
    // not merely one of them — a resource that lists but cannot be fetched by id
    // is what a half-landed mount looks like.
    const paths = enumerateV1Routes(app).map((r) => r.path);
    expect(paths).toContain('/api/v1/issues');
    expect(paths).toContain('/api/v1/issues/:id');
  });

  it('/sprints IS mounted now — L10 slice S3 landed it (PF-284–289, PF-291)', () => {
    // The LAST half of the original latch, and with it the assertion PF-265 was
    // written to hold has done its whole job: every route that entered
    // `/api/v1` since L09 had to come to this file and be named.
    //
    // `/sprints` is the one that could not be a copy of the other two. There is
    // no internal "list sprints" route to extract — the internal one returns
    // only the CURRENT sprint — so this is new work, and its cursor is the one
    // that had to abandon the internal ordering entirely (PF-288).
    const paths = enumerateV1Routes(app).map((r) => r.path);
    expect(paths).toContain('/api/v1/sprints');
    expect(paths).toContain('/api/v1/sprints/:id');
  });

  it('the public surface is now the four resources p.3’s scope registry names', () => {
    // documents, issues, sprints — plus `me`, which declares `scope: null`
    // because none of the seven registered scopes names the authenticated
    // identity (PF-271). `webhooks` is L15's and is not this lane's to mount.
    const paths = new Set(enumerateV1Routes(app).map((r) => r.path));
    for (const resource of ['/api/v1/documents', '/api/v1/issues', '/api/v1/sprints']) {
      expect(paths.has(resource), `${resource} is not mounted`).toBe(true);
    }
    expect(paths.has('/api/v1/me')).toBe(true);
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
        // Was `toBe('documents')` while documents was the only list route.
        // Widened by L10 S2 to the property that actually matters: a cursor
        // route must name the collection its cursors are BOUND to, and that
        // binding is what makes a `/documents` cursor a 422 on `/issues`
        // (PF-218) instead of a plausible wrong page.
        //
        // WIDENED AGAIN BY L16, and the reason matters (finding F61). The rule
        // was `resource === path.split('/')[3]` — the third segment. That is
        // ambiguous the moment a collection is NESTED: `/api/v1/webhooks` and
        // `/api/v1/webhooks/deliveries` are two different collections sharing a
        // third segment, and making both name `webhooks` would mean a
        // subscriptions cursor is silently accepted on the deliveries list and
        // returns a wrong-but-plausible page — exactly the failure PF-218
        // exists to prevent, arriving through the assertion meant to stop it.
        //
        // The fix is a strict GENERALISATION, not a loosening: the resource is
        // every static segment of the collection path after `/api/v1/`, joined
        // by `_`. For every pre-existing route that is the same string it was
        // (`documents`, `issues`, `sprints`, `webhooks`); for a nested
        // collection it is unambiguous (`webhooks_deliveries`).
        expect(metadata!.resource, `${route.method} ${route.path}.resource`).toBe(
          route.path
            .replace(/^\/api\/v1\//, '')
            .split('/')
            .filter((segment) => !segment.startsWith(':'))
            .join('_'),
        );
        // A cursor route must name the collection its cursors are BOUND to
        // (PF-218) — not necessarily `documents`. This read `toBe('documents')`
        // while documents was the only paginated resource; L15's
        // `GET /api/v1/webhooks` is the second, and hardcoding the first
        // resource's name would have made this assertion a statement about how
        // many resources exist rather than about cursor binding.
        expect(metadata!.resource, `${route.method} ${route.path}.resource`).toBeTruthy();
        // The resource name is the collection path with `/` replaced by `_`
        // (see the widening above), so the round trip back to a path is what
        // this checks — not a raw string prefix, which stopped holding when the
        // first NESTED collection landed.
        expect(
          route.path.startsWith(`/api/v1/${(metadata!.resource ?? '').split('_').join('/')}`),
          `${route.method} ${route.path} binds cursors to "${metadata!.resource}"`,
        ).toBe(true);
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

  it('PF-263/PF-404 — create publishes document.created, and its id resolves through GET', async () => {
    // PF-263 was written by L09 as a latch: it asserted ZERO events and told
    // whoever landed L14's PF-404 to flip it. PF-404 has landed, so this is the
    // assertion it asked for — the envelope is captured and its `data.id` is
    // resolved through the public GET.
    //
    // That round trip is the property that matters. An event carrying an id the
    // API cannot resolve is the failure mode the after-COMMIT rule exists to
    // prevent, and asserting the id is merely "truthy" would not have caught a
    // publish that fired inside the transaction.
    const bus = new RecordingEventBus();
    const service = createDocumentService({ bus });

    expect(service.bus, 'the injected bus must reach the service').toBe(bus);

    const created = await service.create(
      { workspaceId, userId, db: pool },
      { title: 'Bus seam', documentType: 'wiki' },
    );
    expect(created.id).toBeTruthy();

    expect(bus.ofType('document.created')).toHaveLength(1);
    const envelope = bus.ofType('document.created')[0]!;
    const data = envelope.data as { id: string; title: string };
    expect(data.id).toBe(created.id);

    // The committed row is really there, under the id the event advertised.
    const read = `Bearer ${(await harness.mint(['documents:read'])).access_token}`;
    const fetched = await request(harness.app)
      .get(`/api/v1/documents/${data.id}`)
      .set('Authorization', read);
    expect(fetched.status).toBe(200);
    expect(fetched.body.id).toBe(data.id);
    expect(data.title).toBe('Bus seam');
  });
});
