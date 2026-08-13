/**
 * PF-537 · `ShipClient.deviceLogin()` against a GENUINELY RUNNING server.
 *
 * `sdk/src/auth/flows.test.ts` scripts the HTTP layer and proves the protocol —
 * interval, `slow_down`, terminal codes, exact `save()` counts. This proves the
 * other half: that the wire shapes the SDK sends and expects are the ones L05's
 * `/oauth` router actually speaks. A scripted flow can agree with a stub
 * forever; only a real socket catches a field name.
 *
 * This is `ship login` (p.6's five-line story), one layer below the CLI.
 *
 * ── No wall clock, on a live server ─────────────────────────────────────────
 * The SDK's `SdkClock.sleep` is injected with a function that awaits the
 * out-of-band approval instead of waiting. So the poll loop is DETERMINISTIC —
 * poll one happens after approval, always — and the file contains no
 * `setTimeout` and no timing assumption. A `sleep` that really slept would make
 * this a race between a 5-second interval and a database write.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ShipClient, ShipError, oauthErrorCode, type SdkClock } from '@ship/sdk';
import { createPublicRouter } from './router.js';
import { V1_PREFIX } from './testSupport.js';
import { meResources } from './me/routes.js';
import { InMemoryAuditSink } from '../../audit/audit.js';
import { InMemoryTokenBucket } from '../../ratelimit/limiter.js';
import { FakeClock } from '../../clock.js';
import { pool } from '../../../db/client.js';
import { PgOAuthAppRepo } from '../../apps/pg-repo.js';
import { secretMaterial } from '../../apps/repo.js';
import { generateClientId, generateClientSecret } from '../../apps/secrets.js';
import type { OAuthApp } from '../../apps/types.js';
import { InMemoryTokenRepo } from '../../oauth/tokenRepo.js';
import { bearerTokenMiddleware } from '../../oauth/bearer.js';
import { createOAuthRouter } from '../../oauth/router.js';
import { DEFAULT_TOKEN_TTL } from '../../oauth/tokens.js';
import { InMemoryDeviceCodeRepo, normalizeUserCode } from '../../oauth/deviceCodes.js';

let server: Server;
let baseUrl: string;
let appsRepo: PgOAuthAppRepo;
let deviceCodeRepo: InMemoryDeviceCodeRepo;
let clock: FakeClock;
let oauthApp: OAuthApp;
let clientSecret: string;
let userId: string;
let workspaceId: string;

const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const generous = (): InMemoryTokenBucket =>
  new InMemoryTokenBucket({ capacity: 1e6, refillPerSecond: 1e6, maxKeys: 10_000 }, new FakeClock(0));

/**
 * The out-of-band browser approval. The verification SCREEN is L05's S2; what
 * matters here is that the device code becomes approved while the SDK polls.
 */
async function approveOutOfBand(userCode: string): Promise<void> {
  const row = await deviceCodeRepo.findByUserCode(normalizeUserCode(userCode));
  expect(row, 'the user_code the SDK surfaced must resolve to a device code').not.toBeNull();
  const ok = await deviceCodeRepo.approve(
    { id: row!.id, userId, workspaceId, scopes: ['documents:read'] },
    new Date(clock.nowMs()),
  );
  expect(ok).toBe(true);
}

