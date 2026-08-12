/**
 * The two claims this lane is asked to prove over the wire, with `/oauth/*` and
 * `/api/v1/*` mounted on ONE app sharing ONE set of repositories.
 *
 *   1. PF-052's end-to-end half — a token minted BEFORE an app is deactivated
 *      401s on its next `/api/v1` request. L02 asserted the flag; it explicitly
 *      deferred the boundary to this lane.
 *   2. PF-168's observable half — replaying a spent refresh token at
 *      `/oauth/token` kills the CURRENT ACCESS TOKEN on `/api/v1`.
 *
 * Both are asserted elsewhere against `resolveToken` and `rotateRefreshToken`
 * directly. They are re-asserted here because a unit test proves the decision
 * and only a request proves the WIRING — that the middleware is actually
 * mounted, actually reaches the same repository the OAuth router writes to, and
 * actually turns the decision into a 401.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express, type Router } from 'express';
import request from 'supertest';
import { createPublicRouter } from '../api/v1/router.js';
import { V1_PREFIX } from '../api/v1/testSupport.js';
import { InMemoryAuditSink } from '../audit/audit.js';
import { InMemoryTokenBucket } from '../ratelimit/limiter.js';
import { FakeClock } from '../clock.js';
import { InMemoryOAuthAppRepo, secretMaterial } from '../apps/repo.js';
import { generateClientId, generateClientSecret } from '../apps/secrets.js';
import type { OAuthApp } from '../apps/types.js';
import type { Scope } from '../scopes/scopes.js';
import { InMemoryTokenRepo } from './tokenRepo.js';
import { issueTokenPair } from './issue.js';
import { bearerTokenMiddleware } from './bearer.js';
import { createOAuthRouter } from './router.js';
import { clearReplayCache } from './rotation.js';
import { DEFAULT_TOKEN_TTL } from './tokens.js';

const GRANTED: Scope[] = ['documents:read'];

let appsRepo: InMemoryOAuthAppRepo;
let tokenRepo: InMemoryTokenRepo;
let clock: FakeClock;
let oauthApp: OAuthApp;
let rawSecret: string;
let server: Express;

const mountResources = (router: Router): void => {
  router.get('/documents', (_req, res) => res.json({ data: [], next_cursor: null }));
};

beforeEach(async () => {
  clearReplayCache();
  clock = new FakeClock(1_700_000_000_000);
  appsRepo = new InMemoryOAuthAppRepo(() => new Date(clock.nowMs()));
  tokenRepo = new InMemoryTokenRepo();
  rawSecret = generateClientSecret();
  oauthApp = await appsRepo.create({
    clientId: generateClientId(),
    ...secretMaterial(rawSecret),
    name: 'L06 end-to-end app',
    ownerUserId: 'user-1',
    workspaceId: 'ws-1',
    redirectUris: ['https://example.test/cb'],
    requestedScopes: ['documents:read', 'issues:read'],
  });

  const generous = () => new InMemoryTokenBucket({ capacity: 1e6, refillPerSecond: 1e6 });

  server = express();
  // ONE app, BOTH surfaces, sharing the repositories — which is the only way
  // these two claims can be tested honestly.
  server.use('/oauth', createOAuthRouter({ appsRepo, tokenRepo, clock, ttl: DEFAULT_TOKEN_TTL }));
  server.use(
    V1_PREFIX,
    createPublicRouter({
      bearerAuth: bearerTokenMiddleware({ tokenRepo, appsRepo, clock }),
      perAppLimiter: generous(),
      perTokenLimiter: generous(),
      auditSink: new InMemoryAuditSink(),
      mountResources,
    }),
  );
});

async function mint() {
  const { response } = await issueTokenPair(
    { tokenRepo, clock, ttl: DEFAULT_TOKEN_TTL },
    { app: oauthApp, userId: 'user-1', scopes: GRANTED },
  );
  return response;
}

const callApi = (token: string) =>
  request(server).get('/api/v1/documents').set('Authorization', `Bearer ${token}`);

const refresh = (refreshToken: string) =>
  request(server).post('/oauth/token').type('form').send({
    client_id: oauthApp.clientId,
    client_secret: rawSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

describe('PF-052 end-to-end: a token minted before deactivation 401s on its next request', () => {
  it('works before the deactivation and 401s immediately after', async () => {
    const tokens = await mint();

    // Live. Without this the test could pass because everything 401s.
    expect((await callApi(tokens.access_token)).status).toBe(200);

    // D2: the owner is deleted, so their apps are deactivated.
    const count = await appsRepo.deactivateByOwner('user-1', new Date(clock.nowMs()));
    expect(count).toBe(1);

    // THE CLAIM. No clock advance — the token has not expired, it has stopped
    // being honoured. This is what makes "a deleted user's access cannot
    // outlive them" true rather than stated.
    const after = await callApi(tokens.access_token);
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('unauthorized');

    // …and it is INVALID, not EXPIRED. `expired` would send the SDK to
    // /oauth/token to refresh, which will also fail — a confusing loop instead
    // of a clean re-authentication.
    expect(after.body.details).toEqual({ reason: 'invalid' });
  });

  it('the deactivated app also cannot refresh its way back in', async () => {
    const tokens = await mint();
    await appsRepo.deactivateByOwner('user-1', new Date(clock.nowMs()));

    const res = await refresh(tokens.refresh_token);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
  });

  it('reactivation restores access for tokens that never expired', async () => {
    const tokens = await mint();
    await appsRepo.deactivateByOwner('user-1', new Date(clock.nowMs()));
    expect((await callApi(tokens.access_token)).status).toBe(401);

    // L02's PF-053: an admin reactivates and reassigns. client_id and the
    // secret are untouched, so the stored credential keeps working — which is
    // the recovery story D2 promises p.17.
    await appsRepo.reactivate(oauthApp.id, 'user-2');
    expect((await callApi(tokens.access_token)).status).toBe(200);
  });
});

describe('PF-168 end-to-end: refresh reuse revokes the family, over the wire', () => {
  it('replaying a spent refresh token kills the CURRENT access token on /api/v1', async () => {
    const g1 = await mint();

    // A1 works.
    expect((await callApi(g1.access_token)).status).toBe(200);

    // Rotate: R1 -> R2/A2.
    const rotated = await refresh(g1.refresh_token);
    expect(rotated.status).toBe(200);
    const a2 = rotated.body.access_token as string;
    const r2 = rotated.body.refresh_token as string;

    // A2 works; A1 is already dead (PF-166 revokes the old access token).
    expect((await callApi(a2)).status).toBe(200);
    expect((await callApi(g1.access_token)).status).toBe(401);

    // THE THEFT SIGNAL: R1 presented a second time.
    const replay = await refresh(g1.refresh_token);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');

    // A2 — never itself stolen, and live one line ago — is now 401. This is the
    // half a subscriber can observe and the half that is easy to omit.
    const afterReuse = await callApi(a2);
    expect(afterReuse.status).toBe(401);
    expect(afterReuse.body.details).toEqual({ reason: 'invalid' });

    // R2 no longer exchanges either. The family is gone, not just the token.
    expect((await refresh(r2)).status).toBe(400);
  });

  it('replaying a LONG-spent token after three rotations still kills the current pair', async () => {
    const g1 = await mint();

    const r2 = await refresh(g1.refresh_token);
    const r3 = await refresh(r2.body.refresh_token as string);
    const r4 = await refresh(r3.body.refresh_token as string);
    expect(r4.status).toBe(200);

    const a4 = r4.body.access_token as string;
    expect((await callApi(a4)).status).toBe(200);

    // Three generations old.
    expect((await refresh(g1.refresh_token)).status).toBe(400);

    // Revocation is keyed on the FAMILY, not on the previous token.
    expect((await callApi(a4)).status).toBe(401);
    expect((await refresh(r4.body.refresh_token as string)).status).toBe(400);
  });

  it('a second user’s session is untouched', async () => {
    const mine = await mint();
    const { response: theirs } = await issueTokenPair(
      { tokenRepo, clock, ttl: DEFAULT_TOKEN_TTL },
      { app: oauthApp, userId: 'user-2', scopes: GRANTED },
    );

    await refresh(mine.refresh_token);
    await refresh(mine.refresh_token); // reuse — revokes MY family

    expect((await callApi(theirs.access_token)).status).toBe(200);
    expect((await refresh(theirs.refresh_token)).status).toBe(200);
  });
});
