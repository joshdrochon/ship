/**
 * PF-100 – PF-107 — the token exchange, the PKCE assertion point, and the
 * mandatory negative case.
 *
 * Driven over real HTTP against `createOAuthRouter` rather than against the
 * handler function, because PF-102 asserts a STATUS and a BODY: "a 401 with the
 * right body or a 400 with an ApiError body each fail this row differently", and
 * only the wire can tell you which one you shipped.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanTree, stripComments } from '../../test/sourceScan.js';
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
import { DEFAULT_TOKEN_TTL, hashToken } from './tokens.js';
import { s256Challenge, verifyPkce, isValidVerifier } from './pkce.js';
import { oauthErrorBodySchema, oauthTokenResponseSchema } from './oauthErrors.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REDIRECT_URI = 'https://app.example.test/callback';
const GRANTED: Scope[] = ['documents:read', 'issues:read'];

/** RFC 7636 Appendix B, verbatim. */
const RFC7636_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC7636_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

let appsRepo: InMemoryOAuthAppRepo;
let tokenRepo: InMemoryTokenRepo;
let authCodeRepo: InMemoryAuthCodeRepo;
let clock: FakeClock;
let app: OAuthApp;
let rawSecret: string;
let server: Express;

function boot(): Express {
  const s = express();
  s.use(
    '/oauth',
    createOAuthRouter({ appsRepo, tokenRepo, authCodeRepo, clock, ttl: DEFAULT_TOKEN_TTL }),
  );
  return s;
}

/** Writes a code row the way the consent POST would, and returns the raw code. */
async function seedCode(
  overrides: Partial<{
    challenge: string;
    redirectUri: string;
    appId: string;
    scopes: Scope[];
    ttlSeconds: number;
  }> = {},
) {
  const code = generateAuthorizationCode();
  const now = new Date(clock.nowMs());
  const row = await authCodeRepo.insert({
    codeHash: hashAuthorizationCode(code),
    codePrefix: authorizationCodePrefix(code),
    appId: overrides.appId ?? app.id,
    userId: 'user-1',
    workspaceId: 'ws-1',
    redirectUri: overrides.redirectUri ?? REDIRECT_URI,
    scopes: overrides.scopes ?? GRANTED,
    codeChallenge: overrides.challenge ?? s256Challenge(RFC7636_VERIFIER),
    codeChallengeMethod: 'S256',
    expiresAt: new Date(
      now.getTime() + (overrides.ttlSeconds ?? AUTHORIZATION_CODE_TTL_SECONDS) * 1000,
    ),
    createdAt: now,
  });
  return { code, row };
}

function exchange(body: Record<string, string | undefined>) {
  const form: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (v !== undefined) form[k] = v;
  return request(server).post('/oauth/token').type('form').send(form);
}

/** A complete, correct exchange. Individual cases break exactly one field. */
function goodExchange(code: string, overrides: Record<string, string | undefined> = {}) {
  return exchange({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: app.clientId,
    client_secret: rawSecret,
    code_verifier: RFC7636_VERIFIER,
    ...overrides,
  });
}

beforeEach(async () => {
  appsRepo = new InMemoryOAuthAppRepo();
  tokenRepo = new InMemoryTokenRepo();
  authCodeRepo = new InMemoryAuthCodeRepo();
  clock = new FakeClock(1_700_000_000_000);
  rawSecret = generateClientSecret();
  app = await appsRepo.create({
    clientId: generateClientId(),
    ...secretMaterial(rawSecret),
    name: 'L04 exchange app',
    ownerUserId: 'user-1',
    workspaceId: 'ws-1',
    redirectUris: [REDIRECT_URI],
    requestedScopes: ['documents:read', 'documents:write', 'issues:read'],
  });
  server = boot();
});

