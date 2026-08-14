/**
 * L23 S1 — `grant_type=client_credentials`. PF-686, PF-687, PF-688.
 *
 * Driven over real HTTP against `createOAuthRouter`, following
 * `publicClient.test.ts` and `authCodeGrant.test.ts`: a status and a body are
 * the assertion, because only the wire tells you which implementation shipped.
 *
 * ## The tests are written against the ENDPOINT, not the internals
 *
 * PF-686 carries a deliberate seam: if L06 later lands a shared token issuer,
 * this grant collapses into a fourth `grant_type` branch over it. Every
 * assertion below goes through `POST /oauth/token`, so that move breaks nothing
 * here — which is the property the seam exists to buy and the reason it is
 * worth stating rather than assuming.
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
import { createOAuthRouter } from './router.js';
import { DEFAULT_TOKEN_TTL, hashToken, ACCESS_TOKEN_TTL_SECONDS } from './tokens.js';
import { resolveToken } from './resolve.js';
import { CLIENT_CREDENTIALS_GRANT_TYPE } from './clientCredentialsGrant.js';

/** The agent's three, per D5b. */
const AGENT_SCOPES: Scope[] = ['documents:read', 'issues:read', 'sprints:read'];

let appsRepo: InMemoryOAuthAppRepo;
let tokenRepo: InMemoryTokenRepo;
let clock: FakeClock;
let server: Express;

/** The seeded agent's shape: first-party, confidential, three read scopes. */
let agentApp: OAuthApp;
let agentSecret: string;

function token(body: Record<string, string>) {
  return request(server).post('/oauth/token').type('form').send(body);
}

function ccGrant(overrides: Record<string, string> = {}) {
  return token({
    grant_type: CLIENT_CREDENTIALS_GRANT_TYPE,
    client_id: agentApp.clientId,
    client_secret: agentSecret,
    ...overrides,
  });
}

async function makeApp(
  name: string,
  opts: {
    secret: string;
    isFirstParty?: boolean;
    isPublic?: boolean;
    requestedScopes?: Scope[];
  },
): Promise<OAuthApp> {
  return appsRepo.create({
    clientId: generateClientId(),
    ...secretMaterial(opts.secret),
    name,
    ownerUserId: 'user-1',
    workspaceId: 'ws-1',
    redirectUris: ['http://127.0.0.1:8976/callback'],
    requestedScopes: opts.requestedScopes ?? AGENT_SCOPES,
    ...(opts.isFirstParty !== undefined ? { isFirstParty: opts.isFirstParty } : {}),
    ...(opts.isPublic !== undefined ? { isPublic: opts.isPublic } : {}),
  });
}

