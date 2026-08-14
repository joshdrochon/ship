/**
 * ★ TESTING SCENARIO 3 (PRD p.5), SERVER HALF. PF-138.
 * Lane L05, slice S4.
 *
 * p.5, verbatim: *"Run the Device Authorization Grant flow from a test CLI:
 * poll /oauth/token until authorized, verify slow-down responses are honored,
 * confirm the resulting token works against /api/v1/me."*
 *
 * ---------------------------------------------------------------------------
 * THIS IS A DECLARED SPLIT WITH L19's PF-564, NOT A SECOND CLAIM.
 * ---------------------------------------------------------------------------
 * PF-564 claimed TS-3 board-wide because the scenario's subject is literally "a
 * test CLI", and its own note asks for exactly this split — *"server honors
 * `slow_down` / client obeys it"*. So:
 *
 *   THIS FILE   asserts the SERVER over HTTP with no CLI in the picture: that
 *               it emits `slow_down` correctly, refuses to be polled faster,
 *               and that the token it finally issues is accepted by
 *               `GET /api/v1/me`.
 *   PF-564      drives the same three legs through the real `ship` binary with
 *               the real SDK.
 *
 * Neither is redundant: this one fails if the server is wrong, that one fails
 * if the client is. Same shape as L24's PF-730 and L16 both citing TS-8 for the
 * wire and portal halves of one scenario.
 *
 * ---------------------------------------------------------------------------
 * ONE APP, BOTH SURFACES, ONE SET OF REPOSITORIES.
 * ---------------------------------------------------------------------------
 * `/oauth/*` and `/api/v1/*` are mounted on the same Express app sharing the
 * same repositories, which is the only way clause (c) can be tested honestly —
 * a unit test proves the decision, and only a request proves the WIRING.
 * Copied deliberately from L04's `endToEnd.test.ts` rather than invented.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { createPublicRouter } from '../api/v1/router.js';
import { V1_PREFIX } from '../api/v1/testSupport.js';
import { meResources } from '../api/v1/me/routes.js';
import { InMemoryAuditSink } from '../audit/audit.js';
import { InMemoryTokenBucket } from '../ratelimit/limiter.js';
import { FakeClock } from '../clock.js';
import { pool } from '../../db/client.js';
import { PgOAuthAppRepo } from '../apps/pg-repo.js';
import { secretMaterial } from '../apps/repo.js';
import { generateClientId, generateClientSecret } from '../apps/secrets.js';
import type { OAuthApp } from '../apps/types.js';
import { InMemoryTokenRepo } from './tokenRepo.js';
import { bearerTokenMiddleware } from './bearer.js';
import { createOAuthRouter } from './router.js';
import { DEFAULT_TOKEN_TTL } from './tokens.js';
import { InMemoryDeviceCodeRepo, normalizeUserCode } from './deviceCodes.js';
import { DEVICE_CODE_GRANT_TYPE } from './deviceGrant.js';
import { deviceAuthorizationResponseSchema } from './deviceAuthorization.js';
import { oauthErrorBodySchema, oauthTokenResponseSchema } from './oauthErrors.js';

const BASE_URL = 'https://ship.test';

let appsRepo: PgOAuthAppRepo;
let deviceCodeRepo: InMemoryDeviceCodeRepo;
let tokenRepo: InMemoryTokenRepo;
let clock: FakeClock;
let app: OAuthApp;
let secret: string;
let server: Express;
let userId: string;
let workspaceId: string;

const generous = () =>
  new InMemoryTokenBucket({ capacity: 1e6, refillPerSecond: 1e6, maxKeys: 10_000 }, new FakeClock(0));

beforeEach(async () => {
  clock = new FakeClock(1_700_000_000_000);
  deviceCodeRepo = new InMemoryDeviceCodeRepo();
  tokenRepo = new InMemoryTokenRepo();
  appsRepo = new PgOAuthAppRepo(pool);

  // `/api/v1/me` reads the real `users` table, so this leg needs real rows.
  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ('L05 TS-3 workspace') RETURNING id`,
  );
  workspaceId = ws.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, 'TS-3 User') RETURNING id`,
    [`ts3-${Date.now()}-${Math.random()}@ship.local`],
  );
  userId = user.rows[0]!.id;

  secret = generateClientSecret();
  app = await appsRepo.create({
    clientId: generateClientId(),
    ...secretMaterial(secret),
    name: 'TS-3 device client',
    ownerUserId: userId,
    workspaceId,
    redirectUris: ['https://example.test/cb'],
    requestedScopes: ['documents:read', 'issues:read'],
  });

  server = express();
  server.use(
    '/oauth',
    createOAuthRouter({
      appsRepo,
      tokenRepo,
      deviceCodeRepo,
      publicBaseUrl: BASE_URL,
      clock,
      ttl: DEFAULT_TOKEN_TTL,
    }),
  );
  server.use(
    V1_PREFIX,
    createPublicRouter({
      bearerAuth: bearerTokenMiddleware({ tokenRepo, appsRepo, clock }),
      perAppLimiter: generous(),
      perTokenLimiter: generous(),
      auditSink: new InMemoryAuditSink(),
      mountResources: meResources({ db: pool, appsRepo }),
    }),
  );
});

/** Leg 1: the device authorization request, exactly as a CLI would make it. */
function requestDeviceCode() {
  return request(server)
    .post('/oauth/device/code')
    .type('form')
    .send({ client_id: app.clientId, client_secret: secret, scope: 'documents:read' });
}

