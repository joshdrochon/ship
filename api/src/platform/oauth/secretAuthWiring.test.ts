/**
 * F112 — the leaked-secret audit signal, driven over real HTTP.
 *
 * ## What was actually broken
 *
 * `secret-auth-log.ts` shipped `ALERT_THRESHOLDS`, `evaluateAlerts` and both
 * implementations of `ISecretAuthLog`, all with passing unit tests. Nothing
 * called `record()`. `client_secret_auth_log` was therefore empty on every
 * deployed instance and all three documented alert conditions were unreachable
 * — while the suite was green.
 *
 * That is the exact failure mode these tests are shaped to prevent, so none of
 * them constructs a log and calls `record()` on it. Every assertion below goes
 * through `POST /oauth/token` or `POST /oauth/device/code` and then reads the
 * log back. A test that drove `record()` directly would have passed before
 * F112 existed, which makes it worthless as a regression test for F112.
 *
 * PRD p.17: *"How do you detect and respond to a leaked client_secret … What's
 * the audit signal you'd alert on?"* The answer is only true if the rows exist.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { FakeClock } from '../clock.js';
import { InMemoryOAuthAppRepo, secretMaterial } from '../apps/repo.js';
import {
  generateClientId,
  generateClientSecret,
  hashClientSecret,
  secretPrefix,
} from '../apps/secrets.js';
import type { OAuthApp } from '../apps/types.js';
import type { Scope } from '../scopes/scopes.js';
import {
  ALERT_THRESHOLDS,
  InMemorySecretAuthLog,
  evaluateAlerts,
  type ISecretAuthLog,
  type SecretAuthAttempt,
} from '../apps/secret-auth-log.js';
import { InMemoryTokenRepo } from './tokenRepo.js';
import { createOAuthRouter } from './router.js';
import { DEFAULT_TOKEN_TTL } from './tokens.js';
import { CLIENT_CREDENTIALS_GRANT_TYPE } from './clientCredentialsGrant.js';
import { InMemoryDeviceCodeRepo } from './deviceCodes.js';

const SCOPES: Scope[] = ['documents:read', 'issues:read', 'sprints:read'];
const START_MS = 1_700_000_000_000;

let appsRepo: InMemoryOAuthAppRepo;
let tokenRepo: InMemoryTokenRepo;
let deviceCodeRepo: InMemoryDeviceCodeRepo;
let clock: FakeClock;
let log: InMemorySecretAuthLog;
let server: Express;

let app: OAuthApp;
let secret: string;

async function makeApp(name: string, rawSecret: string): Promise<OAuthApp> {
  return appsRepo.create({
    clientId: generateClientId(),
    ...secretMaterial(rawSecret),
    name,
    ownerUserId: 'user-1',
    workspaceId: 'ws-1',
    redirectUris: ['http://127.0.0.1:8976/callback'],
    requestedScopes: SCOPES,
    isFirstParty: true,
  });
}

/** Builds the router with whatever log the case needs. */
function mount(secretAuthLog?: ISecretAuthLog): Express {
  const server = express();
  server.use(
    '/oauth',
    createOAuthRouter({
      appsRepo,
      tokenRepo,
      deviceCodeRepo,
      publicBaseUrl: 'https://ship.example.gov',
      clock,
      ttl: DEFAULT_TOKEN_TTL,
      ...(secretAuthLog ? { secretAuthLog } : {}),
    }),
  );
  return server;
}

function tokenRequest(body: Record<string, string>) {
  return request(server).post('/oauth/token').type('form').send(body);
}

function ccGrant(overrides: Record<string, string> = {}) {
  return tokenRequest({
    grant_type: CLIENT_CREDENTIALS_GRANT_TYPE,
    client_id: app.clientId,
    client_secret: secret,
    ...overrides,
  });
}

/**
 * `record()` is fire-and-forget by design, so the row may land a microtask after
 * the response. Yields the event loop rather than sleeping — a `setTimeout` here
 * would be the flaky-test shape the PRD's test-discipline rules ban (p.11).
 */