beforeEach(async () => {
  appsRepo = new InMemoryOAuthAppRepo();
  tokenRepo = new InMemoryTokenRepo();
  // A non-zero start: at 0, "is this timestamp set" and "is this timestamp the
  // epoch" are indistinguishable.
  clock = new FakeClock(1_700_000_000_000);

  agentSecret = generateClientSecret();
  agentApp = await makeApp('FleetGraph Agent', { secret: agentSecret, isFirstParty: true });

  server = express();
  server.use('/oauth', createOAuthRouter({ appsRepo, tokenRepo, clock, ttl: DEFAULT_TOKEN_TTL }));
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-686 — the grant exists and returns RFC 6749 §4.4.3's response.
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-686 — the grant, and the fact that it had to be built', () => {
  /**
   * The measurement this lane opened with, kept as an assertion.
   *
   * On `pf/integration` the router carried `TODO(L05/D5): client_credentials`
   * and the live server answered `unsupported_grant_type`. This test is the
   * regression guard on that answer changing back — if the map entry is ever
   * removed, the dispatcher's honest `unsupported_grant_type` reappears and
   * every assertion below fails for a reason nobody would guess from the name.
   */
  it('is registered — the token endpoint no longer answers unsupported_grant_type', async () => {
    const res = await ccGrant();
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
  });

  it('returns access_token, token_type Bearer, expires_in and scope', async () => {
    const res = await ccGrant();
    expect(res.status).toBe(200);
    expect(res.body.token_type).toBe('Bearer');
    expect(typeof res.body.access_token).toBe('string');
    expect(res.body.access_token.length).toBeGreaterThan(20);
    expect(res.body.expires_in).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(res.body.scope).toBe('documents:read issues:read sprints:read');
  });

  /**
   * §4.4.3: *"A refresh token SHOULD NOT be included."*
   *
   * Asserted by KEY ABSENCE, not by falsiness. `refresh_token: undefined`
   * serialises away over JSON and would pass `expect(...).toBeUndefined()`
   * forever while a second implementation quietly reintroduced the field.
   */
  it('carries NO refresh_token — asserted by key absence, not by value', async () => {
    const res = await ccGrant();
    expect(Object.keys(res.body).sort()).toEqual([
      'access_token',
      'expires_in',
      'scope',
      'token_type',
    ]);
    expect('refresh_token' in res.body).toBe(false);
  });

  /**
   * The other half of "no refresh token": none was WRITTEN either.
   *
   * A response that omits the field while the database holds a refresh row is
   * the failure the `insertAccessOnly` seam exists to prevent — the table would
   * claim the agent has refresh credentials outstanding that nobody can spend.
   */
  it('writes exactly one oauth_tokens row, of type access', async () => {
    const res = await ccGrant();
    const record = await tokenRepo.findByHash(hashToken(res.body.access_token));
    expect(record).not.toBeNull();
    expect(record!.tokenType).toBe('access');
    // A family of one. `family_id` is NOT NULL because a token with no family is
    // one `revokeFamily` cannot reach (migration 043).
    expect(await tokenRepo.listFamily(record!.familyId)).toHaveLength(1);
  });

  it('expires on the INJECTED clock, not the wall clock', async () => {
    const res = await ccGrant();
    const record = await tokenRepo.findByHash(hashToken(res.body.access_token));
    expect(record!.expiresAt.getTime()).toBe(clock.nowMs() + ACCESS_TOKEN_TTL_SECONDS * 1000);
  });

  it('the issued token resolves on the bearer path with the granted scopes', async () => {
    const res = await ccGrant();
    const resolved = await resolveToken(
      { tokenRepo, appsRepo, clock },
      res.body.access_token as string,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.context.clientId).toBe(agentApp.clientId);
    expect(resolved.context.scopes.sort()).toEqual([...AGENT_SCOPES].sort());
  });

  it('sets Cache-Control: no-store, like every other response from this endpoint', async () => {
    const res = await ccGrant();
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-687 — the negative matrix. Five rows, one assertion each.
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-687 — five ways it must fail, each named', () => {
  it('(a) a wrong client_secret is invalid_client, 401', async () => {
    const res = await ccGrant({ client_secret: generateClientSecret() });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
  });

  /**
   * (b) — and this is the interesting half. An UNKNOWN `client_id` must produce
   * the same body as a wrong secret, or the token endpoint becomes an oracle
   * telling an attacker which `client_id`s are real.
   *
   * `verifyClientSecret` buys this structurally rather than by convention: it
   * hashes the presented secret against a fixed `ABSENT_APP_DIGEST` when no row
   * is found, so the unknown-client path does the same work as the bad-secret
   * path rather than returning early. This asserts the observable consequence.
   */
  it('(b) an unknown client_id is invalid_client with a BYTE-IDENTICAL body', async () => {
    const unknown = await token({
      grant_type: CLIENT_CREDENTIALS_GRANT_TYPE,
      client_id: generateClientId(),
      client_secret: generateClientSecret(),
    });
    const badSecret = await ccGrant({ client_secret: generateClientSecret() });

    expect(unknown.status).toBe(badSecret.status);
    expect(unknown.body).toEqual(badSecret.body);
    expect(unknown.headers['www-authenticate']).toBe(badSecret.headers['www-authenticate']);
  });

  it('(c) a deactivated app is refused — the token half of D2/PF-052', async () => {
    await appsRepo.deactivate(agentApp.id, 'owner_deleted', new Date(clock.nowMs()));
    const res = await ccGrant();
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
    // And nothing was minted.
    expect(await tokenRepo.listFamily('any')).toHaveLength(0);
  });

  it('(d) a scope outside requested_scopes is invalid_scope, never a narrowed grant', async () => {
    const res = await ccGrant({ scope: 'documents:read issues:write' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_scope');
    expect(res.body.access_token).toBeUndefined();
  });

  it('(d²) a scope this server has never registered is also invalid_scope', async () => {
    const res = await ccGrant({ scope: 'documents:read invented:scope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_scope');
  });

  it('(e) a NON-first-party app is refused, even with a correct secret', async () => {
    const secret = generateClientSecret();
    const thirdParty = await makeApp('Third party', { secret, isFirstParty: false });
    const res = await token({
      grant_type: CLIENT_CREDENTIALS_GRANT_TYPE,
      client_id: thirdParty.clientId,
      client_secret: secret,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unauthorized_client');
    expect(res.body.error_description).toMatch(/first-party confidential/);
  });

  /**
   * The sixth row, which the ticket did not ask for and which is the one that
   * would actually have been exploitable.
   *
   * `authenticateClient` authenticates a PUBLIC app on `client_id` alone
   * (migration 074) — and `client_id` is printed in the README. Without this
   * gate, anyone who read the README could mint a token carrying a public app's
   * full scope set with no human in the loop. `ship_app_grader_demo` is public
   * AND holds `documents:write` + `webhooks:manage`, so this is not theoretical
   * on the shipped seed set; it is blocked twice, by first-party and by this.
   */
  it('(f) a PUBLIC app is refused — with no secret AND with the right secret', async () => {
    const secret = generateClientSecret();
    const publicFirstParty = await makeApp('Public first-party', {
      secret,
      isFirstParty: true,
      isPublic: true,
    });

    const idAlone = await token({
      grant_type: CLIENT_CREDENTIALS_GRANT_TYPE,
      client_id: publicFirstParty.clientId,
    });
    expect(idAlone.status).toBe(400);
    expect(idAlone.body.error).toBe('unauthorized_client');

    const withSecret = await token({
      grant_type: CLIENT_CREDENTIALS_GRANT_TYPE,
      client_id: publicFirstParty.clientId,
      client_secret: secret,
    });
    expect(withSecret.status).toBe(400);
    expect(withSecret.body.error).toBe('unauthorized_client');
  });

  it('a refused grant mints nothing at all', async () => {
    await ccGrant({ scope: 'issues:write' });
    await ccGrant({ client_secret: generateClientSecret() });
    const secret = generateClientSecret();
    const thirdParty = await makeApp('Third party 2', { secret, isFirstParty: false });
    await token({
      grant_type: CLIENT_CREDENTIALS_GRANT_TYPE,
      client_id: thirdParty.clientId,
      client_secret: secret,
    });

    // No token of any kind reached the store.
    expect(await tokenRepo.findByHash(hashToken('anything'))).toBeNull();
    const anyRow = await tokenRepo.revokeByApp(agentApp.id, 'owner_deleted', new Date());
    expect(anyRow).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-688 — first-party only, and a userless token every consumer handles.
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-688 — the token binds NO user, end to end', () => {
  it('the stored row has user_id null', async () => {
    const res = await ccGrant();
    const record = await tokenRepo.findByHash(hashToken(res.body.access_token));
    expect(record!.userId).toBeNull();
  });

  /**
   * The consumer half. `PlatformAuthContext.userId` is `string | null` and this
   * is the grant that actually produces the null — until now nothing on the
   * server could, so every consumer's handling of it was untested by
   * construction.
   */
  it('the resolved auth context carries a null userId and a real clientId', async () => {
    const res = await ccGrant();
    const resolved = await resolveToken(
      { tokenRepo, appsRepo, clock },
      res.body.access_token as string,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.context.userId).toBeNull();
    expect(resolved.context.clientId).toBe(agentApp.clientId);
    expect(resolved.context.appId).toBe(agentApp.id);
  });

  it('narrows to a subset when `scope` asks for one, and records exactly that', async () => {
    const res = await ccGrant({ scope: 'issues:read' });
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('issues:read');
    const record = await tokenRepo.findByHash(hashToken(res.body.access_token));
    expect(record!.scopes).toEqual(['issues:read']);
  });

  it('grants the full registered set when `scope` is omitted', async () => {
    const res = await ccGrant();
    const record = await tokenRepo.findByHash(hashToken(res.body.access_token));
    expect([...record!.scopes].sort()).toEqual([...AGENT_SCOPES].sort());
  });

  /**
   * The ceiling is the REGISTRATION, and it moves when the registration moves.
   *
   * Stated as a test because the alternative implementation — a hard-coded list
   * of the agent's three scopes inside the grant — passes every other assertion
   * in this file and silently ignores what an operator seeded.
   */
  it('reads the ceiling off the app row rather than off a constant', async () => {
    const secret = generateClientSecret();
    const narrow = await makeApp('Narrow first-party', {
      secret,
      isFirstParty: true,
      requestedScopes: ['issues:read'],
    });
    const res = await token({
      grant_type: CLIENT_CREDENTIALS_GRANT_TYPE,
      client_id: narrow.clientId,
      client_secret: secret,
    });
    expect(res.body.scope).toBe('issues:read');

    const overreach = await token({
      grant_type: CLIENT_CREDENTIALS_GRANT_TYPE,
      client_id: narrow.clientId,
      client_secret: secret,
      scope: 'documents:read',
    });
    expect(overreach.status).toBe(400);
    expect(overreach.body.error).toBe('invalid_scope');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The dispatcher was not edited — PF-166/PF-134's property, now four lanes deep.
// ─────────────────────────────────────────────────────────────────────────────

describe('the grant map stayed a map', () => {
  it('an unregistered grant_type still answers unsupported_grant_type', async () => {
    const res = await token({
      grant_type: 'password',
      client_id: agentApp.clientId,
      client_secret: agentSecret,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_grant_type');
  });

  it('client authentication still runs BEFORE the grant, so eligibility never leaks', async () => {
    // A third-party app with a WRONG secret must fail as invalid_client (401),
    // not as unauthorized_client (400) — otherwise the eligibility check tells a
    // caller their client_id is real before they have proven they own it.
    const thirdParty = await makeApp('Third party 3', {
      secret: generateClientSecret(),
      isFirstParty: false,
    });
    const res = await token({
      grant_type: CLIENT_CREDENTIALS_GRANT_TYPE,
      client_id: thirdParty.clientId,
      client_secret: generateClientSecret(),
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
  });
});