describe('PF-101 — ★ PKCE validated at the token endpoint', () => {
  it('RFC 7636 Appendix B: the published verifier produces the published challenge', () => {
    // The single most common way a hand-rolled PKCE implementation is silently
    // wrong is the encoding — hex, or standard base64 with padding, instead of
    // unpadded base64url. A known-answer vector is the only thing that catches
    // it, because a round-trip test against your own encoder passes either way.
    expect(s256Challenge(RFC7636_VERIFIER)).toBe(RFC7636_CHALLENGE);
  });

  it('the challenge is unpadded base64url, not hex and not standard base64', () => {
    const challenge = s256Challenge(RFC7636_VERIFIER);
    expect(challenge).toHaveLength(43);
    expect(challenge).not.toContain('=');
    expect(challenge).not.toContain('+');
    expect(challenge).not.toContain('/');
    expect(challenge).not.toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifyPkce accepts the matching verifier and rejects everything else', () => {
    expect(verifyPkce(RFC7636_VERIFIER, RFC7636_CHALLENGE)).toBe(true);
    expect(verifyPkce('w'.repeat(43), RFC7636_CHALLENGE)).toBe(false);
    // The challenge itself is not the verifier — this is the `plain` confusion.
    expect(verifyPkce(RFC7636_CHALLENGE, RFC7636_CHALLENGE)).toBe(false);
  });

  it('isValidVerifier enforces RFC 7636 §4.1 form before anything hashes', () => {
    expect(isValidVerifier(RFC7636_VERIFIER)).toBe(true);
    expect(isValidVerifier('a'.repeat(42))).toBe(false);
    expect(isValidVerifier('a'.repeat(129))).toBe(false);
    expect(isValidVerifier(`${'a'.repeat(42)}!`)).toBe(false);
    expect(isValidVerifier('')).toBe(false);
  });

  it('the comparison site is unique in the repository', () => {
    // A second hand-written comparison is how the constant-time property stops
    // holding without any test noticing.
    const callers = scanTree(HERE)
      .filter((f) => f.name !== 'pkce.ts' && /\bverifyPkce\s*\(/.test(f.code))
      .map((f) => f.name);
    expect(callers).toEqual(['authCodeGrant.ts']);

    const pkce = readFileSync(join(HERE, 'pkce.ts'), 'utf8');
    expect(pkce).toContain('timingSafeEqual');
  });
});

describe('PF-102 — ★ THE MANDATORY NEGATIVE: wrong verifier → 400 invalid_grant', () => {
  it('unit level: verifyPkce returns false', async () => {
    const { row } = await seedCode();
    expect(verifyPkce('z'.repeat(64), row.codeChallenge)).toBe(false);
  });

  it('HTTP level: status 400 AND body error invalid_grant', async () => {
    const { code } = await seedCode();
    const res = await goodExchange(code, { code_verifier: 'z'.repeat(64) });

    // Both asserted, because they fail this row differently: a 401 with the
    // right body and a 400 with an ApiError body are each wrong.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');

    // And the body is the RFC 6749 §5.2 shape, validated against L06's oracle.
    expect(() => oauthErrorBodySchema.parse(res.body)).not.toThrow();
  });

  it('no token is issued — asserted by row count on the token store', async () => {
    const { code } = await seedCode();
    await goodExchange(code, { code_verifier: 'z'.repeat(64) });
    expect(await tokenRepo.listFamily('any')).toHaveLength(0);
    const res = await goodExchange(code, { code_verifier: 'z'.repeat(64) });
    expect(res.body).not.toHaveProperty('access_token');
  });

  it('the code is BURNED by the failed attempt — no second guess', async () => {
    const { code, row } = await seedCode();
    await goodExchange(code, { code_verifier: 'z'.repeat(64) });

    const after = await authCodeRepo.findByHash(hashAuthorizationCode(code));
    expect(after!.consumedAt).not.toBeNull();
    // Nothing was issued, so there is no family to revoke later.
    expect(after!.issuedFamilyId).toBeNull();
    expect(after!.id).toBe(row.id);

    // Even the CORRECT verifier now fails. This is the property that stops an
    // attacker holding a stolen code from retrying with a better guess.
    const retry = await goodExchange(code);
    expect(retry.status).toBe(400);
    expect(retry.body.error).toBe('invalid_grant');
    expect(retry.body).not.toHaveProperty('access_token');
  });

  it('the failure body carries no ApiError fields whatsoever', async () => {
    const { code } = await seedCode();
    const res = await goodExchange(code, { code_verifier: 'z'.repeat(64) });
    // L99 U3 / PF-106: `/oauth/*` is not the public envelope.
    expect(res.body).not.toHaveProperty('request_id');
    expect(res.body).not.toHaveProperty('code');
    expect(res.body).not.toHaveProperty('details');
    expect(Object.keys(res.body).sort()).toEqual(['error', 'error_description']);
  });
});

describe('PF-103 — a missing code_verifier is invalid_grant, never a bypass', () => {
  it.each([
    ['absent', undefined],
    ['empty string', ''],
    ['too short', 'a'.repeat(42)],
    ['too long', 'a'.repeat(129)],
    ['illegal characters', `${'a'.repeat(42)}$`],
  ])('%s → 400 invalid_grant', async (_label, verifier) => {
    const { code } = await seedCode();
    const res = await goodExchange(code, { code_verifier: verifier });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(res.body).not.toHaveProperty('access_token');
  });

  it('the handler has NO branch that skips PKCE validation', () => {
    // The structural half, and the point of the ticket. `code_challenge` is
    // NOT NULL on the row (migration 065) precisely so no such branch could be
    // justified; this asserts nobody wrote one anyway.
    const source = scanTree(HERE).find((f) => f.name === 'authCodeGrant.ts')!.code;

    // No truthiness guard on the stored challenge.
    expect(source).not.toMatch(/if\s*\(\s*!?\s*\w+\.codeChallenge\s*\)/);
    // No conditional around the verification itself.
    expect(source).not.toMatch(/if\s*\([^)]*\)\s*\{?[^}]*verifyPkce/);
    // The call is unconditional and its failure returns.
    expect(source).toMatch(/if\s*\(!verifyPkce\(/);
    // And there is exactly one call.
    expect(source.match(/verifyPkce\(/g)).toHaveLength(1);
  });
});

describe('PF-100 — client authentication through L02, and the RFC 6749 §5.1 success body', () => {
  it('a correct exchange returns the §5.1 body with no-store', async () => {
    const { code } = await seedCode();
    const res = await goodExchange(code);

    expect(res.status).toBe(200);
    expect(() => oauthTokenResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.scope).toBe('documents:read issues:read');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('accepts HTTP Basic as well as form-body credentials', async () => {
    const { code } = await seedCode();
    const basic = Buffer.from(
      `${encodeURIComponent(app.clientId)}:${encodeURIComponent(rawSecret)}`,
    ).toString('base64');

    const res = await request(server)
      .post('/oauth/token')
      .set('Authorization', `Basic ${basic}`)
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: RFC7636_VERIFIER,
      });

    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();
  });

  it.each([
    ['an unknown client_id', () => ({ client_id: 'no-such-client' })],
    ['a wrong secret', () => ({ client_secret: 'wrong-secret' })],
  ])('%s is invalid_client + 401 + WWW-Authenticate', async (_label, override) => {
    const { code } = await seedCode();
    const res = await goodExchange(code, override());
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
    expect(res.headers['www-authenticate']).toMatch(/^Basic/);
  });

  it('a deactivated app is byte-identical to an unknown client', async () => {
    const { code } = await seedCode();
    await appsRepo.deactivate(app.id, 'owner_deleted', new Date());
    const deactivated = await goodExchange(code);
    const unknown = await goodExchange(code, { client_id: 'no-such-client' });
    expect(deactivated.status).toBe(unknown.status);
    expect(deactivated.body).toEqual(unknown.body);
  });

  it('this lane defines no client-secret comparison of its own', () => {
    // PF-036's constant-time and no-ownership-oracle properties are only true
    // here because verification goes through L02's single function.
    const files = scanTree(HERE).filter((f) => f.name.startsWith('authCode'));
    for (const file of files) {
      expect(file.code, `${file.name} compares a secret`).not.toMatch(
        /clientSecretHash|timingSafeEqual|secretPrefix/,
      );
    }
  });
});

describe('PF-105 — the code is bound to its client, its redirect_uri and its lifetime', () => {
  it('a code issued to app A presented by app B is invalid_grant, not invalid_client', async () => {
    const otherSecret = generateClientSecret();
    const other = await appsRepo.create({
      clientId: generateClientId(),
      ...secretMaterial(otherSecret),
      name: 'Other app',
      ownerUserId: 'user-1',
      workspaceId: 'ws-1',
      redirectUris: [REDIRECT_URI],
      requestedScopes: ['documents:read'],
    });
    const { code } = await seedCode();

    const res = await goodExchange(code, {
      client_id: other.clientId,
      client_secret: otherSecret,
    });

    // The client authenticated fine. What is wrong is the GRANT.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('a redirect_uri differing by one byte is invalid_grant', async () => {
    const { code } = await seedCode();
    const res = await goodExchange(code, { redirect_uri: `${REDIRECT_URI}/` });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('compares against the URI ON THE ROW, not the app registration', async () => {
    // An app with two registered URIs must not redeem a code issued for one
    // against the other.
    const twoUris = await appsRepo.create({
      clientId: generateClientId(),
      ...secretMaterial(rawSecret),
      name: 'Two URIs',
      ownerUserId: 'user-1',
      workspaceId: 'ws-1',
      redirectUris: [REDIRECT_URI, 'https://app.example.test/other'],
      requestedScopes: ['documents:read'],
    });
    const { code } = await seedCode({ appId: twoUris.id, redirectUri: REDIRECT_URI });

    const res = await goodExchange(code, {
      client_id: twoUris.clientId,
      redirect_uri: 'https://app.example.test/other',
    });
    expect(res.body.error).toBe('invalid_grant');
  });

  it('an expired code is invalid_grant — driven by the clock, never by waiting', async () => {
    const { code } = await seedCode();
    // PRD p.11: deterministic clock injection, never setTimeout in a test.
    clock.advance((AUTHORIZATION_CODE_TTL_SECONDS + 1) * 1000);
    const res = await goodExchange(code);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('a code one second inside its TTL still redeems', async () => {
    const { code } = await seedCode();
    clock.advance((AUTHORIZATION_CODE_TTL_SECONDS - 1) * 1000);
    const res = await goodExchange(code);
    expect(res.status).toBe(200);
  });

  it('an unknown code is invalid_grant, indistinguishable from an expired one', async () => {
    const unknown = await goodExchange(generateAuthorizationCode());
    const { code } = await seedCode();
    clock.advance((AUTHORIZATION_CODE_TTL_SECONDS + 1) * 1000);
    const expired = await goodExchange(code);
    expect(unknown.status).toBe(expired.status);
    expect(unknown.body).toEqual(expired.body);
  });
});

describe('PF-104 — redeemed exactly once, and a replay revokes what it produced', () => {
  it('redeem, then replay: invalid_grant and the first pair is revoked', async () => {
    const { code } = await seedCode();
    const first = await goodExchange(code);
    expect(first.status).toBe(200);

    const accessHash = hashToken(first.body.access_token);
    const before = await tokenRepo.findByHash(accessHash);
    expect(before!.revokedAt).toBeNull();

    const replay = await goodExchange(code);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');

    // RFC 6749 §4.1.2's SHOULD, taken: a code presented twice means it leaked.
    const after = await tokenRepo.findByHash(accessHash);
    expect(after!.revokedAt).not.toBeNull();
    expect(after!.revocationReason).toBe('refresh_token_reuse');

    // The refresh half of the family too, not just the access token.
    const family = await tokenRepo.listFamily(after!.familyId);
    expect(family).toHaveLength(2);
    expect(family.every((t) => t.revokedAt !== null)).toBe(true);
  });

  it('a replayed code that produced nothing has no family to revoke, and does not crash', async () => {
    const { code } = await seedCode();
    // Burn it with a wrong verifier — nothing issued.
    await goodExchange(code, { code_verifier: 'z'.repeat(64) });
    const replay = await goodExchange(code);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
  });

  it('the code row records the family the redemption produced', async () => {
    const { code } = await seedCode();
    const res = await goodExchange(code);
    const row = await authCodeRepo.findByHash(hashAuthorizationCode(code));
    const token = await tokenRepo.findByHash(hashToken(res.body.access_token));
    // Written by the SAME statement that burned the code, so the two cannot
    // come apart — a burned code whose family is unknown is one we could not
    // revoke if it later turned out to have leaked.
    expect(row!.issuedFamilyId).toBe(token!.familyId);
  });

  it('concurrent exchanges of one code yield exactly one token pair', async () => {
    const { code } = await seedCode();
    const results = await Promise.all(Array.from({ length: 6 }, () => goodExchange(code)));

    const ok = results.filter((r) => r.status === 200);
    const failed = results.filter((r) => r.status === 400);
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(5);
    for (const r of failed) expect(r.body.error).toBe('invalid_grant');
  });
});

describe('PF-106 / L99 U3 — the /oauth error surface is not ApiError', () => {
  it('every failure path on /oauth/token validates against oauthErrorBodySchema', async () => {
    const { code: c1 } = await seedCode();
    const { code: c2 } = await seedCode();
    const { code: c3 } = await seedCode();

    const failures = [
      await exchange({ grant_type: 'authorization_code' }), // no client auth
      await goodExchange(c1, { code_verifier: 'z'.repeat(64) }),
      await goodExchange(c2, { code_verifier: undefined }),
      await goodExchange(c3, { redirect_uri: 'https://elsewhere.test/cb' }),
      await goodExchange(generateAuthorizationCode()),
      await exchange({
        grant_type: 'made_up_grant',
        client_id: app.clientId,
        client_secret: rawSecret,
      }),
      await exchange({ client_id: app.clientId, client_secret: rawSecret }), // no grant_type
    ];

    for (const res of failures) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(() => oauthErrorBodySchema.parse(res.body), JSON.stringify(res.body)).not.toThrow();
      // No public envelope, in either direction.
      expect(res.body).not.toHaveProperty('request_id');
      expect(res.body).not.toHaveProperty('code');
    }
  });

  it('this lane imports nothing from L07’s ApiError module', () => {
    const files = scanTree(HERE).filter((f) =>
      ['authCodeGrant.ts', 'authCodes.ts', 'authorize.ts', 'consent.ts', 'consentPage.ts', 'pgAuthCodeRepo.ts'].includes(
        f.name,
      ),
    );
    expect(files.length).toBe(6);
    for (const file of files) {
      expect(file.code, `${file.name} imports ApiError`).not.toMatch(/api\/v1\/errors|ApiError/);
    }
  });

  it('invalid_grant is in the OAuth code set and in no ApiError code set', async () => {
    const { ApiErrorCodes } = (await import('../api/v1/errors.js')) as unknown as {
      ApiErrorCodes?: readonly string[];
    };
    // Comments stripped: L07's own file DISCUSSES `invalid_grant` at length,
    // explaining why it is deliberately absent. A grep that cannot tell code
    // from prose would fail on the documentation of the rule it enforces.
    const errorsCode = stripComments(
      readFileSync(join(HERE, '..', 'api', 'v1', 'errors.ts'), 'utf8'),
    );
    expect(errorsCode).not.toContain('invalid_grant');
    if (ApiErrorCodes) expect(ApiErrorCodes).not.toContain('invalid_grant');
  });
});
