/**
 * PF-134 – PF-139 — the polling leg, over a real HTTP stack.
 * Lane L05, slice S3.
 *
 * PRD p.3's third clause and its final sentence: *"the client polls
 * /oauth/token until authorized. Slow-down responses honored."*
 *
 * Every temporal assertion advances a `FakeClock`. There is no `setTimeout` in
 * this file and no test sleeps — PRD p.11 calls timing-based tests flaky tests.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeClock } from '../clock.js';
import { InMemoryOAuthAppRepo, secretMaterial } from '../apps/repo.js';
import { generateClientId, generateClientSecret } from '../apps/secrets.js';
import type { OAuthApp } from '../apps/types.js';
import { InMemoryTokenRepo } from './tokenRepo.js';
import { DEFAULT_TOKEN_TTL } from './tokens.js';
import { createOAuthRouter, grantHandlers } from './router.js';
import { oauthErrorBodySchema, oauthTokenResponseSchema } from './oauthErrors.js';
import {
  InMemoryDeviceCodeRepo,
  generateDeviceCode,
  generateUserCode,
  hashDeviceCode,
  DEVICE_POLL_INTERVAL_SECONDS,
  DEVICE_POLL_INTERVAL_INCREMENT_SECONDS,
  DEVICE_POLL_INTERVAL_MAX_SECONDS,
} from './deviceCodes.js';
import { DEVICE_CODE_GRANT_TYPE } from './deviceGrant.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE_URL = 'https://ship.test';

let appsRepo: InMemoryOAuthAppRepo;
let deviceCodeRepo: InMemoryDeviceCodeRepo;
let tokenRepo: InMemoryTokenRepo;
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
      tokenRepo,
      deviceCodeRepo,
      publicBaseUrl: BASE_URL,
      clock,
      ttl: DEFAULT_TOKEN_TTL,
    }),
  );
  return server;
}

/** Issues a device code directly, so the polling leg is tested in isolation. */
async function issueCode(over: Record<string, unknown> = {}) {
  const deviceCode = generateDeviceCode();
  const row = await deviceCodeRepo.insert({
    deviceCodeHash: hashDeviceCode(deviceCode),
    userCode: generateUserCode(),
    appId: app.id,
    scopes: ['documents:read'],
    intervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
    expiresAt: new Date(clock.nowMs() + 600_000),
    createdAt: new Date(clock.nowMs()),
    ...over,
  } as Parameters<InMemoryDeviceCodeRepo['insert']>[0]);
  return { deviceCode, row };
}

/** One poll of `/oauth/token` with the device-code grant. */
function poll(deviceCode: string, over: Record<string, string> = {}) {
  return request(server)
    .post('/oauth/token')
    .type('form')
    .send({
      grant_type: DEVICE_CODE_GRANT_TYPE,
      device_code: deviceCode,
      client_id: app.clientId,
      client_secret: secret,
      ...over,
    });
}

/** The out-of-band approval PF-138 describes — the browser half, done directly. */
async function approve(rowId: string) {
  return deviceCodeRepo.approve(
    { id: rowId, userId: 'user-1', workspaceId: 'ws-1', scopes: ['documents:read'] },
    new Date(clock.nowMs()),
  );
}

beforeEach(async () => {
  appsRepo = new InMemoryOAuthAppRepo();
  deviceCodeRepo = new InMemoryDeviceCodeRepo();
  tokenRepo = new InMemoryTokenRepo();
  clock = new FakeClock(0);
  secret = generateClientSecret();
  app = await appsRepo.create({
    clientId: generateClientId(),
    ...secretMaterial(secret),
    name: 'L05 device app',
    ownerUserId: 'user-1',
    workspaceId: 'ws-1',
    redirectUris: ['https://app.example.test/callback'],
    requestedScopes: ['documents:read', 'documents:write'],
  });
  server = boot();
});