/** Leg 2: one poll, exactly as a CLI would make it. */
function poll(deviceCode: string) {
  return request(server).post('/oauth/token').type('form').send({
    grant_type: DEVICE_CODE_GRANT_TYPE,
    device_code: deviceCode,
    client_id: app.clientId,
    client_secret: secret,
  });
}

/** The out-of-band browser approval. TS-3 does not test the screen; S2 does. */
async function approveOutOfBand(userCode: string) {
  const row = await deviceCodeRepo.findByUserCode(normalizeUserCode(userCode));
  expect(row, 'the user_code printed to the terminal must resolve').not.toBeNull();
  const ok = await deviceCodeRepo.approve(
    { id: row!.id, userId, workspaceId, scopes: ['documents:read'] },
    new Date(clock.nowMs()),
  );
  expect(ok).toBe(true);
}

describe('★ TS-3 (p.5): the Device Authorization Grant, driven as a test CLI would', () => {
  it('runs the whole scenario end to end: poll until authorized, slow_down honored, token works on /api/v1/me', async () => {
    // ── The CLI starts the flow ───────────────────────────────────────────
    const started = await requestDeviceCode();
    expect(started.status).toBe(200);
    expect(deviceAuthorizationResponseSchema.safeParse(started.body).success).toBe(true);

    const { device_code: deviceCode, user_code: userCode, interval } = started.body;
    // "User code displayed" (p.8's drill stage) — this is the value a CLI prints.
    expect(userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(interval).toBe(5);

    // ── (a) polling faster than `interval` yields slow_down AND a raised one ─
    const first = await poll(deviceCode);
    expect(first.status).toBe(400);
    expect(first.body.error).toBe('authorization_pending');

    clock.advance(1000); // 1s — well inside the 5s interval
    const tooFast = await poll(deviceCode);
    expect(tooFast.status).toBe(400);
    expect(tooFast.body.error).toBe('slow_down');
    expect(oauthErrorBodySchema.safeParse(tooFast.body).success).toBe(true);

    // The interval was RAISED, not merely complained about. A server that
    // returns slow_down without raising it leaves a fast client looping.
    const raised = await deviceCodeRepo.findByUserCode(normalizeUserCode(userCode));
    expect(raised?.intervalSeconds).toBe(interval + 5);

    // Polling at the RAISED interval is legal again.
    clock.advance(raised!.intervalSeconds * 1000);
    const backInLine = await poll(deviceCode);
    expect(backInLine.status).toBe(400);
    expect(backInLine.body.error).toBe('authorization_pending');

    // ── (b) an out-of-band approval flips the grant ─────────────────────────
    await approveOutOfBand(userCode);

    clock.advance(raised!.intervalSeconds * 1000);
    const redeemed = await poll(deviceCode);
    expect(redeemed.status).toBe(200);
    expect(oauthTokenResponseSchema.safeParse(redeemed.body).success).toBe(true);
    expect(redeemed.body.token_type).toBe('Bearer');
    expect(redeemed.body.scope).toBe('documents:read');

    // ── (c) the resulting token works against GET /api/v1/me ───────────────
    const me = await request(server)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${redeemed.body.access_token}`);

    expect(me.status).toBe(200);
    // Populated `app.client_id`, which is what makes this a token belonging to
    // the app that ran the device flow rather than any token at all.
    expect(me.body.app.client_id).toBe(app.clientId);
    expect(me.body.user?.id).toBe(userId);
    expect(me.body.scopes).toEqual(['documents:read']);
  });

  it('a polite client that never violates the interval is never slowed down', async () => {
    // The counterpart to clause (a): TS-3 asks that slow_down be honored, and a
    // server that emitted it against a compliant client would be "honoring" it
    // by punishing correct behaviour.
    const started = await requestDeviceCode();
    const { device_code: deviceCode, user_code: userCode, interval } = started.body;

    for (let i = 0; i < 8; i += 1) {
      const res = await poll(deviceCode);
      expect(res.body.error, `poll ${i + 1} at the advertised interval`).toBe(
        'authorization_pending',
      );
      clock.advance(interval * 1000);
    }

    await approveOutOfBand(userCode);
    const redeemed = await poll(deviceCode);
    expect(redeemed.status).toBe(200);
  });

  it('the whole flow completes inside the code’s own lifetime, even after backoff', async () => {
    // p.8's drill expects "polling succeeds within 60s in tests". The concern
    // this pins is the interval cap: without one, a client that misbehaved
    // early could drive the interval past the 600s TTL and never complete.
    const started = await requestDeviceCode();
    const { device_code: deviceCode, user_code: userCode } = started.body;

    // Hammer hard enough to reach the cap.
    await poll(deviceCode);
    for (let i = 0; i < 30; i += 1) {
      clock.advance(50);
      await poll(deviceCode);
    }

    const row = await deviceCodeRepo.findByUserCode(normalizeUserCode(userCode));
    expect(row!.intervalSeconds).toBeLessThanOrEqual(60);

    await approveOutOfBand(userCode);
    clock.advance(row!.intervalSeconds * 1000);
    const redeemed = await poll(deviceCode);
    expect(redeemed.status).toBe(200);

    // Still inside the 600s TTL — the flow is completable, which is the point.
    expect(clock.nowMs() - 1_700_000_000_000).toBeLessThan(600_000);
  });

  it('a denied authorization reaches the poller as access_denied, not as a timeout', async () => {
    const started = await requestDeviceCode();
    const { device_code: deviceCode, user_code: userCode } = started.body;

    const row = await deviceCodeRepo.findByUserCode(normalizeUserCode(userCode));
    await deviceCodeRepo.deny(row!.id, new Date(clock.nowMs()));

    clock.advance(6000);
    const res = await poll(deviceCode);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('access_denied');
  });

  it('the device-grant token is subject to the same bearer rules as any other', async () => {
    // The seam claim: because this lane mints through L06's single issuance
    // site, a device-grant token is indistinguishable downstream from an
    // authorization-code one. Deactivating the app kills it immediately.
    const started = await requestDeviceCode();
    const { device_code: deviceCode, user_code: userCode } = started.body;
    await approveOutOfBand(userCode);
    clock.advance(6000);
    const redeemed = await poll(deviceCode);

    const token = redeemed.body.access_token as string;
    expect(
      (await request(server).get('/api/v1/me').set('Authorization', `Bearer ${token}`)).status,
    ).toBe(200);

    await appsRepo.deactivate(app.id, 'admin_action', new Date(clock.nowMs()));

    const after = await request(server)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(401);
  });
});