beforeAll(async () => {
  clock = new FakeClock(1_700_000_000_000);
  deviceCodeRepo = new InMemoryDeviceCodeRepo();
  appsRepo = new PgOAuthAppRepo(pool);

  const workspace = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
    [`l18 oauth ${runId}`],
  );
  workspaceId = workspace.rows[0]!.id;

  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, 'test-hash', 'L18 Device User') RETURNING id`,
    [`l18-oauth-${runId}@ship.local`],
  );
  userId = user.rows[0]!.id;

  clientSecret = generateClientSecret();
  oauthApp = await appsRepo.create({
    clientId: generateClientId(),
    ...secretMaterial(clientSecret),
    name: `L18 device client ${runId}`,
    ownerUserId: userId,
    workspaceId,
    redirectUris: ['https://example.test/cb'],
    requestedScopes: ['documents:read', 'issues:read'],
  });

  const tokenRepo = new InMemoryTokenRepo();
  const app = express();
  app.use(
    '/oauth',
    createOAuthRouter({
      appsRepo,
      tokenRepo,
      deviceCodeRepo,
      publicBaseUrl: 'https://ship.test',
      clock,
      ttl: DEFAULT_TOKEN_TTL,
    }),
  );
  app.use(
    V1_PREFIX,
    createPublicRouter({
      bearerAuth: bearerTokenMiddleware({ tokenRepo, appsRepo, clock }),
      perAppLimiter: generous(),
      perTokenLimiter: generous(),
      auditSink: new InMemoryAuditSink(),
      mountResources: meResources({ db: pool, appsRepo }),
    }),
  );

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.query(`DELETE FROM oauth_apps WHERE workspace_id = $1`, [workspaceId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
});

/**
 * A clock whose `sleep` awaits `pending` rather than the wall clock.
 *
 * This is what makes a live poll loop deterministic without a timer: the SDK's
 * first poll cannot happen before the approval has landed, and the test does not
 * have to guess how long that takes.
 */
function approvalDrivenClock(pending: () => Promise<void>): SdkClock {
  return {
    now: () => Date.now(),
    random: () => 1,
    sleep: async () => {
      await pending();
    },
  };
}

describe('PF-537 · a scripted device flow resolves to a client whose .me() succeeds', () => {
  it('runs the whole flow through the SDK, over a real socket', async () => {
    const surfaced: { code: string; verifyUrl: string }[] = [];
    let approval: Promise<void> = Promise.resolve();

    const client = await ShipClient.deviceLogin({
      baseUrl,
      clientId: oauthApp.clientId,
      // ⚑ A CLI is a PUBLIC client (RFC 6749 §2.1) and has no secret. It is
      // supplied here because L06's `authenticateClient` requires one on the
      // redemption leg — see the F50 re-measurement below, which is why
      // `ship login` cannot yet run as the public client it is.
      clientSecret,
      scopes: ['documents:read'],
      clock: approvalDrivenClock(() => approval),
      onUserCode: (code, verifyUrl) => {
        surfaced.push({ code, verifyUrl });
        // Out-of-band, exactly as a human at a browser would.
        approval = approveOutOfBand(code);
      },
    });

    // p.7's callback contract, live: both values, and the URL is absolute.
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]?.code).toMatch(/^[A-Z0-9-]+$/);
    expect(surfaced[0]?.verifyUrl.startsWith('https://')).toBe(true);
    expect(surfaced[0]?.verifyUrl).toContain('/oauth/device/verify');

    // The acceptance criterion, executed: the resulting client's `.me()` works.
    const me = await client.me();
    expect(me.app.client_id).toBe(oauthApp.clientId);
    expect(me.user?.id).toBe(userId);
    expect(me.scopes).toEqual(['documents:read']);
  });

  it('a device code that is never approved ends with a typed error, not a hang', async () => {
    const error = (await ShipClient.deviceLogin({
      baseUrl,
      clientId: oauthApp.clientId,
      clientSecret,
      scopes: ['documents:read'],
      // Never approves. The device code's own `expires_in` is what stops the
      // loop, and `sleep` advances the clock past it in one step.
      clock: {
        now: (() => {
          let value = Date.now();
          return () => {
            value += 60 * 60 * 1000;
            return value;
          };
        })(),
        random: () => 1,
        sleep: () => Promise.resolve(),
      },
      onUserCode: () => {},
    }).catch((e: unknown) => e)) as ShipError;

    expect(error).toBeInstanceOf(ShipError);
    expect(error.kind).toBe('auth');
    expect(oauthErrorCode(error)).toBe('expired_token');
  });
});

describe('L99 F70 · public clients, from the SDK side', () => {
  /**
   * ⚑ THIS SECTION USED TO ASSERT THE OPPOSITE, AND THAT IS THE POINT.
   *
   * L18 branched from `31ee898`, where F27/F50 were open: `authenticateClient`
   * required BOTH `client_id` and `client_secret` before every grant handler, so
   * a public client — which is what a CLI is (RFC 6749 §2.1), and why L04 built
   * PKCE for it — could START the device flow and never finish it. This file
   * measured that against a real router and asserted the 401.
   *
   * L24's PF-734 fixed it while this lane was building: migration 074 added
   * `oauth_apps.is_public`, and the guard now accepts `client_id` alone for an
   * app registered public. Re-measured after merging the tip; the assertions
   * below are the CORRECTED ones.
   *
   * Recorded rather than quietly rewritten because the near-miss is worth more
   * than the fix: a lane that branches on Monday and reports on Wednesday can
   * publish a finding about work someone else has already done, and the only
   * defence is re-measuring against the tip before writing the report. See
   * L99 ~~F92~~.
   */

  /** A separate app, registered PUBLIC — the shape a CLI actually needs. */
  async function publicApp(): Promise<OAuthApp> {
    return appsRepo.create({
      clientId: generateClientId(),
      ...secretMaterial(generateClientSecret()),
      name: `L18 public CLI ${runId}`,
      ownerUserId: userId,
      workspaceId,
      redirectUris: ['https://example.test/cb'],
      requestedScopes: ['documents:read', 'issues:read'],
      isPublic: true,
    });
  }

  it('a public client can START the device flow with `client_id` alone', async () => {
    // RFC 8628 §3.1 requires identification only, and L05's endpoint always
    // followed it — this half was never the problem.
    const response = await fetch(`${baseUrl}/oauth/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: (await publicApp()).clientId, scope: 'documents:read' }),
    });
    expect(response.status).toBe(200);
  });

  it('…and can now REDEEM it with `client_id` alone — F27/F50 closed by L24 PF-734', async () => {
    const app = await publicApp();

    const started = (await (
      await fetch(`${baseUrl}/oauth/device/code`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: app.clientId, scope: 'documents:read' }),
      })
    ).json()) as { device_code: string; user_code: string };

    await approveOutOfBand(started.user_code);

    const redeemed = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: started.device_code,
        client_id: app.clientId,
        // No client_secret. This is the public-client case, and it works.
      }),
    });

    expect(redeemed.status).toBe(200);
    expect(((await redeemed.json()) as { access_token: string }).access_token).toMatch(/\S/);
  });

  it('`ship login` is UNBLOCKED — deviceLogin with no clientSecret anywhere', async () => {
    // The whole point, through the published SDK: L19's CLI registers its app
    // public and passes no secret, which is what RFC 6749 §2.1 says a CLI is.
    const app = await publicApp();
    let approval: Promise<void> = Promise.resolve();

    const client = await ShipClient.deviceLogin({
      baseUrl,
      clientId: app.clientId,
      // No `clientSecret`. That is the assertion.
      scopes: ['documents:read'],
      clock: approvalDrivenClock(() => approval),
      onUserCode: (code) => {
        approval = approveOutOfBand(code);
      },
    });

    const me = await client.me();
    expect(me.app.client_id).toBe(app.clientId);
    expect(me.user?.id).toBe(userId);
  });

  it('a CONFIDENTIAL app is still refused without its secret — the fix did not widen', async () => {
    // F70's assertion from the other side, and the one that matters most: making
    // public clients work must not have made every client public. `oauthApp` is
    // registered with `isPublic` omitted, which defaults to false.
    expect(oauthApp.isPublic).toBe(false);

    const started = (await (
      await fetch(`${baseUrl}/oauth/device/code`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: oauthApp.clientId, scope: 'documents:read' }),
      })
    ).json()) as { device_code: string; user_code: string };

    await approveOutOfBand(started.user_code);

    const redeemed = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: started.device_code,
        client_id: oauthApp.clientId,
      }),
    });

    expect(redeemed.status).toBe(401);
    expect(((await redeemed.json()) as { error: string }).error).toBe('invalid_client');

    // And the SDK reports it as something a human can act on rather than as a
    // crash: `kind: 'auth'` carrying the OAuth code.
    const error = (await ShipClient.deviceLogin({
      baseUrl,
      clientId: oauthApp.clientId,
      clock: { now: () => Date.now(), random: () => 1, sleep: () => Promise.resolve() },
      onUserCode: (code) => {
        void approveOutOfBand(code);
      },
    }).catch((e: unknown) => e)) as ShipError;

    expect(error.kind).toBe('auth');
    expect(oauthErrorCode(error)).toBe('invalid_client');
  });
});