async function settled(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(async () => {
  appsRepo = new InMemoryOAuthAppRepo();
  tokenRepo = new InMemoryTokenRepo();
  deviceCodeRepo = new InMemoryDeviceCodeRepo();
  clock = new FakeClock(START_MS);
  log = new InMemorySecretAuthLog();

  secret = generateClientSecret();
  app = await makeApp('Leak Drill', secret);

  server = mount(log);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('F112 — every client-secret verification reaches the log', () => {
  it('records a SUCCESS, because two alert conditions are about successes', async () => {
    const res = await ccGrant();
    await settled();

    expect(res.status).toBe(200);
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({
      clientId: app.clientId,
      outcome: 'success',
      secretPrefix: app.secretPrefix,
    });
  });

  it('records a WRONG SECRET as bad_secret', async () => {
    const res = await ccGrant({ client_secret: generateClientSecret() });
    await settled();

    expect(res.status).toBe(401);
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]?.outcome).toBe('bad_secret');
  });

  it('records an UNKNOWN client_id with a null prefix — there is no app to prefix', async () => {
    const res = await ccGrant({ client_id: 'ship_app_nosuchappanywhere' });
    await settled();

    expect(res.status).toBe(401);
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({
      clientId: 'ship_app_nosuchappanywhere',
      outcome: 'unknown_client',
      secretPrefix: null,
    });
  });

  it('records an attempt against a DEACTIVATED app — condition (c) on its own', async () => {
    await appsRepo.deactivate(app.id, 'admin_action', new Date(clock.nowMs()));

    const res = await ccGrant();
    await settled();

    expect(res.status).toBe(401);
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]?.outcome).toBe('app_inactive');
  });

  it('records the DEVICE authorization endpoint too, not just /oauth/token', async () => {
    const res = await request(server)
      .post('/oauth/device/code')
      .type('form')
      .send({ client_id: app.clientId, client_secret: secret });
    await settled();

    expect(res.status).toBe(200);
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({ outcome: 'success', clientId: app.clientId });
  });

  it('takes its timestamp from the injected clock, never from Date.now()', async () => {
    clock.advance(90_000);
    await ccGrant();
    await settled();

    expect(log.entries[0]?.occurredAt.getTime()).toBe(START_MS + 90_000);
  });

  it('records a source IP, which is what alert condition (b) counts', async () => {
    await ccGrant();
    await settled();

    // Supertest connects over loopback; the exact form varies by stack, so the
    // assertion is that SOMETHING addressable was captured rather than a literal.
    expect(log.entries[0]?.sourceIp).toBeTruthy();
  });

  it('a PUBLIC client presenting no secret records NOTHING — no secret was verified', async () => {
    const publicApp = await appsRepo.create({
      clientId: generateClientId(),
      ...secretMaterial(generateClientSecret()),
      name: 'CLI',
      ownerUserId: 'user-1',
      workspaceId: 'ws-1',
      redirectUris: ['http://127.0.0.1:8976/callback'],
      requestedScopes: SCOPES,
      isPublic: true,
    });

    await request(server)
      .post('/oauth/device/code')
      .type('form')
      .send({ client_id: publicApp.clientId });
    await settled();

    // The log is the SECRET auth log. A flow that presented no secret has no
    // business appearing in it, and padding it would corrupt condition (a)'s
    // failure count with rows that were never credential attempts.
    expect(log.entries).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The security property. These are the tests that matter most.
// ─────────────────────────────────────────────────────────────────────────────

describe('F112 — the log never holds the secret, and never holds its hash', () => {
  /** Every string on a recorded row, flattened, for a substring sweep. */
  function allStrings(entry: SecretAuthAttempt): string[] {
    return [entry.clientId, entry.secretPrefix ?? '', entry.outcome, entry.sourceIp ?? ''];
  }

  it('holds neither the presented secret nor its hash, on ANY outcome', async () => {
    const wrong = generateClientSecret();

    await ccGrant(); // success
    await ccGrant({ client_secret: wrong }); // bad_secret
    await ccGrant({ client_id: 'ship_app_ghost', client_secret: wrong }); // unknown_client
    await settled();

    expect(log.entries).toHaveLength(3);

    for (const entry of log.entries) {
      for (const value of allStrings(entry)) {
        expect(value).not.toContain(secret);
        expect(value).not.toContain(wrong);
        expect(value).not.toContain(hashClientSecret(secret));
        expect(value).not.toContain(hashClientSecret(wrong));
      }
    }
  });

  /**
   * The subtle one, and the reason `secretAuthAttemptFrom` reads the prefix off
   * the APP rather than off the presented value.
   *
   * A credential-stuffing probe sweeps ONE stolen secret across many client_ids.
   * If the recorded prefix came from what was presented, this table would fill
   * with the live prefix of whatever app that secret really belongs to — a
   * genuine credential fragment, deposited by an attacker, into a table read
   * more widely than the credential store.
   */
  it('records the ADDRESSED app\'s prefix on a failure, never the presented value\'s', async () => {
    const victimSecret = generateClientSecret();
    const victim = await makeApp('Victim', victimSecret);

    // The stolen secret, presented against the WRONG app.
    await ccGrant({ client_id: app.clientId, client_secret: victimSecret });
    await settled();

    const entry = log.entries[0];
    expect(entry?.outcome).toBe('bad_secret');
    // The app that was addressed …
    expect(entry?.secretPrefix).toBe(app.secretPrefix);
    // … and emphatically NOT the app the presented secret actually belongs to.
    expect(entry?.secretPrefix).not.toBe(victim.secretPrefix);
    expect(entry?.secretPrefix).not.toBe(secretPrefix(victimSecret));
  });

  it('the module imports no hashing helper — the grep that keeps the above true', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      new URL('../apps/secret-auth-log.ts', import.meta.url),
      'utf8',
    );

    // Asserted over the IMPORT statements, not over the whole file: the module
    // header discusses `hashClientSecret` by name in order to explain why it is
    // absent, and a naive substring grep would fail on that prose — punishing
    // the documentation for describing the property it documents.
    //
    // The hazard being fenced off is real. `hashClientSecret` is what a future
    // author reaches for to "make the prefix safer", and it does the opposite: a
    // hash of a low-entropy prefix is reversible by brute force, and a hash of
    // the whole secret IS the stored credential.
    const imports = source
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line) || /^\s*}\s*from\s+'/.test(line))
      .join('\n');

    expect(imports).not.toMatch(/hashClientSecret/);
    expect(imports).not.toMatch(/secrets\.js/);
    // And the credential store is not reached through a bare re-export either.
    expect(imports).not.toMatch(/apps\/index\.js/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('F112 — recording cannot change the auth outcome', () => {
  /** A log that fails the way a database outage does: a rejected promise. */
  class RejectingLog implements ISecretAuthLog {
    calls = 0;
    async record(): Promise<void> {
      this.calls += 1;
      return Promise.reject(new Error('client_secret_auth_log is unavailable'));
    }
    async countFailures(): Promise<number> {
      return 0;
    }
    async countDistinctSuccessIps(): Promise<number> {
      return 0;
    }
    async countInactiveAttempts(): Promise<number> {
      return 0;
    }
  }

  /** A log that fails the way a programming error does: a synchronous throw. */
  class ThrowingLog extends RejectingLog {
    override async record(): Promise<void> {
      this.calls += 1;
      throw new Error('boom');
    }
  }

  it('a REJECTING log still lets a valid client authenticate', async () => {
    const failing = new RejectingLog();
    server = mount(failing);

    const res = await ccGrant();
    await settled();

    // The whole point: an alerting outage must not become an auth outage.
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('access_token');
    expect(failing.calls).toBe(1);
  });

  it('a THROWING log still lets a valid client authenticate', async () => {
    const failing = new ThrowingLog();
    server = mount(failing);

    const res = await ccGrant();
    await settled();

    expect(res.status).toBe(200);
    expect(failing.calls).toBe(1);
  });

  it('a REJECTING log still REFUSES an invalid client — failure is not a bypass', async () => {
    server = mount(new RejectingLog());

    const res = await ccGrant({ client_secret: generateClientSecret() });
    await settled();

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'invalid_client' });
  });

  it('no log wired at all leaves both outcomes exactly as they were', async () => {
    server = mount(undefined);

    expect((await ccGrant()).status).toBe(200);
    expect((await ccGrant({ client_secret: generateClientSecret() })).status).toBe(401);
  });

  it('the response body is byte-identical for unknown-client and wrong-secret', async () => {
    // PF-036's indistinguishability contract, re-asserted WITH recording on:
    // the two paths now write different rows (one has a prefix, one does not),
    // and that difference must not reach the wire.
    const unknown = await ccGrant({ client_id: 'ship_app_ghost' });
    const wrongSecret = await ccGrant({ client_secret: generateClientSecret() });
    await settled();

    expect(unknown.status).toBe(wrongSecret.status);
    expect(unknown.body).toEqual(wrongSecret.body);
    // …and both were still recorded, with the distinction kept server-side.
    expect(log.entries.map((e) => e.outcome)).toEqual(['unknown_client', 'bad_secret']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('F112 — the recorded rows actually drive p.17\'s three alerts', () => {
  /**
   * The end-to-end claim, and the one that was false before F112: traffic
   * against the real endpoint produces rows that make `evaluateAlerts` fire.
   * Every earlier test of these conditions seeded the log by hand.
   */
  it('(a) repeated failures against one client_id fire repeated_failures', async () => {
    for (let i = 0; i < ALERT_THRESHOLDS.failuresInWindow; i += 1) {
      await ccGrant({ client_secret: generateClientSecret() });
    }
    await settled();

    const fired = await evaluateAlerts(log, app.clientId, new Date(clock.nowMs()));
    expect(fired).toContain('repeated_failures');
  });

  it('(a) stays quiet one attempt below the threshold', async () => {
    for (let i = 0; i < ALERT_THRESHOLDS.failuresInWindow - 1; i += 1) {
      await ccGrant({ client_secret: generateClientSecret() });
    }
    await settled();

    const fired = await evaluateAlerts(log, app.clientId, new Date(clock.nowMs()));
    expect(fired).not.toContain('repeated_failures');
  });

  it('(c) a single attempt against a deactivated app fires inactive_app_attempt', async () => {
    await appsRepo.deactivate(app.id, 'admin_action', new Date(clock.nowMs()));

    await ccGrant();
    await settled();

    const fired = await evaluateAlerts(log, app.clientId, new Date(clock.nowMs()));
    expect(fired).toContain('inactive_app_attempt');
  });

  it('failures age OUT of the window — the alert is windowed, not cumulative', async () => {
    for (let i = 0; i < ALERT_THRESHOLDS.failuresInWindow; i += 1) {
      await ccGrant({ client_secret: generateClientSecret() });
    }
    await settled();

    // Walk past the window on the injected clock. No sleeping.
    clock.advance(ALERT_THRESHOLDS.windowMs + 60_000);

    const fired = await evaluateAlerts(log, app.clientId, new Date(clock.nowMs()));
    expect(fired).not.toContain('repeated_failures');
  });

  it('alerts are scoped to ONE client_id — a noisy neighbour does not page you', async () => {
    const neighbourSecret = generateClientSecret();
    const neighbour = await makeApp('Neighbour', neighbourSecret);

    for (let i = 0; i < ALERT_THRESHOLDS.failuresInWindow; i += 1) {
      await ccGrant({ client_id: neighbour.clientId, client_secret: generateClientSecret() });
    }
    await settled();

    expect(await evaluateAlerts(log, neighbour.clientId, new Date(clock.nowMs()))).toContain(
      'repeated_failures',
    );
    expect(await evaluateAlerts(log, app.clientId, new Date(clock.nowMs()))).not.toContain(
      'repeated_failures',
    );
  });
});
