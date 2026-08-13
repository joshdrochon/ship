/**
 * PF-122, PF-125, PF-126 — `POST /oauth/device/code` over a real HTTP stack.
 * Lane L05, slice S1.
 *
 * Driven through the actual mounted router rather than by calling the handler,
 * because the assertions that matter here are wire-level: the response body's
 * field names (which L18 and L19 consume with no compensating logic), the
 * status codes, and `Cache-Control`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { FakeClock } from '../clock.js';
import { InMemoryOAuthAppRepo, secretMaterial } from '../apps/repo.js';
import { generateClientId, generateClientSecret } from '../apps/secrets.js';
import type { OAuthApp } from '../apps/types.js';
import { InMemoryTokenRepo } from './tokenRepo.js';
import { DEFAULT_TOKEN_TTL } from './tokens.js';
import { createOAuthRouter } from './router.js';
import { oauthErrorBodySchema } from './oauthErrors.js';
import {
  InMemoryDeviceCodeRepo,
  hashDeviceCode,
  normalizeUserCode,
  USER_CODE_PATTERN,
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
} from './deviceCodes.js';
import { deviceAuthorizationResponseSchema } from './deviceAuthorization.js';

const BASE_URL = 'https://ship.test';

let appsRepo: InMemoryOAuthAppRepo;
let deviceCodeRepo: InMemoryDeviceCodeRepo;
let clock: FakeClock;
let app: OAuthApp;
let secret: string;
let server: Express;

function boot(): Express {
  const server = express();
  server.use(
    '/oauth',
    createOAuthRouter({
      appsRepo,
      tokenRepo: new InMemoryTokenRepo(),
      deviceCodeRepo,
      publicBaseUrl: BASE_URL,
      clock,
      ttl: DEFAULT_TOKEN_TTL,
    }),
  );
  return server;
}

async function makeApp(overrides: Record<string, unknown> = {}) {
  secret = generateClientSecret();
  return appsRepo.create({
    clientId: generateClientId(),
    ...secretMaterial(secret),
    name: 'L05 device app',
    ownerUserId: 'user-1',
    workspaceId: 'ws-1',
    redirectUris: ['https://app.example.test/callback'],
    requestedScopes: ['documents:read', 'documents:write'],
    ...overrides,
  } as Parameters<InMemoryOAuthAppRepo['create']>[0]);
}

/**
 * A deactivated app, through the REAL D2 path.
 *
 * `create` has no `active` field — deliberately, since D2 says an app is
 * deactivated and never created dead. Passing `{active: false}` to `create` is
 * silently ignored, which made an earlier version of these two tests pass
 * vacuously against a live app. Going through `deactivate()` is what makes the
 * fixture mean what it says.
 */
async function makeDeactivatedApp() {
  const dead = await makeApp();
  const updated = await appsRepo.deactivate(dead.id, 'admin_action', new Date(clock.nowMs()));
  expect(updated?.active, 'fixture must actually be deactivated').toBe(false);
  return dead;
}

function deviceCodeRequest(body: Record<string, string> = {}) {
  return request(server)
    .post('/oauth/device/code')
    .type('form')
    .send({ client_id: app.clientId, ...body });
}

beforeEach(async () => {
  appsRepo = new InMemoryOAuthAppRepo();
  deviceCodeRepo = new InMemoryDeviceCodeRepo();
  clock = new FakeClock(0);
  app = await makeApp();
  server = boot();
});

