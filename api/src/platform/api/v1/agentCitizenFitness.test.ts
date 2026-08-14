/**
 * ★ **THE EPIC 7 PROOF.** PF-709 — D11's fitness test, implemented.
 *
 * ---------------------------------------------------------------------------
 * WHY A FITNESS TEST AND NOT A GREP.
 * ---------------------------------------------------------------------------
 * PRD p.18 offers three ways to know, post-demo, that the agent *"actually went
 * through the public API for every action"*: *"a grep of the audit log, a
 * dashboard panel, or a fitness test that runs the agent and inspects the
 * trail?"* L99's D11 picks the fitness test, and the reason is the word
 * **every**: a grep shows that SOME calls went through. It cannot show that no
 * other channel exists, because the rows it is grepping are exactly the rows a
 * missing call would not have produced.
 *
 * p.13 makes Epic 7's Per-Epic Write-up proof *"the agent's audit-log rows
 * showing OAuth app"* authentication. This is where those rows come from.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT ACTUALLY DOES, END TO END.
 * ---------------------------------------------------------------------------
 *   1. boots a real server with the real public router, the real bearer
 *      middleware and the REAL `PgAuditSink` — not the in-memory one, because
 *      the rows are the deliverable
 *   2. registers the agent's app exactly as `seedPlatformApps` does: first
 *      party, confidential, the three read scopes
 *   3. mints a token over the wire with `grant_type=client_credentials`
 *   4. runs the agent's detectors through `createCitizenReader` over a real
 *      `ShipClient` pointed at that server
 *   5. reads the trail back with L12's `listCalls({ clientId })`
 *
 * Every assertion below is against rows that a real HTTP request wrote.
 *
 * ---------------------------------------------------------------------------
 * THE NON-ZERO GUARD IS THE MOST IMPORTANT ASSERTION IN THIS FILE.
 * ---------------------------------------------------------------------------
 * Every other assertion here is of the form "every row has property P", and
 * every one of them is trivially true of an empty set. A test that passed
 * because the agent did nothing would be the perfect false positive for this
 * epic — it would report the front-door claim as proven on a run that made no
 * calls at all. So the row count is asserted non-zero first, and the detectors
 * are seeded with data that provably trips them.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ShipClient } from '@ship/sdk';
import { createCitizenReader, detectStalledWork } from '@ship/agent';
import { createPublicRouter } from './router.js';
import { V1_PREFIX } from './testSupport.js';
import { meResources } from './me/routes.js';
import { issuesResources } from './issues/routes.js';
import { InMemoryTokenBucket } from '../../ratelimit/limiter.js';
import { PgAuditSink, listCalls } from '../../audit/pgAuditSink.js';
import { FakeClock } from '../../clock.js';
import { pool } from '../../../db/client.js';
import { PgOAuthAppRepo } from '../../apps/pg-repo.js';
import { secretMaterial } from '../../apps/repo.js';
import { generateClientSecret } from '../../apps/secrets.js';
import type { OAuthApp } from '../../apps/types.js';
import { InMemoryTokenRepo } from '../../oauth/tokenRepo.js';
import { bearerTokenMiddleware } from '../../oauth/bearer.js';
import { createOAuthRouter } from '../../oauth/router.js';
import { DEFAULT_TOKEN_TTL } from '../../oauth/tokens.js';
import { AGENT_CLIENT_ID } from '../../../db/platformApps.js';

const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** D5b, exactly. */
const AGENT_SCOPES = ['documents:read', 'issues:read', 'sprints:read'] as const;

/**
 * The `client_id` the demo query is parameterised by (PF-691).
 *
 * Suffixed per run so parallel suites do not read one another's audit rows,
 * and PREFIXED with the real constant so a failure names the app a reader
 * recognises. The constant itself is asserted separately in
 * `agentAppCitizen.test.ts` — this file needs isolation more than it needs the
 * literal string.
 */
const AGENT_CLIENT_ID_FOR_RUN = `${AGENT_CLIENT_ID}_${runId}`;

let server: Server;
let baseUrl: string;
let appsRepo: PgOAuthAppRepo;
let clock: FakeClock;
let agentApp: OAuthApp;
let agentSecret: string;
let otherApp: OAuthApp;
let otherSecret: string;
let workspaceId: string;
let userId: string;

const generous = (): InMemoryTokenBucket =>
  new InMemoryTokenBucket({ capacity: 1e6, refillPerSecond: 1e6, maxKeys: 10_000 }, new FakeClock(0));