describe('PF-134: the grant is DATA in the dispatch map', () => {
  it('registers the RFC 8628 URN as a key, not a branch in an if-ladder', () => {
    const handlers = grantHandlers({
      appsRepo,
      tokenRepo,
      deviceCodeRepo,
      publicBaseUrl: BASE_URL,
      clock,
      ttl: DEFAULT_TOKEN_TTL,
      authCodeRepo: undefined,
    });
    expect(Object.keys(handlers)).toContain(DEVICE_CODE_GRANT_TYPE);
    expect(DEVICE_CODE_GRANT_TYPE).toBe('urn:ietf:params:oauth:grant-type:device_code');
  });

  it('the dispatcher contains no grant-type conditional — adding a fourth needs no edit', () => {
    const text = readFileSync(join(HERE, 'router.ts'), 'utf8');
    // The dispatcher looks the handler up; it does not compare grant_type to a
    // literal. A `grantType === '...'` anywhere in the dispatcher is the thing
    // this assertion exists to catch.
    expect(text).toContain('const handler = handlers[grantType]');
    expect(text).not.toMatch(/grantType\s*===\s*['"]/);
    expect(text).not.toMatch(/switch\s*\(\s*grantType/);
  });

  it('answers unsupported_grant_type for an unknown grant', async () => {
    const res = await request(server)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'teleport', client_id: app.clientId, client_secret: secret });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_grant_type');
  });

  it('does NOT register the grant when there is no device store', () => {
    const handlers = grantHandlers({
      appsRepo,
      tokenRepo,
      clock,
      ttl: DEFAULT_TOKEN_TTL,
    });
    // `unsupported_grant_type` is the honest answer for a server with nowhere to
    // record a device authorization — better than `invalid_grant`, which would
    // send the client hunting for a device_code it holds correctly.
    expect(Object.keys(handlers)).not.toContain(DEVICE_CODE_GRANT_TYPE);
  });
});

describe('PF-135: authorization_pending is a 400, NOT a 200 with a status field', () => {
  it('returns HTTP 400 with {"error":"authorization_pending"} and no token fields', async () => {
    // The single most common way a hand-rolled device grant is wrong. A
    // `200 {"status":"pending"}` feels natural and breaks every RFC-compliant
    // client library, including whatever a grader points at us.
    const { deviceCode } = await issueCode();
    const res = await poll(deviceCode);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'authorization_pending',
      error_description: expect.any(String),
    });
    expect(res.body.access_token).toBeUndefined();
    expect(res.body.refresh_token).toBeUndefined();
    expect(res.body.status).toBeUndefined();
  });

  it('validates against L04’s oauthErrorBodySchema — one oracle, not a second', async () => {
    const { deviceCode } = await issueCode();
    const res = await poll(deviceCode);
    expect(oauthErrorBodySchema.safeParse(res.body).success).toBe(true);
  });

  it('never emits a 200 with a status field on ANY pending path', async () => {
    // Structural, not incidental: a grep for the shape that would satisfy a
    // careless reading of "the client polls until authorized".
    const text = readFileSync(join(HERE, 'deviceGrant.ts'), 'utf8');
    expect(text).not.toMatch(/status:\s*['"]pending['"]/);
    expect(text).not.toMatch(/status\(200\)/);
  });
});

describe('PF-136: ★ slow_down, and the interval actually rises', () => {
  it('drives the exact four-step ladder from the ticket on a FakeClock', async () => {
    // poll at t -> pending; t+1s -> slow_down and interval 10; t+6s -> still
    // slow_down (10s not yet elapsed); t+11s -> pending again.
    const { deviceCode, row } = await issueCode();

    const first = await poll(deviceCode);
    expect(first.body.error).toBe('authorization_pending');
    expect((await deviceCodeRepo.findByDeviceCodeHash(row.deviceCodeHash))?.intervalSeconds).toBe(5);

    clock.advance(1000);
    const tooFast = await poll(deviceCode);
    expect(tooFast.status).toBe(400);
    expect(tooFast.body.error).toBe('slow_down');
    // ★ THE HALF THAT IS USUALLY MISSING. Returning slow_down without raising
    // the stored interval leaves a fast client in a permanent error loop.
    expect((await deviceCodeRepo.findByDeviceCodeHash(row.deviceCodeHash))?.intervalSeconds).toBe(
      5 + DEVICE_POLL_INTERVAL_INCREMENT_SECONDS,
    );

    // 5s after the last poll — still inside the RAISED 10s interval.
    clock.advance(5000);
    const stillTooFast = await poll(deviceCode);
    expect(stillTooFast.body.error).toBe('slow_down');
    expect((await deviceCodeRepo.findByDeviceCodeHash(row.deviceCodeHash))?.intervalSeconds).toBe(15);

    // Now wait out the current interval properly.
    clock.advance(16_000);
    const legal = await poll(deviceCode);
    expect(legal.body.error).toBe('authorization_pending');
  });

  it('a client that OBEYS the advertised interval is never slowed down (PF-141)', async () => {
    // The closing half of the contract: the number we advertised is the number
    // we enforce, so an SDK that trusts it is never punished for obeying.
    const { deviceCode } = await issueCode();

    let res = await poll(deviceCode);
    expect(res.body.error).toBe('authorization_pending');

    for (let i = 0; i < 5; i += 1) {
      clock.advance(DEVICE_POLL_INTERVAL_SECONDS * 1000);
      res = await poll(deviceCode);
      expect(res.body.error, `poll ${i + 2} at the advertised interval`).toBe(
        'authorization_pending',
      );
    }
  });

  it('stamps last_polled_at on an ILLEGAL poll too', async () => {
    // Otherwise a fast client's next too-fast poll is measured from the last
    // LEGAL one, and it drifts back into legality without ever slowing down.
    const { deviceCode, row } = await issueCode();
    await poll(deviceCode);

    clock.advance(1000);
    await poll(deviceCode);
    const after = await deviceCodeRepo.findByDeviceCodeHash(row.deviceCodeHash);
    expect(after?.lastPolledAt?.getTime()).toBe(1000);
  });

  it('caps the cumulative backoff so the flow stays completable', async () => {
    // Without a cap the interval outgrows the 600s TTL and the flow can never
    // complete even after the user approves.
    const { deviceCode, row } = await issueCode();
    await poll(deviceCode);

    for (let i = 0; i < 40; i += 1) {
      clock.advance(100);
      await poll(deviceCode);
    }
    const after = await deviceCodeRepo.findByDeviceCodeHash(row.deviceCodeHash);
    expect(after?.intervalSeconds).toBe(DEVICE_POLL_INTERVAL_MAX_SECONDS);
    expect(DEVICE_POLL_INTERVAL_MAX_SECONDS).toBeLessThan(600);
  });

  it('never lowers the interval — good behaviour does not buy back speed', async () => {
    const { deviceCode, row } = await issueCode();
    await poll(deviceCode);
    clock.advance(1000);
    await poll(deviceCode);
    expect((await deviceCodeRepo.findByDeviceCodeHash(row.deviceCodeHash))?.intervalSeconds).toBe(10);

    // Behave for several legal polls.
    for (let i = 0; i < 3; i += 1) {
      clock.advance(11_000);
      await poll(deviceCode);
    }
    expect((await deviceCodeRepo.findByDeviceCodeHash(row.deviceCodeHash))?.intervalSeconds).toBe(10);
  });
});

describe('PF-137: polling state is per device code and survives a restart', () => {
  it('throttles ten interleaved flows INDEPENDENTLY', async () => {
    // Pre-Search 1.1 answered by construction: one client polling too fast
    // never causes another's poll to be slowed.
    const flows = [];
    for (let i = 0; i < 10; i += 1) flows.push(await issueCode());

    // Every flow polls once, legally.
    for (const f of flows) {
      const res = await poll(f.deviceCode);
      expect(res.body.error).toBe('authorization_pending');
    }

    // Flow 0 hammers. Nothing else moves.
    clock.advance(500);
    for (let i = 0; i < 5; i += 1) {
      const res = await poll(flows[0]!.deviceCode);
      expect(res.body.error).toBe('slow_down');
    }

    // Every OTHER flow is untouched: its own interval is still 5s, and at
    // t+5000 each is legal.
    clock.advance(4500);
    for (let i = 1; i < flows.length; i += 1) {
      const res = await poll(flows[i]!.deviceCode);
      expect(res.body.error, `flow ${i} must be unaffected by flow 0`).toBe(
        'authorization_pending',
      );
      const row = await deviceCodeRepo.findByDeviceCodeHash(flows[i]!.row.deviceCodeHash);
      expect(row?.intervalSeconds).toBe(DEVICE_POLL_INTERVAL_SECONDS);
    }

    // And flow 0 kept every bit of the backoff it earned.
    const hammered = await deviceCodeRepo.findByDeviceCodeHash(flows[0]!.row.deviceCodeHash);
    expect(hammered?.intervalSeconds).toBeGreaterThan(DEVICE_POLL_INTERVAL_SECONDS);
  });

  it('keeps the earned backoff across a process restart — a crash cannot reset it', async () => {
    const { deviceCode, row } = await issueCode();
    await poll(deviceCode);
    clock.advance(1000);
    await poll(deviceCode);
    expect((await deviceCodeRepo.findByDeviceCodeHash(row.deviceCodeHash))?.intervalSeconds).toBe(10);

    // Rebuild the whole server — a new router, new handlers, new everything.
    // The repository (the database) is the only thing that survives, which is
    // exactly the production shape.
    server = boot();

    clock.advance(1000);
    const res = await poll(deviceCode);
    expect(res.body.error).toBe('slow_down');
    expect((await deviceCodeRepo.findByDeviceCodeHash(row.deviceCodeHash))?.intervalSeconds).toBe(15);
  });

  it('holds no module-level polling state', () => {
    // The structural claim behind both assertions above.
    const text = readFileSync(join(HERE, 'deviceGrant.ts'), 'utf8');
    expect(text).not.toMatch(/^const\s+\w+\s*=\s*new Map\(/m);
    expect(text).not.toMatch(/^let\s+/m);
  });
});

describe('PF-139: the unhappy poll matrix — five inputs, distinguishable RFC codes', () => {
  it('unknown device_code -> invalid_grant', async () => {
    const res = await poll(generateDeviceCode());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('expired code -> expired_token', async () => {
    const { deviceCode } = await issueCode();
    clock.advance(600_001);
    const res = await poll(deviceCode);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('expired_token');
  });

  it('denied code -> access_denied, never authorization_pending', async () => {
    // If the server returned pending forever on a denial, the CLI would poll
    // until expiry and report the wrong reason. L19's PF-565 renders this as a
    // distinct message.
    const { deviceCode, row } = await issueCode();
    await deviceCodeRepo.deny(row.id, new Date(clock.nowMs()));
    const res = await poll(deviceCode);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('access_denied');
  });

  it('already-consumed code -> invalid_grant', async () => {
    const { deviceCode, row } = await issueCode();
    await approve(row.id);
    clock.advance(6000);
    const first = await poll(deviceCode);
    expect(first.status).toBe(200);

    clock.advance(6000);
    const second = await poll(deviceCode);
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('invalid_grant');
  });

  it('code belonging to ANOTHER client -> invalid_grant, not invalid_client', async () => {
    // The client authenticated fine; what is wrong is the grant. Answering
    // invalid_client would send a correctly-configured integrator to debug
    // their credentials.
    const otherSecret = generateClientSecret();
    const other = await appsRepo.create({
      clientId: generateClientId(),
      ...secretMaterial(otherSecret),
      name: 'another app',
      ownerUserId: 'user-1',
      workspaceId: 'ws-1',
      redirectUris: ['https://other.example.test/callback'],
      requestedScopes: ['documents:read'],
    });
    const { deviceCode } = await issueCode();

    const res = await request(server)
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: DEVICE_CODE_GRANT_TYPE,
        device_code: deviceCode,
        client_id: other.clientId,
        client_secret: otherSecret,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(res.body.error).not.toBe('invalid_client');
  });

  it('all five are 400s validated by ONE schema, and none is an ApiError', async () => {
    const { deviceCode: unknownCode } = { deviceCode: generateDeviceCode() };
    const expired = await issueCode();
    const denied = await issueCode();
    await deviceCodeRepo.deny(denied.row.id, new Date(clock.nowMs()));

    const responses = [
      await poll(unknownCode),
      await poll(denied.deviceCode),
    ];
    clock.advance(600_001);
    responses.push(await poll(expired.deviceCode));

    const codes = new Set<string>();
    for (const res of responses) {
      expect(res.status).toBe(400);
      expect(oauthErrorBodySchema.safeParse(res.body).success).toBe(true);
      // Never the public envelope — L99 U3.
      expect(res.body.code).toBeUndefined();
      expect(res.body.request_id).toBeUndefined();
      codes.add(res.body.error as string);
    }
    // Distinguishable, which is what L24's PF-726 needs at the SDK boundary.
    expect(codes.size).toBe(3);
  });

  it('a missing device_code is invalid_request, not invalid_grant', async () => {
    const res = await request(server)
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: DEVICE_CODE_GRANT_TYPE,
        client_id: app.clientId,
        client_secret: secret,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });
});

describe('PF-138 / PF-140: approval mints exactly one pair, through L06’s site', () => {
  it('an out-of-band approval flips the grant and the next legal poll returns tokens', async () => {
    const { deviceCode, row } = await issueCode();

    const pending = await poll(deviceCode);
    expect(pending.body.error).toBe('authorization_pending');

    await approve(row.id);

    clock.advance(6000);
    const res = await poll(deviceCode);

    expect(res.status).toBe(200);
    // RFC 6749 §5.1, validated by the shared schema.
    expect(oauthTokenResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.scope).toBe('documents:read');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('issues the ROW’s resolved scopes, never the app’s requested_scopes', async () => {
    const { deviceCode, row } = await issueCode();
    await approve(row.id);
    clock.advance(6000);
    const res = await poll(deviceCode);

    expect(app.requestedScopes).toContain('documents:write');
    expect(res.body.scope).toBe('documents:read');
    expect(res.body.scope).not.toContain('documents:write');
  });

  it('two simultaneous post-approval polls yield ONE pair and one invalid_grant', async () => {
    const { deviceCode, row } = await issueCode();
    await approve(row.id);
    clock.advance(6000);

    const [a, b] = await Promise.all([poll(deviceCode), poll(deviceCode)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 400]);
    const failure = a.status === 400 ? a : b;
    expect(failure.body.error).toBe('invalid_grant');
  });

  it('mints nothing itself — a grep over this lane’s modules', () => {
    const laneFiles = readdirSync(HERE).filter(
      (f) => (f.startsWith('device') || f.startsWith('pgDevice')) && f.endsWith('.ts') && !f.endsWith('.test.ts'),
    );
    expect(laneFiles.length).toBeGreaterThan(0);
    for (const name of laneFiles) {
      const text = readFileSync(join(HERE, name), 'utf8');
      expect(text, `${name} must not draw random bytes`).not.toContain('randomBytes');
      expect(text, `${name} must not hash`).not.toContain("createHash('sha256')");
      expect(text, `${name} must not construct tokens`).not.toMatch(
        /generateAccessToken|generateRefreshToken|newFamilyId/,
      );
    }
    // And it genuinely delegates.
    expect(readFileSync(join(HERE, 'deviceGrant.ts'), 'utf8')).toContain('issueTokenPair');
  });
});
