/**
 * PF-141 – PF-144 — the seams this lane hands to other lanes, and the document
 * it keeps true. Lane L05, slice S4.
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
import { createOAuthRouter } from './router.js';
import { OAUTH_ERROR_CODES, oauthErrorBodySchema } from './oauthErrors.js';
import {
  InMemoryDeviceCodeRepo,
  generateDeviceCode,
  generateUserCode,
  hashDeviceCode,
  DEVICE_POLL_INTERVAL_SECONDS,
  DEVICE_CODE_TTL_SECONDS,
  CONSUMED_DEVICE_CODE_RETENTION_SECONDS,
} from './deviceCodes.js';
import {
  deviceAuthorizationResponseSchema,
  deviceGrantErrorBodySchema,
  DEVICE_GRANT_ERROR_CODES,
  DEVICE_FLOW_CONSTANTS,
  DEVICE_FLOW_EXAMPLES,
} from './deviceContract.js';
import { sweepDeviceCodes, estimateLiveDeviceCodes, estimatePollsPerSecond } from './deviceSweeper.js';
import { DEVICE_CODE_GRANT_TYPE } from './deviceGrant.js';
import { architectureText } from '../../test/architectureDoc.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = architectureText();
const BASE_URL = 'https://ship.test';

let appsRepo: InMemoryOAuthAppRepo;
let deviceCodeRepo: InMemoryDeviceCodeRepo;
let clock: FakeClock;
let app: OAuthApp;
let secret: string;
let server: Express;

function boot(): Express {
  const s = express();
  s.use(
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
  return s;
}

beforeEach(async () => {
  appsRepo = new InMemoryOAuthAppRepo();
  deviceCodeRepo = new InMemoryDeviceCodeRepo();
  clock = new FakeClock(0);
  secret = generateClientSecret();
  app = await appsRepo.create({
    clientId: generateClientId(),
    ...secretMaterial(secret),
    name: 'L05 seam app',
    ownerUserId: 'user-1',
    workspaceId: 'ws-1',
    redirectUris: ['https://app.example.test/callback'],
    requestedScopes: ['documents:read'],
  });
  server = boot();
});

describe('PF-141: the contract L18 and L19 consume, pinned from this side', () => {
  it('the exported schema validates a REAL response from the shipped route', async () => {
    // The fixture is only worth anything if it agrees with the server. This is
    // the assertion that keeps the exported definition honest.
    const res = await request(server)
      .post('/oauth/device/code')
      .type('form')
      .send({ client_id: app.clientId, client_secret: secret });

    expect(deviceAuthorizationResponseSchema.safeParse(res.body).success).toBe(true);
  });

  it('the exported EXAMPLE also satisfies the exported schema', () => {
    // A stub-server fixture that does not match its own schema is worse than
    // none: it makes a consumer's test green against a shape the server never
    // sends.
    expect(
      deviceAuthorizationResponseSchema.safeParse(DEVICE_FLOW_EXAMPLES.authorizationResponse)
        .success,
    ).toBe(true);
  });

  it('the advertised `interval` is the number the throttle enforces', async () => {
    // PF-141's second assertion. An SDK that trusts the value we sent must
    // never be slowed for obeying it.
    const started = await request(server)
      .post('/oauth/device/code')
      .type('form')
      .send({ client_id: app.clientId, client_secret: secret });

    const advertised = started.body.interval as number;
    expect(advertised).toBe(DEVICE_FLOW_CONSTANTS.initialIntervalSeconds);

    const poll = () =>
      request(server).post('/oauth/token').type('form').send({
        grant_type: DEVICE_CODE_GRANT_TYPE,
        device_code: started.body.device_code,
        client_id: app.clientId,
        client_secret: secret,
      });

    expect((await poll()).body.error).toBe('authorization_pending');
    clock.advance(advertised * 1000);
    expect((await poll()).body.error).toBe('authorization_pending');
  });

  it('publishes the three constants a client must agree with the server about', () => {
    expect(DEVICE_FLOW_CONSTANTS.expiresInSeconds).toBe(DEVICE_CODE_TTL_SECONDS);
    expect(DEVICE_FLOW_CONSTANTS.initialIntervalSeconds).toBe(DEVICE_POLL_INTERVAL_SECONDS);
    // RFC 8628 §3.5's own number. An SDK backing off by a different amount than
    // the server raises is the drift this constant exists to prevent.
    expect(DEVICE_FLOW_CONSTANTS.intervalIncrementSeconds).toBe(5);
  });

  it('every error example parses as a device-grant error body', () => {
    for (const key of ['pending', 'slowDown', 'denied', 'expired', 'badGrant'] as const) {
      expect(
        deviceGrantErrorBodySchema.safeParse(DEVICE_FLOW_EXAMPLES[key]).success,
        key,
      ).toBe(true);
    }
  });
});

describe('PF-142: the error oracle is EXTENDED, never duplicated', () => {
  it('L04’s union already carries RFC 8628 §3.5’s four codes', () => {
    for (const code of ['authorization_pending', 'slow_down', 'access_denied', 'expired_token']) {
      expect(OAUTH_ERROR_CODES).toContain(code);
    }
  });

  it('the union is exactly the ten codes this surface emits — no silent widening', () => {
    expect([...OAUTH_ERROR_CODES].sort()).toEqual(
      [
        'access_denied',
        'authorization_pending',
        'expired_token',
        'invalid_client',
        'invalid_grant',
        'invalid_request',
        'invalid_scope',
        'slow_down',
        'unauthorized_client',
        'unsupported_grant_type',
      ].sort(),
    );
  });

  it('every device-grant code is a member of that one union', () => {
    // The narrowing in `deviceContract.ts` is a SUBSET, not a second taxonomy.
    for (const code of DEVICE_GRANT_ERROR_CODES) {
      expect(OAUTH_ERROR_CODES).toContain(code);
    }
  });

  it('declares no second error schema — it refines L04’s', () => {
    const text = readFileSync(join(HERE, 'deviceContract.ts'), 'utf8');
    expect(text).toContain('oauthErrorBodySchema');
    // A `z.object({ error: ... })` here would be the second definition U3 warns
    // about.
    expect(text).not.toMatch(/z\s*\.\s*object\s*\(\s*\{\s*error:/);
  });

  it('NO module in this lane imports L07’s ApiError', () => {
    // The contract violation U3 predicted, and worth failing a PR over.
    const laneFiles = readdirSync(HERE).filter(
      (f) => (f.startsWith('device') || f.startsWith('pgDevice')) && f.endsWith('.ts') && !f.endsWith('.test.ts'),
    );
    expect(laneFiles.length).toBeGreaterThanOrEqual(6);
    for (const name of laneFiles) {
      const text = readFileSync(join(HERE, name), 'utf8');
      const imports = [...text.matchAll(/^\s*import[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map(
        (m) => m[1] as string,
      );
      for (const spec of imports) {
        expect(spec, `${name} must not import L07's error module`).not.toMatch(
          /api\/v1\/errors|\/errors\.js$/,
        );
      }
    }
  });

  it('emits no ApiError-shaped body on any device failure path', async () => {
    const res = await request(server).post('/oauth/token').type('form').send({
      grant_type: DEVICE_CODE_GRANT_TYPE,
      device_code: generateDeviceCode(),
      client_id: app.clientId,
      client_secret: secret,
    });
    expect(oauthErrorBodySchema.safeParse(res.body).success).toBe(true);
    expect(res.body.code).toBeUndefined();
    expect(res.body.message).toBeUndefined();
    expect(res.body.request_id).toBeUndefined();
  });
});

describe('PF-143: the architecture document’s device diagram is kept true by this test', () => {
  // p.12's OAuth Flows row requires "Sequence diagrams for Authorization Code +
  // PKCE and Device Authorization Grant". The diagram commits to specifics; if
  // an endpoint is renamed or a field dropped, this fails rather than silently
  // making a graded deliverable wrong. Mirrors L04's PF-113.

  it('the document still contains a device sequence diagram', () => {
    expect(DOC).toContain('participant DC as /oauth/device/code');
    expect(DOC).toContain('grant_type=urn:…:device_code');
  });

  it('every endpoint the diagram names is a MOUNTED route', async () => {
    // Not "a string exists in a file" — an actual request that is not a 404.
    const mounted: [string, () => Promise<{ status: number }>][] = [
      [
        'POST /oauth/device/code',
        () =>
          request(server)
            .post('/oauth/device/code')
            .type('form')
            .send({ client_id: app.clientId }),
      ],
      [
        'POST /oauth/token (device grant)',
        () =>
          request(server).post('/oauth/token').type('form').send({
            grant_type: DEVICE_CODE_GRANT_TYPE,
            device_code: 'x',
            client_id: app.clientId,
            client_secret: secret,
          }),
      ],
    ];

    for (const [label, call] of mounted) {
      const res = await call();
      expect(res.status, `${label} must be mounted`).not.toBe(404);
    }

    // `/oauth/device/verify` needs the browser deps, which this harness does not
    // wire — so it is asserted against the document and the router source
    // rather than by a request that would 404 for an unrelated reason.
    expect(DOC).toContain('/oauth/device/verify');
    expect(readFileSync(join(HERE, 'deviceVerify.ts'), 'utf8')).toContain('DEVICE_VERIFY_PATH');
  });

  it('every response field the diagram names is present in the shipped body', async () => {
    // The diagram commits to `device_code, user_code, verification_uri, interval`.
    const res = await request(server)
      .post('/oauth/device/code')
      .type('form')
      .send({ client_id: app.clientId, client_secret: secret });

    for (const field of ['device_code', 'user_code', 'verification_uri', 'interval']) {
      expect(DOC, `the diagram should still name ${field}`).toContain(field);
      expect(res.body[field], `the response must carry ${field}`).toBeDefined();
    }
  });

  it('the poll loop the diagram draws emits the codes it claims', () => {
    expect(DOC).toContain('authorization_pending');
    expect(DOC).toContain('slow_down');
    for (const code of ['authorization_pending', 'slow_down']) {
      expect(DEVICE_GRANT_ERROR_CODES).toContain(code);
    }
  });
});

describe('PF-144: the sweeper, on an injected clock', () => {
  async function seed(over: Record<string, unknown> = {}) {
    return deviceCodeRepo.insert({
      deviceCodeHash: hashDeviceCode(generateDeviceCode()),
      userCode: generateUserCode(),
      appId: app.id,
      scopes: ['documents:read'],
      intervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
      expiresAt: new Date(clock.nowMs() + DEVICE_CODE_TTL_SECONDS * 1000),
      createdAt: new Date(clock.nowMs()),
      ...over,
    } as Parameters<InMemoryDeviceCodeRepo['insert']>[0]);
  }

  it('removes expired-unredeemed rows and leaves live ones', async () => {
    const expired = await seed();
    clock.advance(DEVICE_CODE_TTL_SECONDS * 1000 + 1000);
    const live = await seed();

    const removed = await sweepDeviceCodes({ deviceCodeRepo, clock });
    expect(removed).toBe(1);
    expect(await deviceCodeRepo.findByDeviceCodeHash(expired.deviceCodeHash)).toBeNull();
    expect(await deviceCodeRepo.findByDeviceCodeHash(live.deviceCodeHash)).not.toBeNull();
  });

  it('keeps a consumed row through its retention window, then removes it', async () => {
    // A consumed row must outlive its own TTL, or a replayed poll becomes
    // indistinguishable from an unknown device code.
    const row = await seed();
    await deviceCodeRepo.consume(row.id, new Date(clock.nowMs()));

    clock.advance(DEVICE_CODE_TTL_SECONDS * 1000 + 1000);
    expect(await sweepDeviceCodes({ deviceCodeRepo, clock })).toBe(0);
    expect(await deviceCodeRepo.findByDeviceCodeHash(row.deviceCodeHash)).not.toBeNull();

    clock.advance(CONSUMED_DEVICE_CODE_RETENTION_SECONDS * 1000);
    expect(await sweepDeviceCodes({ deviceCodeRepo, clock })).toBe(1);
    expect(await deviceCodeRepo.findByDeviceCodeHash(row.deviceCodeHash)).toBeNull();
  });

  it('schedules nothing — no bare timer anywhere in the module', () => {
    const text = readFileSync(join(HERE, 'deviceSweeper.ts'), 'utf8');
    expect(text).not.toMatch(/\bsetTimeout\s*\(/);
    expect(text).not.toMatch(/\bsetInterval\s*\(/);
    expect(text).not.toMatch(/\bDate\.now\s*\(/);
  });
});

describe('PF-144: Pre-Search 1.1 answered with numbers, handed to L25', () => {
  it('bounds the live set by logins-per-ten-minutes, not by total logins', () => {
    // The load-bearing property: the table is self-limiting because a row lives
    // 600s, so it does not grow with cumulative usage.
    expect(estimateLiveDeviceCodes(20)).toBe(20);
    expect(estimateLiveDeviceCodes(200)).toBe(200);
    // And the arithmetic follows the TTL rather than being a hard-coded guess.
    expect(DEVICE_CODE_TTL_SECONDS / 60).toBe(10);
  });

  it('gives the poll cost for a demo-sized load', () => {
    // 20 concurrent flows at the 5s default interval.
    expect(estimatePollsPerSecond(20, DEVICE_POLL_INTERVAL_SECONDS)).toBe(4);
    // Each poll is one indexed lookup on UNIQUE(device_code_hash).
    expect(estimatePollsPerSecond(100, DEVICE_POLL_INTERVAL_SECONDS)).toBe(20);
  });

  it('the per-flow independence the answer rests on is a column, not a map', () => {
    // PF-137 proves the behaviour; this pins the structural reason, which is
    // what makes the capacity answer true rather than incidental.
    const text = readFileSync(join(HERE, 'deviceGrant.ts'), 'utf8');
    expect(text).toContain('row.intervalSeconds');
    expect(text).not.toMatch(/new Map\(/);
  });
});
