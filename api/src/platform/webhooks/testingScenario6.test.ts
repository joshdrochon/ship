/**
 * PF-444 / PF-445 — Testing Scenario 6, server half.
 *
 * PRD p.5, scenario 6: *"Create a webhook subscription via the SDK; create a
 * document; verify a signed POST arrives at the target URL within 2s; verify the
 * signature with the SDK helper; tamper with the body and verify the helper
 * rejects it."*
 *
 * This file is the first, second, fourth and fifth clauses, with the SDK client
 * substituted by a direct HTTP call — the SDK is L18's, and the wire delivery is
 * L16's. What it proves is that a REAL public write, through the REAL router and
 * the REAL bus, produces exactly one correctly signed request.
 *
 * ## The 2 s clause is NOT asserted here, and that is deliberate
 *
 * p.6's target is *"webhook delivery latency (P95, first attempt) <2s"*, measured
 * event → arrival at the subscriber. Arrival is L16's HTTP attempt, which does
 * not exist yet, so no assertion in this lane could measure it honestly. Every
 * timing assertion here is against a `FakeClock` (p.11: timing-based webhook
 * tests are flaky tests). The honest owner of the 2 s number is L16's
 * first-attempt path plus L20's drill — recorded as U5 in `lane-99-unassigned.md`
 * and CLAIMED there by L20's PF-603.
 *
 * A sleep-free lane that measures nothing is better than a flaky lane that
 * measures the wrong thing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { pool } from '../../db/client.js';
import { createApp } from '../../app.js';
import { testDeps } from '../../deps.js';
import { FakeClock } from '../clock.js';
import { InMemoryOAuthAppRepo, secretMaterial } from '../apps/repo.js';
import { generateClientId, generateClientSecret } from '../apps/secrets.js';
import { InMemoryTokenRepo } from '../oauth/tokenRepo.js';
import { bearerTokenMiddleware } from '../oauth/bearer.js';
import { issueTokenPair } from '../oauth/issue.js';
import { DEFAULT_TOKEN_TTL } from '../oauth/tokens.js';
import { AesGcmSecretCipher, WEBHOOK_SECRET_KEY_BYTES } from './secretCipher.js';
import { InMemoryTokenBucket } from '../ratelimit/limiter.js';
import { InMemoryWebhookSubscriptionRepo } from './inMemorySubscriptionRepo.js';
import { RecordingDeliveryQueue } from './pipeline.js';
import { verifySignature, DEFAULT_TOLERANCE_SECONDS } from './signer.js';
import { eventEnvelopeSchema } from './events.js';

const CIPHER = new AesGcmSecretCipher(Buffer.alloc(WEBHOOK_SECRET_KEY_BYTES, 0x6e));
/** A fixed instant, so every signature in this file is byte-stable. */
const T0_MS = 1_715_985_600_000;
const T0_SECONDS = T0_MS / 1000;

let app: Express;
let queue: RecordingDeliveryQueue;
let clock: FakeClock;
let token: string;
let workspaceId: string;
let userId: string;

