/**
 * PF-172 (the `/oauth/*` error surface) and PF-173 (TTLs configurable at boot),
 * driven over real HTTP against `createOAuthRouter`.
 *
 * This is the end of the wire L24's rotation drill (PF-723–727) consumes. The
 * drill is L24's; the SEAM is this lane's, and the two tests at the bottom are
 * what prove the seam exists before the drill is written.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { FakeClock } from '../clock.js';
import { InMemoryOAuthAppRepo, secretMaterial } from '../apps/repo.js';
import { generateClientId, generateClientSecret } from '../apps/secrets.js';
import type { OAuthApp } from '../apps/types.js';
import type { Scope } from '../scopes/scopes.js';
import { InMemoryTokenRepo } from './tokenRepo.js';
import { issueTokenPair } from './issue.js';
import { createOAuthRouter } from './router.js';
import { clearReplayCache, REFRESH_ERROR_DESCRIPTIONS } from './rotation.js';
import { oauthErrorBodySchema, oauthTokenResponseSchema } from './oauthErrors.js';
import { DEFAULT_TOKEN_TTL, type TokenTtlConfig } from './tokens.js';

const GRANTED: Scope[] = ['documents:read', 'issues:read'];

let appsRepo: InMemoryOAuthAppRepo;
let tokenRepo: InMemoryTokenRepo;
let clock: FakeClock;
let app: OAuthApp;
let rawSecret: string;
let server: Express;

function boot(ttl: TokenTtlConfig = DEFAULT_TOKEN_TTL): Express {
  const server = express();
  server.use('/oauth', createOAuthRouter({ appsRepo, tokenRepo, clock, ttl }));
  return server;
}

beforeEach(async () => {
  clearReplayCache();
  appsRepo = new InMemoryOAuthAppRepo();
  tokenRepo = new InMemoryTokenRepo();
  clock = new FakeClock(1_700_000_000_000);
  rawSecret = generateClientSecret();
  app = await appsRepo.create({
    clientId: generateClientId(),
    ...secretMaterial(rawSecret),
    name: 'L06 surface app',
    ownerUserId: 'user-1',
    workspaceId: 'ws-1',
    redirectUris: ['https://example.test/cb'],
    requestedScopes: ['documents:read', 'documents:write', 'issues:read'],
  });
  server = boot();
});

async function mint() {
  const { response } = await issueTokenPair(
    { tokenRepo, clock, ttl: DEFAULT_TOKEN_TTL },
    { app, userId: 'user-1', scopes: GRANTED },
  );
  return response;
}

function exchange(target: Express, body: Record<string, string>) {
  return request(target)
    .post('/oauth/token')
    .type('form')
    .send({ client_id: app.clientId, client_secret: rawSecret, ...body });
}

describe('PF-166: the refresh grant over HTTP', () => {
  it('returns an RFC 6749 §5.1 body with Cache-Control: no-store', async () => {
    const tokens = await mint();
    const res = await exchange(server, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    });

    expect(res.status).toBe(200);
    expect(oauthErrorBodySchema.safeParse(res.body).success).toBe(false); // it is a success body
    expect(oauthTokenResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.refresh_token).not.toBe(tokens.refresh_token);
  });

  it('accepts HTTP Basic client authentication (RFC 6749 §2.3.1)', async () => {
    const tokens = await mint();
    const basic = Buffer.from(
      `${encodeURIComponent(app.clientId)}:${encodeURIComponent(rawSecret)}`,
    ).toString('base64');

    const res = await request(server)
      .post('/oauth/token')
      .set('Authorization', `Basic ${basic}`)
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });

    expect(res.status).toBe(200);
  });

  it('401s invalid_client for a bad secret, and never says WHY', async () => {
    const tokens = await mint();
    const res = await request(server)
      .post('/oauth/token')
      .type('form')
      .send({
        client_id: app.clientId,
        client_secret: 'ship_secret_wrong',
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
      });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
    // L02's PF-036 rule: unknown client, bad secret and deactivated app are
    // indistinguishable, or /oauth/token becomes a client-id enumerator.
    const unknown = await request(server)
      .post('/oauth/token')
      .type('form')
      .send({
        client_id: 'ship_app_nonexistent',
        client_secret: 'ship_secret_wrong',
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
      });
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(res.body);
  });

  it('D2: a DEACTIVATED app cannot exchange a refresh token', async () => {
    const tokens = await mint();
    await appsRepo.deactivateByOwner('user-1', new Date(clock.nowMs()));
    const res = await exchange(server, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
  });

  it('rejects an unknown grant_type as unsupported_grant_type', async () => {
    const res = await exchange(server, { grant_type: 'password', username: 'x', password: 'y' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_grant_type');
  });

  it('registers grant types as DATA, so L04/L05 add entries rather than editing a switch', async () => {
    const { grantHandlers } = await import('./router.js');
    const handlers = grantHandlers({ appsRepo, tokenRepo, clock, ttl: DEFAULT_TOKEN_TTL });
    expect(Object.keys(handlers)).toEqual(['refresh_token']);
    expect(typeof handlers.refresh_token).toBe('function');
  });
});

describe('PF-172: refresh failures are RFC 6749 invalid_grant, and distinguishable', () => {
  it('answers all three with HTTP 400 invalid_grant', async () => {
    const reused = await mint();
    await exchange(server, { grant_type: 'refresh_token', refresh_token: reused.refresh_token });
    const reusedRes = await exchange(server, {
      grant_type: 'refresh_token',
      refresh_token: reused.refresh_token,
    });

    const expiredTokens = await mint();
    clock.advance(DEFAULT_TOKEN_TTL.refreshSeconds * 1000 + 1);
    const expiredRes = await exchange(server, {
      grant_type: 'refresh_token',
      refresh_token: expiredTokens.refresh_token,
    });

    const unknownRes = await exchange(server, {
      grant_type: 'refresh_token',
      refresh_token: 'ship_rt_this-token-never-existed',
    });

    for (const res of [reusedRes, expiredRes, unknownRes]) {
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');
      expect(oauthErrorBodySchema.safeParse(res.body).success).toBe(true);
    }

    // …and distinguishable to a caller WITHOUT inventing a code set. L24's
    // PF-726 asserts only that the three differ and refuses to name them; this
    // is where they are named.
    const descriptions = [
      reusedRes.body.error_description,
      expiredRes.body.error_description,
      unknownRes.body.error_description,
    ];
    expect(new Set(descriptions).size).toBe(3);
    expect(descriptions).toEqual([
      REFRESH_ERROR_DESCRIPTIONS.reused,
      REFRESH_ERROR_DESCRIPTIONS.expired,
      REFRESH_ERROR_DESCRIPTIONS.unknown,
    ]);
  });

  it('never emits L07’s ApiError envelope on /oauth/*', async () => {
    const res = await exchange(server, {
      grant_type: 'refresh_token',
      refresh_token: 'ship_rt_nope',
    });
    // The public envelope's four keys must not appear here.
    expect(res.body).not.toHaveProperty('code');
    expect(res.body).not.toHaveProperty('request_id');
    expect(res.body).not.toHaveProperty('details');
    expect(res.body).toHaveProperty('error');
  });

  it('requires refresh_token and says so as invalid_request', async () => {
    const res = await exchange(server, { grant_type: 'refresh_token' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('rejects an unregistered scope as invalid_scope', async () => {
    const tokens = await mint();
    const res = await exchange(server, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      scope: 'documents:read not:a:real:scope',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_scope');
  });
});

describe('PF-173: TTLs are configurable at boot — the seam L24’s PF-727 consumes', () => {
  it('boots with a 2-second access TTL and a 5-second refresh TTL', async () => {
    const drill = boot({ accessSeconds: 2, refreshSeconds: 5 });
    const tokens = await mint();

    const res = await exchange(drill, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    });
    expect(res.status).toBe(200);
    // The drill's whole point: the issued token really carries the short TTL.
    expect(res.body.expires_in).toBe(2);
  });

  it('produces refresh expiry by advancing the clock, with no wall-clock wait', async () => {
    const drill = boot({ accessSeconds: 2, refreshSeconds: 5 });

    const { response } = await issueTokenPair(
      { tokenRepo, clock, ttl: { accessSeconds: 2, refreshSeconds: 5 } },
      { app, userId: 'user-1', scopes: GRANTED },
    );

    // Advance past the 5-second refresh TTL instantly. PRD p.11 rules out
    // sleeping; p.9 budgets zero flake over twenty runs.
    clock.advance(6000);

    const res = await exchange(drill, {
      grant_type: 'refresh_token',
      refresh_token: response.refresh_token,
    });
    expect(res.status).toBe(400);
    expect(res.body.error_description).toBe(REFRESH_ERROR_DESCRIPTIONS.expired);
  });

  it('the TTL comes from injected deps, not from a mutable module binding', async () => {
    // Two servers, two TTLs, alive at the same time. A module-level mutable
    // would make these interfere, and the interference would look like a flake.
    const fast = boot({ accessSeconds: 2, refreshSeconds: 5 });
    const slow = boot({ accessSeconds: 3600, refreshSeconds: 2592000 });

    const a = await mint();
    const b = await mint();

    const fastRes = await exchange(fast, {
      grant_type: 'refresh_token',
      refresh_token: a.refresh_token,
    });
    const slowRes = await exchange(slow, {
      grant_type: 'refresh_token',
      refresh_token: b.refresh_token,
    });

    expect(fastRes.body.expires_in).toBe(2);
    expect(slowRes.body.expires_in).toBe(3600);
  });

  it('testDeps() exposes tokenRepo and tokenTtl for a drill to override', async () => {
    const { testDeps } = await import('../../deps.js');
    const base = testDeps();
    expect(base.tokenRepo).toBeDefined();
    expect(base.tokenTtl).toEqual(DEFAULT_TOKEN_TTL);

    const drill = testDeps({ tokenTtl: { accessSeconds: 2, refreshSeconds: 5 } });
    expect(drill.tokenTtl).toEqual({ accessSeconds: 2, refreshSeconds: 5 });
  });
});