/** Mints a token the way the agent does: over the wire, no shortcuts. */
async function mintClientCredentialsToken(
  clientId: string,
  clientSecret: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: AGENT_SCOPES.join(' '),
    }).toString(),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  clock = new FakeClock(1_700_000_000_000);
  appsRepo = new PgOAuthAppRepo(pool);

  workspaceId = (
    await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `l23 citizen ${runId}`,
    ])
  ).rows[0]!.id;

  userId = (
    await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'L23 Agent Owner') RETURNING id`,
      [`l23-citizen-${runId}@ship.local`],
    )
  ).rows[0]!.id;

  // The agent's app, registered exactly as `seedPlatformApps` registers it.
  agentSecret = generateClientSecret();
  agentApp = await appsRepo.create({
    clientId: AGENT_CLIENT_ID_FOR_RUN,
    ...secretMaterial(agentSecret),
    name: 'FleetGraph Agent',
    ownerUserId: userId,
    workspaceId,
    redirectUris: ['http://127.0.0.1:8976/callback'],
    requestedScopes: [...AGENT_SCOPES],
    isFirstParty: true,
    // Confidential. F100 pins this on the seed; the grant refuses a public app.
    isPublic: false,
  });

  /**
   * A SECOND first-party app, for PF-691's third assertion.
   *
   * B11 records that portal traffic is indistinguishable from a developer's own
   * because both run under the developer's app. The agent does not have that
   * problem — it has its own — and this app exists so "no other caller produces
   * rows under the agent's client_id" is checked against a caller that really
   * exists rather than against an empty universe.
   */
  otherSecret = generateClientSecret();
  otherApp = await appsRepo.create({
    clientId: `ship_app_other_${runId}`,
    ...secretMaterial(otherSecret),
    name: 'Another first-party caller',
    ownerUserId: userId,
    workspaceId,
    redirectUris: ['http://127.0.0.1:8976/callback'],
    requestedScopes: [...AGENT_SCOPES],
    isFirstParty: true,
    isPublic: false,
  });

  // Data that provably trips `stalledWork`: in_progress, untouched for 21 days.
  for (const [title, days] of [
    // L99 F52 / L03 PF-077: nothing under `platform/` may contain Ship's internal
    // noun for a sprint — including in a fixture title, including in a comment.
    // The first draft of this said "three w**ks" and `resource-map.test.ts`
    // caught it, which is that grep working as designed.
    ['Idle 21 days', 21],
    ['Idle nine days', 9],
    ['Moved yesterday', 1],
  ] as const) {
    await pool.query(
      `INSERT INTO documents
         (workspace_id, document_type, title, properties, created_by, created_at, updated_at)
       VALUES ($1, 'issue', $2,
               jsonb_build_object('state', 'in_progress', 'assignee_id', $3::text, 'priority', 'high'),
               $4::uuid, $5, $5)`,
      [workspaceId, title, userId, userId, new Date(Date.now() - days * 86_400_000)],
    );
  }

  const tokenRepo = new InMemoryTokenRepo();
  const app = express();
  app.use(
    '/oauth',
    createOAuthRouter({ appsRepo, tokenRepo, clock, ttl: DEFAULT_TOKEN_TTL }),
  );
  app.use(
    V1_PREFIX,
    createPublicRouter({
      bearerAuth: bearerTokenMiddleware({ tokenRepo, appsRepo, clock }),
      perAppLimiter: generous(),
      perTokenLimiter: generous(),
      // THE REAL SINK. The rows are the deliverable; an in-memory sink would
      // prove the middleware runs and prove nothing about the trail.
      auditSink: new PgAuditSink(pool),
      mountResources: (router) => {
        meResources({ db: pool, appsRepo })(router);
        issuesResources({ db: pool })(router);
      },
    }),
  );

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (process.env.L23_KEEP_AUDIT_ROWS !== '1') {
    await pool.query(`DELETE FROM public_api_calls WHERE client_id LIKE $1`, [`%${runId}`]);
  } else {
    // PF-710/PF-713 — the write-up needs REAL rows, so a run can be told to
    // leave them. Off by default: a suite that accumulates audit rows would
    // make every later assertion about counts progressively less trustworthy.
    console.log(`[L23] audit rows kept under client_id ${AGENT_CLIENT_ID_FOR_RUN}`);
  }
  await pool.query(`DELETE FROM documents WHERE workspace_id = $1`, [workspaceId]);
  await pool.query(`DELETE FROM oauth_apps WHERE workspace_id = $1`, [workspaceId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
});

/** Every audit row this run's agent produced. */
async function agentRows() {
  const page = await listCalls(pool, { clientId: AGENT_CLIENT_ID_FOR_RUN, limit: 100 });
  return page.data;
}

describe('PF-686 · the grant, over a real socket', () => {
  it('mints an access token with no refresh_token', async () => {
    const { status, body } = await mintClientCredentialsToken(agentApp.clientId, agentSecret);
    expect(status).toBe(200);
    expect(body.token_type).toBe('Bearer');
    expect('refresh_token' in body).toBe(false);
    expect(body.scope).toBe('documents:read issues:read sprints:read');
  });

  /**
   * PF-688 — the userless token, all the way to `/api/v1/me`.
   *
   * `/me` is built around an acting user, and until this grant existed nothing
   * on this server could produce a null one. So this is the first time that
   * branch has been exercised by a real token rather than by a fixture.
   */
  it('the token resolves on /api/v1/me with a NULL user and a named app', async () => {
    const { body } = await mintClientCredentialsToken(agentApp.clientId, agentSecret);
    const client = new ShipClient({ baseUrl, token: body.access_token as string });

    const me = (await client.me()) as unknown as Record<string, unknown>;
    // A defined body naming the app, not a 500 — PF-688's literal acceptance.
    expect(me).toBeTruthy();
    expect(me.user).toBeNull();
    expect((me.app as Record<string, unknown>).client_id).toBe(AGENT_CLIENT_ID_FOR_RUN);
  });
});

describe('★ PF-709 · the agent runs, and the trail proves it went through the front door', () => {
  it('a full flag-on detector run produces audit rows, and the count is NOT ZERO', async () => {
    const { body } = await mintClientCredentialsToken(agentApp.clientId, agentSecret);
    const client = new ShipClient({ baseUrl, token: body.access_token as string });
    const reader = createCitizenReader({ client, ownState: pool });

    const signals = await detectStalledWork(workspaceId, reader, new Date());

    // Non-vacuous on BOTH sides. The detector found something, so the run was
    // not a no-op; and the run produced rows, so the trail is not empty.
    expect(signals.length, 'the fixture must actually trip the detector').toBeGreaterThan(0);

    const rows = await agentRows();
    expect(
      rows.length,
      'ZERO audit rows means the agent made no public API calls — this test would ' +
        'otherwise pass vacuously, since every assertion below is true of an empty set',
    ).toBeGreaterThan(0);
  });

  it('EVERY row carries the agent`s client_id', async () => {
    const rows = await agentRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.client_id))).toEqual(new Set([AGENT_CLIENT_ID_FOR_RUN]));
  });

  /**
   * PF-688's audit half. `user_id` null on every row means *"machine-to-machine
   * grant, no user"* — a third documented meaning for that nullable field, on
   * top of L12's PF-326 two. It is what tells a reader of the trail that nobody
   * approved these calls interactively, which is the truth.
   */
  it('EVERY row carries a NULL user_id', async () => {
    const rows = await agentRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.user_id === null)).toBe(true);
  });

  /**
   * ⚑ **Measured, and the ticket's wording needed one carve-out.**
   *
   * PF-709 asks that every row carry *"one of the three granted scopes"*. Run
   * against the real router, `GET /api/v1/me` writes `scope_used: null` — and
   * that is L10's PF-271 being correct, not a hole: `/me` declares `scope: null`
   * deliberately, because none of p.3's seven names the authenticated identity
   * and inventing an eighth would break L03's exactly-seven assertion that MVP
   * gate item 6 resolves through. A token can always discover who it is.
   *
   * So the assertion is: every row is EITHER one of the three granted scopes OR
   * a null on a route that declares no scope. Written as a carve-out with the
   * route named rather than as `toBeDefined()`, so a resource route that
   * silently stopped declaring a scope would still fail here.
   */
  it('EVERY row carries a granted scope, or null on the one route that declares none', async () => {
    const rows = await agentRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      if (row.scope_used === null) {
        expect(
          row.route,
          `${row.method} ${row.route} recorded a null scope; only /me may (PF-271)`,
        ).toContain('/me');
        continue;
      }
      expect(
        AGENT_SCOPES as readonly string[],
        `row for ${row.method} ${row.route} used scope ${String(row.scope_used)}`,
      ).toContain(row.scope_used);
    }
  });

  /** And at least one row really did carry a granted scope — non-vacuity again. */
  it('at least one row used a scope from the three, so the check above is not empty', async () => {
    const rows = await agentRows();
    const scoped = rows.filter((r) => (AGENT_SCOPES as readonly string[]).includes(String(r.scope_used)));
    expect(scoped.length).toBeGreaterThan(0);
  });

  /**
   * Every READ is a 2xx — scoped to reads on purpose, not by test ordering.
   *
   * The first version of this asserted every row was 2xx and passed only
   * because it happened to run before PF-703's deliberate 403. That is a test
   * that would go red the day someone reordered a describe block, for no reason
   * a reader could guess. Scoped to GET, it says the thing it means: the agent
   * exercising its three read scopes was never refused, and the one refusal in
   * the trail is the write attempt PF-703 makes on purpose.
   */
  it('every READ the agent made was a 2xx — it was never refused for a read', async () => {
    const rows = (await agentRows()).filter((r) => r.method === 'GET');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.status, `${row.method} ${row.route} answered ${row.status}`).toBeGreaterThanOrEqual(200);
      expect(row.status).toBeLessThan(300);
    }
  });

  it('EVERY row carries the p.4 field set the demo query reads', async () => {
    const rows = await agentRows();
    for (const row of rows) {
      expect(row.occurred_at).toBeTruthy();
      expect(row.route).toBeTruthy();
      expect(row.method).toBeTruthy();
      expect(typeof row.latency_ms).toBe('number');
      expect(row.request_id).toBeTruthy();
    }
  });

  /**
   * PF-697's table invariant, for the SAME run.
   *
   * The audit rows say what the agent DID reach over HTTP. This says what it did
   * NOT reach any other way — and the two together are what make "every" a
   * checkable word rather than an adjective.
   */
  it('PF-697 — the same run touched no Ship table over SQL', async () => {
    const { body } = await mintClientCredentialsToken(agentApp.clientId, agentSecret);
    const client = new ShipClient({ baseUrl, token: body.access_token as string });
    const reader = createCitizenReader({ client, ownState: pool });

    await detectStalledWork(workspaceId, reader, new Date());

    expect(reader.invariantViolations()).toEqual([]);
    expect(reader.tablesTouchedBySql()).toEqual([]);
    expect(reader.statements.every((s) => s.servedBy === 'sdk')).toBe(true);
  });

  /**
   * PF-691's third assertion, and the one that would catch the failure L99's
   * B11 describes for the portal: a developer running the agent locally against
   * the deployed app's secret produces rows indistinguishable from the deployed
   * agent's.
   *
   * If this ever fails, the fix is a separate dev-environment app — NOT a
   * weaker assertion.
   */
  it('PF-691 — no OTHER caller produces rows under the agent`s client_id', async () => {
    const { body } = await mintClientCredentialsToken(otherApp.clientId, otherSecret);
    const other = new ShipClient({ baseUrl, token: body.access_token as string });
    await other.me();
    for await (const _issue of other.issues.iterate()) break;

    const agent = await agentRows();
    expect(agent.length).toBeGreaterThan(0);
    expect(agent.every((r) => r.client_id === AGENT_CLIENT_ID_FOR_RUN)).toBe(true);

    // And the other app's traffic really did land — so this is a comparison
    // against a caller that exists, not against an empty universe.
    const others = await listCalls(pool, { clientId: otherApp.clientId, limit: 100 });
    expect(others.data.length).toBeGreaterThan(0);
    expect(others.data.every((r) => r.client_id !== AGENT_CLIENT_ID_FOR_RUN)).toBe(true);
  });
});