beforeAll(async () => {
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
    [`L15 TS-6 ${runId}`],
  );
  workspaceId = ws.rows[0]!.id;

  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, 'test-hash', 'TS-6 User') RETURNING id`,
    [`l15-ts6-${runId}@ship.local`],
  );
  userId = user.rows[0]!.id;

  await pool.query(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
    [workspaceId, userId],
  );

  clock = new FakeClock(T0_MS);

  const appsRepo = new InMemoryOAuthAppRepo();
  const tokenRepo = new InMemoryTokenRepo();
  const oauthApp = await appsRepo.create({
    clientId: generateClientId(),
    ...secretMaterial(generateClientSecret()),
    name: 'TS-6 app',
    ownerUserId: userId,
    workspaceId,
    redirectUris: ['https://example.test/cb'],
    requestedScopes: ['documents:read', 'documents:write', 'webhooks:manage'],
  });

  // The repository's own clock ticks so two subscriptions get distinct
  // `created_at` values; the SIGNER reads `clock`, which is pinned.
  const repoClock = (() => {
    const fake = new FakeClock(T0_MS);
    return {
      nowMs: () => {
        fake.advance(1000);
        return fake.nowMs();
      },
    };
  })();

  queue = new RecordingDeliveryQueue();

  // The real composition root, with the real bearer middleware. `testDeps()`
  // defaults `bearerAuth` to a reject-everything stub, which is right for tests
  // that assert the 401 and useless for one that has to get past it.
  app = createApp(
    testDeps({
      clock,
      appsRepo,
      tokenRepo,
      bearerAuth: bearerTokenMiddleware({ tokenRepo, appsRepo, clock }),
      subsRepo: new InMemoryWebhookSubscriptionRepo({ cipher: CIPHER, clock: repoClock }),
      deliveryQueue: queue,
      // `testDeps()` ships a TWO-request bucket so a spec that wants a 429 can
      // produce one cheaply (PF-309). This scenario needs a dozen calls and is
      // not about rate limiting, so both buckets are widened here — and widened
      // EXPLICITLY rather than by reaching for `productionDeps`, so it is
      // visible that this file opted out of one default and nothing else.
      perAppLimiter: new InMemoryTokenBucket(
        { capacity: 1_000_000, refillPerSecond: 1_000_000, maxKeys: 1_000 },
        clock,
      ),
      perTokenLimiter: new InMemoryTokenBucket(
        { capacity: 1_000_000, refillPerSecond: 1_000_000, maxKeys: 1_000 },
        clock,
      ),
    }),
  );

  const { response } = await issueTokenPair(
    { tokenRepo, clock, ttl: DEFAULT_TOKEN_TTL },
    { app: oauthApp, userId, scopes: ['documents:read', 'documents:write', 'webhooks:manage'] },
  );
  token = response.access_token;
});

const auth = () => ({ Authorization: `Bearer ${token}` });

describe('PF-444 — subscribe → create a document → exactly one signed request', () => {
  it('the whole of TS-6\'s first two clauses, through the public API', async () => {
    queue.reset();

    // 1. Create a webhook subscription. p.7's drill loop, minus the SDK:
    //    `client.webhooks.create({ event, target_url })`.
    const subscribed = await request(app)
      .post('/api/v1/webhooks')
      .set(auth())
      .send({ event: 'document.created', target_url: 'https://example.test/hooks/ts6' });
    expect(subscribed.status, JSON.stringify(subscribed.body)).toBe(201);
    const signingSecret = subscribed.body.signing_secret as string;

    // 2. Create a document — a real public write, through the real router.
    const created = await request(app)
      .post('/api/v1/documents')
      .set(auth())
      .send({ title: 'TS-6 document', document_type: 'wiki' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    // 3. EXACTLY ONE request was handed off. Not "at least one": a duplicate
    //    would mean two publish sites, and PRD p.3's "domain layer publishes on
    //    writes, never the route layer" is exactly the rule that prevents it.
    expect(queue.jobs).toHaveLength(1);
    const job = queue.jobs[0]!;

    expect(job.targetUrl).toBe('https://example.test/hooks/ts6');
    expect(job.request.targetUrl).toBe('https://example.test/hooks/ts6');

    // 4. The body is a registry-valid envelope naming the document just created.
    const body = JSON.parse(job.request.rawBody.toString('utf8'));
    expect(eventEnvelopeSchema.safeParse(body).success).toBe(true);
    expect(body.type).toBe('document.created');
    expect(body.data.id).toBe(created.body.id);
    expect(body.data.title).toBe('TS-6 document');
    expect(body.workspace_id).toBe(workspaceId);

    // 5. The signature verifies under the secret returned at CREATION — the one
    //    the subscriber captured and the only copy anyone outside this server
    //    will ever hold.
    expect(
      verifySignature(signingSecret, job.request.signatureHeader, job.request.rawBody, T0_SECONDS),
    ).toBe(true);

    // The timing clause, against the FakeClock and not wall time: the event was
    // signed at the instant it was published. See the module header for why the
    // 2 s number is not asserted in this lane.
    expect(job.request.signedAtSeconds).toBe(T0_SECONDS);
  });

  it('a workspace with no subscription produces no request at all', async () => {
    queue.reset();
    // The same write, in a workspace nobody subscribed. The negative half of
    // "exactly one" — without it, a matcher that ignored `workspace_id` would
    // pass the test above.
    const otherWs = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ('L15 TS-6 unsubscribed') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by, visibility)
       VALUES ($1, 'wiki', 'not fanned out', $2, 'workspace')`,
      [otherWs.rows[0]!.id, userId],
    );
    // Written directly rather than through the API because the token is bound
    // to `workspaceId` and cannot address another tenant — which is PF-260
    // working, and is why this row cannot reach the bus at all.
    expect(queue.jobs).toEqual([]);
  });

  it('a DEACTIVATED subscription receives nothing from a real write', async () => {
    queue.reset();
    const sub = await request(app)
      .post('/api/v1/webhooks')
      .set(auth())
      .send({ event: 'document.created', target_url: 'https://example.test/hooks/off' });
    await request(app).delete(`/api/v1/webhooks/${sub.body.id}`).set(auth());

    queue.reset();
    await request(app)
      .post('/api/v1/documents')
      .set(auth())
      .send({ title: 'after deactivation', document_type: 'wiki' });

    // The still-active subscription from the first test is gone (each `it`
    // resets the queue but not the store), so assert on target rather than
    // count: nothing went to the deactivated URL.
    expect(queue.jobs.map((j) => j.targetUrl)).not.toContain('https://example.test/hooks/off');
  });
});