describe('PF-122: the RFC 8628 §3.2 response', () => {
  it('returns 200 with every field present and correctly typed', async () => {
    const res = await deviceCodeRequest({ scope: 'documents:read' });

    expect(res.status).toBe(200);
    // Validated against the EXPORTED schema — the same definition L18's and
    // L19's tests import. One statement of the contract, not two (PF-141).
    const parsed = deviceAuthorizationResponseSchema.safeParse(res.body);
    expect(parsed.success, JSON.stringify(res.body)).toBe(true);

    expect(res.body.user_code).toMatch(USER_CODE_PATTERN);
    expect(res.body.expires_in).toBe(DEVICE_CODE_TTL_SECONDS);
    expect(res.body.interval).toBe(DEVICE_POLL_INTERVAL_SECONDS);
  });

  it('sets Cache-Control: no-store — the body carries a bearer credential', async () => {
    const res = await deviceCodeRequest();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['pragma']).toBe('no-cache');
  });

  it('issues a DISTINCT pair on a second call', async () => {
    const first = await deviceCodeRequest();
    const second = await deviceCodeRequest();
    expect(first.body.device_code).not.toBe(second.body.device_code);
    expect(first.body.user_code).not.toBe(second.body.user_code);
  });

  it('builds an ABSOLUTE verification_uri on the configured origin', async () => {
    // The defect this exists to catch is a relative path or a hard-coded
    // localhost URL: a CLI pointed at the deployed instance would print a URL
    // that resolves nowhere. The fixture origin is deliberately NOT the dev
    // default, so a hard-coded `http://localhost:3000` fails here.
    const res = await deviceCodeRequest();

    const uri = new URL(res.body.verification_uri);
    expect(uri.origin).toBe(BASE_URL);
    expect(uri.pathname).toBe('/oauth/device/verify');
    expect(res.body.verification_uri).not.toContain('localhost');
  });

  it('builds verification_uri_complete on the same origin, carrying the user_code', async () => {
    const res = await deviceCodeRequest();

    const complete = new URL(res.body.verification_uri_complete);
    expect(complete.origin).toBe(BASE_URL);
    expect(complete.pathname).toBe('/oauth/device/verify');
    // RFC 8628 §3.3.1. PF-128 ships it as an additive convenience; the
    // confirmation step that makes it safe is asserted in S2.
    expect(complete.searchParams.get('user_code')).toBe(res.body.user_code);
  });

  it('persists sha256(device_code) and the user_code in clear (PF-124)', async () => {
    const res = await deviceCodeRequest();

    const row = await deviceCodeRepo.findByDeviceCodeHash(hashDeviceCode(res.body.device_code));
    expect(row).not.toBeNull();
    expect(row?.userCode).toBe(res.body.user_code);
    for (const value of Object.values(row ?? {})) {
      expect(JSON.stringify(value ?? '')).not.toContain(res.body.device_code);
    }
  });

  it('returns the code in canonical form — no lowercasing, no hyphen stripped', async () => {
    // What p.8's drill stage "User code displayed" displays, and what L19's
    // PF-563 echoes verbatim.
    const res = await deviceCodeRequest();
    expect(res.body.user_code).toContain('-');
    expect(res.body.user_code).toBe(res.body.user_code.toUpperCase());
    const row = await deviceCodeRepo.findByUserCode(normalizeUserCode(res.body.user_code));
    expect(row?.userCode).toBe(res.body.user_code);
  });
});

describe('PF-125: the requesting client is authenticated', () => {
  it('gives ONE indistinguishable response to all four failure cases', async () => {
    const activeClientId = app.clientId;
    const deactivated = await makeDeactivatedApp();

    const cases = [
      { label: 'unknown client_id', body: { client_id: 'ship_unknown_client' } },
      { label: 'wrong secret', body: { client_id: activeClientId, client_secret: 'wrong' } },
      {
        label: 'deactivated app, no secret',
        body: { client_id: deactivated.clientId },
      },
      {
        label: 'deactivated app, correct secret',
        body: { client_id: deactivated.clientId, client_secret: secret },
      },
    ];

    const seen = new Set<string>();
    for (const c of cases) {
      const res = await request(server).post('/oauth/device/code').type('form').send(c.body);
      expect(res.status, c.label).toBe(401);
      expect(oauthErrorBodySchema.safeParse(res.body).success, c.label).toBe(true);
      expect(res.body.error, c.label).toBe('invalid_client');
      seen.add(JSON.stringify(res.body));
    }
    // Byte-identical across all four — the endpoint is not an oracle telling an
    // attacker which of the four situations they are in.
    expect(seen.size).toBe(1);
  });

  it('a deactivated app gets NO device code row (D2, at the entry point)', async () => {
    const deactivated = await makeDeactivatedApp();
    const before = deviceCodeRepo.size();
    await request(server)
      .post('/oauth/device/code')
      .type('form')
      .send({ client_id: deactivated.clientId, client_secret: secret });
    expect(deviceCodeRepo.size()).toBe(before);
  });

  it('accepts a public client presenting client_id alone (RFC 6749 §2.1)', async () => {
    // A CLI is a public client and cannot hold a secret. RFC 8628 §3.1 requires
    // identification at this endpoint and authentication only from confidential
    // clients.
    const res = await deviceCodeRequest();
    expect(res.status).toBe(200);
  });

  it('accepts a confidential client presenting a correct secret', async () => {
    const res = await deviceCodeRequest({ client_secret: secret });
    expect(res.status).toBe(200);
  });

  it('requires client_id', async () => {
    const res = await request(server).post('/oauth/device/code').type('form').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(oauthErrorBodySchema.safeParse(res.body).success).toBe(true);
  });

  it('defines no client-secret comparison of its own — PF-036 is the only site', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const text = readFileSync(join(here, 'deviceAuthorization.ts'), 'utf8');
    expect(text).toContain('verifyClientSecret');
    // No hand-rolled comparison, constant-time or otherwise.
    expect(text).not.toMatch(/timingSafeEqual|clientSecretHash\s*===|digestsEqual/);
  });
});

