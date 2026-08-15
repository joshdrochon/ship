/**
 * F113 — tenancy for `GET /api/v1/audit`. The security of this route, isolated.
 *
 * PF-260's rule, applied to the audit trail: **the filter comes from the token
 * and from nowhere else.** Every resource on the public surface carries a
 * `*.tenancy.test.ts` making that checkable, and this is the audit trail's.
 *
 * ## Why this route needs its own file rather than a case in the routes test
 *
 * The stakes here are different from a documents read. `client_id` values are
 * PUBLISHED — they appear in READMEs, in `GET /api/apps`, in the portal, and the
 * PRD (p.2, gate item 10) requires one to be pre-registered for graders. So the
 * identifier that scopes this query is public knowledge by design.
 *
 * That makes a caller-supplied `?client_id=` not a small bug but a complete
 * disclosure: an app's audit trail is which routes it calls, when, how often,
 * with what scopes and with what failures. Handed to a stranger it is
 * reconnaissance — it maps another tenant's integration and shows exactly which
 * calls are already 403ing, which is a list of the permissions worth attacking.
 *
 * The corresponding tenancy dimension on this route is the APP, not the
 * workspace: `public_api_calls` is keyed by `client_id`, and two apps in one
 * workspace must not read each other's calls either.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { pool } from '../../../../db/client.js';
import { createTestPublicApp, fakeAuthContext, V1_PREFIX } from '../testSupport.js';
import { PgAuditSink } from '../../../audit/pgAuditSink.js';
import { auditResources } from './routes.js';
import { AUDIT_FILTER_PARAMS } from './audit.schema.js';

/** The caller. `fakeAuthContext()` puts this `client_id` on the context. */
const MINE = 'client_test';
/** A second app, whose rows must be unreachable from the caller's token. */
const THEIRS = 'client_victim';

const T0 = Date.UTC(2026, 7, 1, 12, 0, 0);

let sink: PgAuditSink;

async function seed(clientId: string, requestId: string, offsetSeconds = 0): Promise<void> {
  await sink.record({
    requestId,
    clientId,
    userId: 'user_test',
    method: 'GET',
    route: '/api/v1/documents',
    scopeUsed: 'documents:read',
    status: 200,
    latencyMs: 5,
    occurredAt: new Date(T0 + offsetSeconds * 1000),
  });
}

/** A request made with the CALLER's token, whatever the query says. */
function get(query = '') {
  const { app } = createTestPublicApp({
    auth: fakeAuthContext(),
    mountResources: auditResources({ db: pool }),
  });
  return request(app).get(`${V1_PREFIX}/audit${query}`);
}

const requestIds = (body: { data: { request_id: string }[] }): string[] =>
  body.data.map((r) => r.request_id);

beforeEach(async () => {
  sink = new PgAuditSink(pool);
  await pool.query('TRUNCATE TABLE public_api_calls CASCADE');
  await seed(MINE, 'req_mine_1', 0);
  await seed(MINE, 'req_mine_2', 10);
  await seed(THEIRS, 'req_theirs_1', 20);
  await seed(THEIRS, 'req_theirs_2', 30);
});

describe('F113 tenancy — the client_id is taken from the token, never the request', () => {
  it('returns ONLY the caller\'s own rows by default', async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect(requestIds(res.body).sort()).toEqual(['req_mine_1', 'req_mine_2']);
    // Stated separately from the equality above so a future change that widens
    // the set fails on the SPECIFIC thing that matters.
    expect(requestIds(res.body)).not.toContain('req_theirs_1');
  });

  it('REJECTS ?client_id= rather than honouring it', async () => {
    const res = await get(`?client_id=${THEIRS}`);

    // 422, not "ignored". A caller who sends it must learn the endpoint is
    // self-scoped; silently dropping the filter would let them believe they had
    // successfully read another app's trail and been told it was empty.
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
  });

  it('the filter allowlist does not contain client_id at all', () => {
    // The mechanism behind the assertion above, checked directly: adding
    // `client_id` to `AUDIT_FILTER_PARAMS` would make the 422 into a 200 and
    // this line is what would fail first.
    expect(AUDIT_FILTER_PARAMS as readonly string[]).not.toContain('client_id');
  });

  it('a snake_case, camelCase or spaced variant is rejected too', async () => {
    for (const variant of ['clientId', 'client-id', 'client_id ', 'CLIENT_ID']) {
      const res = await get(`?${encodeURIComponent(variant)}=${THEIRS}`);
      expect(res.status, `${variant} was accepted`).toBe(422);
    }
  });

  it('a client_id in the BODY of a GET changes nothing', async () => {
    const { app } = createTestPublicApp({
      auth: fakeAuthContext(),
      mountResources: auditResources({ db: pool }),
    });

    const res = await request(app)
      .get(`${V1_PREFIX}/audit`)
      .send({ client_id: THEIRS });

    expect(res.status).toBe(200);
    expect(requestIds(res.body).sort()).toEqual(['req_mine_1', 'req_mine_2']);
  });

  it('a client_id HEADER changes nothing', async () => {
    const res = await get().set('X-Client-Id', THEIRS).set('client_id', THEIRS);

    expect(res.status).toBe(200);
    expect(requestIds(res.body).sort()).toEqual(['req_mine_1', 'req_mine_2']);
  });

  it('two tokens see two disjoint trails', async () => {
    const theirApp = createTestPublicApp({
      auth: { ...fakeAuthContext(), clientId: THEIRS, appId: 'app_victim' },
      mountResources: auditResources({ db: pool }),
    });

    const mine = await get();
    const theirs = await request(theirApp.app).get(`${V1_PREFIX}/audit`);

    expect(requestIds(mine.body).sort()).toEqual(['req_mine_1', 'req_mine_2']);
    expect(requestIds(theirs.body).sort()).toEqual(['req_theirs_1', 'req_theirs_2']);

    // Disjoint, asserted as a set property rather than by reading the two lists.
    const overlap = requestIds(mine.body).filter((id) => requestIds(theirs.body).includes(id));
    expect(overlap).toEqual([]);
  });

  it('a filter that WOULD match another app\'s rows still returns none of them', async () => {
    // The route filter is applied on top of the tenancy filter, never instead of
    // it. `?route=` matches every seeded row, so a tenancy filter applied in the
    // wrong order would show all four.
    const res = await get(`?route=${encodeURIComponent('/api/v1/documents')}`);

    expect(requestIds(res.body).sort()).toEqual(['req_mine_1', 'req_mine_2']);
  });

  it('an app with no calls gets an empty page, not another app\'s rows', async () => {
    const stranger = createTestPublicApp({
      auth: { ...fakeAuthContext(), clientId: 'client_brand_new', appId: 'app_new' },
      mountResources: auditResources({ db: pool }),
    });

    const res = await request(stranger.app).get(`${V1_PREFIX}/audit`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.next_cursor).toBeNull();
  });
});
