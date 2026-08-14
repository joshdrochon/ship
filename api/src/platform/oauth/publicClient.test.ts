/**
 * L99 F27 / F50 — public clients at `/oauth/token`. Migration 074.
 *
 * Written by L24 because PF-734 (Authorization Code + PKCE in a real browser
 * SPA, MVP gate item 2 / Testing Scenario 2) is unreachable without it and the
 * two lanes the findings name as owners had not shipped it. **L02 and L06: this
 * file is describing your contract; the reasoning is in `router.ts`'s
 * `authenticateClient` header and in migration 074.**
 *
 * The point of these cases is that they fail in FOUR different directions, and
 * a fix that only satisfies the first is the dangerous one:
 *
 *   1. a public client CAN exchange with `client_id` alone            (the fix)
 *   2. a confidential client STILL cannot                     (no downgrade)
 *   3. a DEACTIVATED public client cannot                         (D2 holds)
 *   4. PKCE is still verified for a public client            (not a bypass)
 *
 * (2) is the one that matters. "No secret presented → skip the check" passes
 * (1) and fails (2), and it is the shape a hurried fix reaches for: it would
 * let anyone turn any confidential app into a public one by omitting a form
 * field, which is a complete authentication bypass for every app on the server.
 *
 * Driven over real HTTP against `createOAuthRouter`, following
 * `authCodeGrant.test.ts` — a status and a body are the assertion, and only the
 * wire tells you which one shipped.
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
import {
  InMemoryAuthCodeRepo,
  generateAuthorizationCode,
  hashAuthorizationCode,
  authorizationCodePrefix,
  AUTHORIZATION_CODE_TTL_SECONDS,
} from './authCodes.js';
import { createOAuthRouter } from './router.js';
import { DEFAULT_TOKEN_TTL } from './tokens.js';
import { s256Challenge } from './pkce.js';

const REDIRECT_URI = 'http://localhost:4173/callback';
const GRANTED: Scope[] = ['documents:read'];

/** RFC 7636 Appendix B, verbatim — the same vector L04's suite uses. */
const RFC7636_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

let appsRepo: InMemoryOAuthAppRepo;
let tokenRepo: InMemoryTokenRepo;
let authCodeRepo: InMemoryAuthCodeRepo;
let clock: FakeClock;
let server: Express;

let publicApp: OAuthApp;
let confidentialApp: OAuthApp;
let confidentialSecret: string;

async function seedCode(app: OAuthApp, verifier = RFC7636_VERIFIER): Promise<string> {
  const code = generateAuthorizationCode();
  const now = new Date(clock.nowMs());
  await authCodeRepo.insert({
    codeHash: hashAuthorizationCode(code),
    codePrefix: authorizationCodePrefix(code),
    appId: app.id,
    userId: 'user-1',
    workspaceId: 'ws-1',
    redirectUri: REDIRECT_URI,
    scopes: GRANTED,
    codeChallenge: s256Challenge(verifier),
    codeChallengeMethod: 'S256',
    expiresAt: new Date(now.getTime() + AUTHORIZATION_CODE_TTL_SECONDS * 1000),
    createdAt: now,
  });
  return code;
}

function exchange(body: Record<string, string>) {
  return request(server).post('/oauth/token').type('form').send(body);
}

beforeEach(async () => {
  appsRepo = new InMemoryOAuthAppRepo();
  tokenRepo = new InMemoryTokenRepo();
  authCodeRepo = new InMemoryAuthCodeRepo();
  clock = new FakeClock(1_700_000_000_000);

  publicApp = await appsRepo.create({
    clientId: generateClientId(),
    ...secretMaterial(generateClientSecret()),
    name: 'L24 browser demo',
    ownerUserId: 'user-1',
    workspaceId: 'ws-1',
    redirectUris: [REDIRECT_URI],
    requestedScopes: GRANTED,
    isPublic: true,
  });

  confidentialSecret = generateClientSecret();
  confidentialApp = await appsRepo.create({
    clientId: generateClientId(),
    ...secretMaterial(confidentialSecret),
    name: 'L24 confidential control',
    ownerUserId: 'user-1',
    workspaceId: 'ws-1',
    redirectUris: [REDIRECT_URI],
    requestedScopes: GRANTED,
  });

  server = express();
  server.use(
    '/oauth',
    createOAuthRouter({ appsRepo, tokenRepo, authCodeRepo, clock, ttl: DEFAULT_TOKEN_TTL }),
  );
});