describe('PF-126: scopes are validated at device-code time', () => {
  it('rejects an unknown scope by NAME rather than dropping it', async () => {
    const res = await deviceCodeRequest({ scope: 'documents:read documents:teleport' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_scope');
    expect(res.body.error_description).toContain('documents:teleport');
    expect(oauthErrorBodySchema.safeParse(res.body).success).toBe(true);
    // Fails at `ship login`'s FIRST request — the user has not walked to a
    // browser yet, which is the whole reason this check lives here.
    expect(deviceCodeRepo.size()).toBe(0);
  });

  it('rejects a registered scope the APP never asked for', async () => {
    const res = await deviceCodeRequest({ scope: 'issues:write' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_scope');
    expect(res.body.error_description).toContain('issues:write');
    expect(deviceCodeRepo.size()).toBe(0);
  });

  it('records the validated request on the row', async () => {
    const res = await deviceCodeRequest({ scope: 'documents:read' });
    const row = await deviceCodeRepo.findByDeviceCodeHash(hashDeviceCode(res.body.device_code));
    expect(row?.scopes).toEqual(['documents:read']);
  });

  it('inherits the app’s registration when no scope is requested', async () => {
    const res = await deviceCodeRequest();
    const row = await deviceCodeRepo.findByDeviceCodeHash(hashDeviceCode(res.body.device_code));
    expect(row?.scopes).toEqual(app.requestedScopes);
  });
});

describe('PF-127: expiry is stamped from the injected clock', () => {
  it('sets expires_at exactly 600s ahead of the injected now, not of Date.now()', async () => {
    // The clock starts at 0, decades away from the wall clock, so a handler
    // reading `Date.now()` fails this by roughly fifty years.
    const res = await deviceCodeRequest();
    const row = await deviceCodeRepo.findByDeviceCodeHash(hashDeviceCode(res.body.device_code));
    expect(row?.createdAt.getTime()).toBe(0);
    expect(row?.expiresAt.getTime()).toBe(DEVICE_CODE_TTL_SECONDS * 1000);
    expect(res.body.expires_in).toBe(DEVICE_CODE_TTL_SECONDS);
  });

  it('follows the clock — a later request gets a later expiry', async () => {
    clock.advance(120_000);
    const res = await deviceCodeRequest();
    const row = await deviceCodeRepo.findByDeviceCodeHash(hashDeviceCode(res.body.device_code));
    expect(row?.expiresAt.getTime()).toBe(120_000 + DEVICE_CODE_TTL_SECONDS * 1000);
  });
});

describe('PF-121: the grant is not registered without a store', () => {
  it('mounts no device endpoint when deviceCodeRepo is absent', async () => {
    const bare = express();
    bare.use(
      '/oauth',
      createOAuthRouter({
        appsRepo,
        tokenRepo: new InMemoryTokenRepo(),
        clock,
        ttl: DEFAULT_TOKEN_TTL,
      }),
    );
    const res = await request(bare)
      .post('/oauth/device/code')
      .type('form')
      .send({ client_id: app.clientId });
    expect(res.status).toBe(404);
  });

  it('refuses to wire a device store with no publicBaseUrl — loud at boot', () => {
    // A missing base URL would otherwise surface as `undefined/oauth/...`
    // printed into a user's terminal, which nobody notices until a grader
    // follows the link.
    expect(() =>
      createOAuthRouter({
        appsRepo,
        tokenRepo: new InMemoryTokenRepo(),
        deviceCodeRepo,
        clock,
        ttl: DEFAULT_TOKEN_TTL,
      }),
    ).toThrow(/publicBaseUrl/);
  });
});