describe('PF-703 · the platform enforces read-only independently of the agent`s own refusal', () => {
  /**
   * Belt and braces, on purpose. `act.ts`'s refusal is a CODE boundary a
   * reviewer reads; this is a PLATFORM boundary the platform enforces. Q3's
   * original complaint was that `api_tokens` could not enforce it at all.
   */
  it('the agent token 403s on a write route, naming the missing scope', async () => {
    const { body } = await mintClientCredentialsToken(agentApp.clientId, agentSecret);
    const response = await fetch(`${baseUrl}${V1_PREFIX}/issues`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${body.access_token as string}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'the agent should not be able to do this' }),
    });

    expect(response.status).toBe(403);
    // The ApiError envelope is FLAT — `{code, message, details, request_id}`,
    // not `{error: {...}}`. Measured off the wire; the first version of this
    // test guessed a nested shape and got `undefined`, which is exactly the
    // class of contract bug a live assertion exists to catch.
    const failure = (await response.json()) as {
      code?: string;
      request_id?: string;
      details?: { missing_scope?: string; granted_scopes?: string[] };
    };

    /**
     * ⚑ The ticket says the 403 "names the missing scope"; PF-069's SHAPE puts
     * the name in `details.missing_scope`, not in `code`. The code is
     * `forbidden` — one of the six on p.7, a closed union L17's PF-498 asserts
     * key-equality against — and adding a seventh to satisfy this wording would
     * contradict a printed interface. Measured against the live router rather
     * than assumed from the ticket text.
     */
    expect(failure.code).toBe('forbidden');
    expect(failure.details?.missing_scope).toBe('issues:write');
    // And the reply says what the token DOES have, which is what turns a 403
    // into something a developer can act on.
    expect(failure.details?.granted_scopes).toEqual(
      expect.arrayContaining(['issues:read']),
    );
    // And it carries a `request_id`, which is what makes a 403 traceable back
    // to its own audit row (G2, p.18).
    expect(failure.request_id).toBeTruthy();
  });
});