describe('F27/F50 · a PUBLIC client authenticates on client_id alone', () => {
  it('exchanges an authorization code with no client_secret', async () => {
    const code = await seedCode(publicApp);

    const res = await exchange({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: publicApp.clientId,
      code_verifier: RFC7636_VERIFIER,
    });

    expect(res.status).toBe(200);
    expect(res.body.access_token).toEqual(expect.any(String));
    expect(res.body.refresh_token).toEqual(expect.any(String));
    expect(res.body.token_type).toBe('Bearer');
  });

  it('registers the default as CONFIDENTIAL, so is_public is an opt-in', () => {
    expect(confidentialApp.isPublic).toBe(false);
    expect(publicApp.isPublic).toBe(true);
  });
});

describe('F27/F50 · the no-downgrade property — the case a hurried fix fails', () => {
  it('refuses a CONFIDENTIAL client that omits its secret', async () => {
    const code = await seedCode(confidentialApp);

    const res = await exchange({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: confidentialApp.clientId,
      code_verifier: RFC7636_VERIFIER,
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
  });

  it('still accepts that same confidential client WITH its secret', async () => {
    const code = await seedCode(confidentialApp);

    const res = await exchange({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: confidentialApp.clientId,
      client_secret: confidentialSecret,
      code_verifier: RFC7636_VERIFIER,
    });

    expect(res.status).toBe(200);
  });

  it('answers an unknown client_id with the SAME 401 body — no new oracle', async () => {
    const unknown = await exchange({
      grant_type: 'authorization_code',
      code: 'nope',
      redirect_uri: REDIRECT_URI,
      client_id: 'ship_client_does_not_exist',
      code_verifier: RFC7636_VERIFIER,
    });
    const confidential = await exchange({
      grant_type: 'authorization_code',
      code: 'nope',
      redirect_uri: REDIRECT_URI,
      client_id: confidentialApp.clientId,
      code_verifier: RFC7636_VERIFIER,
    });

    expect(unknown.status).toBe(confidential.status);
    expect(unknown.body).toEqual(confidential.body);
  });
});

describe('F27/F50 · the guarantees a public client must NOT lose', () => {
  it('refuses a DEACTIVATED public client (D2 / PF-052 still holds)', async () => {
    const code = await seedCode(publicApp);
    await appsRepo.deactivate(publicApp.id, 'admin_action', new Date(clock.nowMs()));

    const res = await exchange({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: publicApp.clientId,
      code_verifier: RFC7636_VERIFIER,
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
  });

  it('still verifies PKCE for a public client — a wrong verifier is invalid_grant', async () => {
    const code = await seedCode(publicApp);

    const res = await exchange({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: publicApp.clientId,
      code_verifier: 'X'.repeat(43),
    });

    // p.5's mandatory negative case, on the public-client path. Dropping client
    // authentication must not drop the check that replaces it.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });
});

describe('F38 · the token endpoint answers a browser preflight', () => {
  it('OPTIONS /oauth/token returns 204 with the headers a fetch needs', async () => {
    const res = await request(server)
      .options('/oauth/token')
      .set('Origin', 'http://localhost:4173')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-headers']).toContain('Content-Type');
  });

  it('never sends Allow-Credentials — a wildcard origin must stay credential-free', async () => {
    const res = await request(server)
      .options('/oauth/token')
      .set('Origin', 'http://localhost:4173')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('leaves the COOKIE-authenticated consent screen with no CORS header', async () => {
    // `/authorize` is a session-cookie surface. Advertising it cross-origin is
    // the one thing this policy must not do, so it is asserted rather than
    // assumed from the mount path.
    const res = await request(server).get('/oauth/authorize').set('Origin', 'http://evil.test');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