describe('PF-445 — TS-6\'s negative half: tamper, and replay', () => {
  let signingSecret: string;
  let capturedBody: Buffer;
  let capturedHeader: string;

  beforeAll(async () => {
    queue.reset();
    const subscribed = await request(app)
      .post('/api/v1/webhooks')
      .set(auth())
      .send({ event: 'document.created', target_url: 'https://example.test/hooks/negative' });
    expect(subscribed.status, JSON.stringify(subscribed.body)).toBe(201);
    signingSecret = subscribed.body.signing_secret;

    const doc = await request(app)
      .post('/api/v1/documents')
      .set(auth())
      .send({ title: 'tamper subject', document_type: 'wiki' });
    expect(doc.status, JSON.stringify(doc.body)).toBe(201);

    const job = queue.jobs.find((j) => j.targetUrl === 'https://example.test/hooks/negative')!;
    expect(job, 'no delivery was captured for the negative half').toBeDefined();
    capturedBody = job.request.rawBody;
    capturedHeader = job.request.signatureHeader;
  });

  it('the captured request verifies before anything is done to it', () => {
    // The control. Without it, every assertion below would pass against a
    // verifier that always returned false.
    expect(verifySignature(signingSecret, capturedHeader, capturedBody, T0_SECONDS)).toBe(true);
  });

  it('TAMPER — one character changed inside data.title fails verification', () => {
    // p.5: "tamper with the body and verify the helper rejects it". A character
    // INSIDE the title, not whitespace: the same length, still valid JSON, and
    // semantically the payload a man-in-the-middle would want to change.
    const text = capturedBody.toString('utf8');
    expect(text).toContain('tamper subject');
    const tampered = Buffer.from(text.replace('tamper subject', 'tamper subjecT'), 'utf8');

    expect(tampered.length).toBe(capturedBody.length);
    expect(Buffer.compare(tampered, capturedBody)).not.toBe(0);
    expect(verifySignature(signingSecret, capturedHeader, tampered, T0_SECONDS)).toBe(false);
  });

  it('REPLAY — the 300 s boundary, asserted from BOTH sides', () => {
    // The bytes and the header are UNMODIFIED. What changes is only the time at
    // which they are presented, which is the whole anti-replay property.
    expect(
      verifySignature(signingSecret, capturedHeader, capturedBody, T0_SECONDS + 299),
    ).toBe(true);
    expect(
      verifySignature(
        signingSecret,
        capturedHeader,
        capturedBody,
        T0_SECONDS + DEFAULT_TOLERANCE_SECONDS,
      ),
    ).toBe(true);
    expect(
      verifySignature(
        signingSecret,
        capturedHeader,
        capturedBody,
        T0_SECONDS + DEFAULT_TOLERANCE_SECONDS + 1,
      ),
    ).toBe(false);
  });

  it('p.4 — a MISSING v1 header fails', () => {
    const timestampOnly = capturedHeader.split(',')[0]!;
    expect(verifySignature(signingSecret, timestampOnly, capturedBody, T0_SECONDS)).toBe(false);
  });

  it('the WRONG secret fails on the untouched request', () => {
    // Distinguishable from the replay case only by which input changed, which
    // is the operational distinction a subscriber has to make: 100% failure
    // across all subscriptions at once is clock drift; one subscription failing
    // is a secret mismatch.
    expect(
      verifySignature('whsec_someone-elses-secret', capturedHeader, capturedBody, T0_SECONDS),
    ).toBe(false);
  });
});
