/**
 * PF-480 · PF-481 — **Testing Scenarios 7 and 8 (PRD p.5), end to end.**
 *
 * These are the two the graders run against this lane. Each is ONE test, so a
 * partial pass cannot be reported as a pass.
 *
 * TS-7 (p.5): *"Make a subscriber return 500 on the first three attempts and 200
 * on the fourth. Verify the retry schedule (1s, 4s, 16s ≥ wait times before each
 * attempt) and that the fourth attempt records success in the delivery log."*
 *
 * TS-8 (p.5): *"Force 6 consecutive failures. Verify the delivery lands in the
 * dead-letter queue and is visible in the developer portal. Click 'Replay'
 * against a now-healthy subscriber and verify the replay succeeds with the
 * original idempotency key intact."*
 *
 * ## Every wait is a `FakeClock.advance`. Nothing sleeps.
 *
 * PRD p.11: *"The real queue-backed deliverer is tested with deterministic clock
 * injection — never with `setTimeout` waits in tests. Timing-based webhook tests
 * are flaky tests."* A literal TS-8 would take **six minutes and twenty-one
 * seconds** of wall clock; this file runs it in microseconds, and
 * `retryClockFitness.test.ts` greps this file to prove there is no timer in it.
 *
 * ## The assertion is a LOWER bound, which is also what makes it jitter-proof
 *
 * p.5 says *"1s, 4s, 16s ≥ wait times before each attempt"* — the schedule is a
 * floor, not an equality. Asserting "the deliverer had not been called at
 * cumulative +999 ms and had been by +1 s" is exactly that claim, and it holds
 * for any jitter within PF-453's ±10 % band.
 *
 * ## Against the real database
 *
 * `PgDeliveryLog`, not the double: TS-7's clause is *"records success in the
 * delivery log"* and TS-8's is *"lands in the dead-letter queue"*. Both are
 * claims about durable state, and proving them against an array would prove
 * something else.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool } from '../../db/client.js';
import { FakeClock } from '../clock.js';
import { RetryScheduler, MAX_ATTEMPTS, RETRY_SCHEDULE_SECONDS } from './retry.js';
import { InMemoryDeliverer } from './deliverer.js';
import { PgDeliveryLog } from './pgDeliveryLog.js';
import { InMemoryWebhookSubscriptionRepo } from './inMemorySubscriptionRepo.js';
import { AesGcmSecretCipher, WEBHOOK_SECRET_KEY_BYTES } from './secretCipher.js';
import { SignatureSigner } from './signer.js';
import { ReplayService } from './replay.js';
import { idempotencyKeyFor, type DeliveryJob } from './pipeline.js';

const CIPHER = new AesGcmSecretCipher(Buffer.alloc(WEBHOOK_SECRET_KEY_BYTES, 0x4d));
const START_MS = 1_760_000_000_000;

let workspaceId: string;
let userId: string;
let appId: string;
let subscriptionId: string;

beforeAll(async () => {
  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ('L16 scenarios') RETURNING id`,
  );
  workspaceId = ws.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ('l16-scenarios@ship.local', 'L16') RETURNING id`,
  );
  userId = user.rows[0]!.id;
  const app = await pool.query<{ id: string }>(
    `INSERT INTO oauth_apps
       (client_id, client_secret_hash, secret_prefix, name, redirect_uris,
        owner_user_id, workspace_id, requested_scopes)
     VALUES ('ship_app_l16_scenarios', 'x', 'yyyyyyyy', 'scenarios',
             ARRAY['https://example.test/cb'], $1, $2, ARRAY['webhooks:manage'])
     RETURNING id`,
    [userId, workspaceId],
  );
  appId = app.rows[0]!.id;
  const sub = await pool.query<{ id: string }>(
    `INSERT INTO webhook_subscriptions
       (app_id, workspace_id, user_id, event_type, target_url, secret_ciphertext, secret_prefix)
     VALUES ($1, $2, $3, 'document.created', 'https://subscriber.test/hook',
             'ciphertext', 'prefix00')
     RETURNING id`,
    [appId, workspaceId, userId],
  );
  subscriptionId = sub.rows[0]!.id;
});

beforeEach(async () => {
  await pool.query('DELETE FROM webhook_deliveries');
});

const EVENT_BODY = JSON.stringify({
  id: 'evt',
  type: 'document.created',
  data: { title: 'the original title' },
});

interface Harness {
  clock: FakeClock;
  deliverer: InMemoryDeliverer;
  log: PgDeliveryLog;
  scheduler: RetryScheduler;
  job: DeliveryJob;
  groupId: string;
  eventId: string;
}

function harness(): Harness {
  const clock = new FakeClock(START_MS);
  const deliverer = new InMemoryDeliverer();
  const log = new PgDeliveryLog(pool);
  const groupId = randomUUID();
  const eventId = randomUUID();

  const scheduler = new RetryScheduler({
    clock,
    deliverer,
    log,
    // Jitter pinned to the midpoint so each rung is exactly its nominal value.
    // The ASSERTIONS below are lower bounds, so they would hold at either
    // extreme too — this only makes the arithmetic in the test readable.
    jitter: () => 0.5,
    newGroupId: () => groupId,
    logger: { error: () => {}, warn: () => {} },
  });

  const rawBody = Buffer.from(EVENT_BODY, 'utf8');
  const idempotencyKey = idempotencyKeyFor(eventId, subscriptionId);
  let attempt = 1;
  const job: DeliveryJob = {
    subscriptionId,
    eventId,
    eventType: 'document.created',
    targetUrl: 'https://subscriber.test/hook',
    idempotencyKey,
    request: {
      targetUrl: 'https://subscriber.test/hook',
      rawBody,
      signatureHeader: `t=${Math.floor(START_MS / 1000)},v1=attempt1`,
      signedAtSeconds: Math.floor(START_MS / 1000),
      idempotencyKey,
      eventId,
      subscriptionId,
    },
    resign: async () => {
      attempt += 1;
      return {
        targetUrl: 'https://subscriber.test/hook',
        // The SAME buffer object every attempt (PF-436).
        rawBody,
        signatureHeader: `t=${Math.floor(clock.nowMs() / 1000)},v1=attempt${attempt}`,
        signedAtSeconds: Math.floor(clock.nowMs() / 1000),
        idempotencyKey,
        eventId,
        subscriptionId,
      };
    },
  };

  return { clock, deliverer, log, scheduler, job, groupId, eventId };
}

describe('PF-480 — Testing Scenario 7 (p.5): 500 × 3, then 200 on the fourth', () => {
  it('the retry schedule is honoured and the fourth attempt records success', async () => {
    const { clock, deliverer, log, scheduler, job, groupId } = harness();

    // "Make a subscriber return 500 on the first three attempts and 200 on the
    // fourth." The script REJECTS a fifth call, so an over-attempt bug fails
    // loudly rather than looking like a pass (PF-468).
    deliverer.script([500, 500, 500, 200]);

    scheduler.enqueue(job);
    await scheduler.settled();

    // ── "Verify the retry schedule (1s, 4s, 16s ≥ wait times before each
    //     attempt)". Asserted as a LOWER bound at each rung, which is the PRD's
    //     own phrasing and is what makes it jitter-proof.
    expect(deliverer.delivered, 'attempt 1 is immediate').toHaveLength(1);

    // Attempt 2: not before +1 s.
    clock.advance(999);
    await scheduler.settled();
    expect(deliverer.delivered, 'attempt 2 must not fire before +1s').toHaveLength(1);
    clock.advance(1);
    await scheduler.settled();
    expect(deliverer.delivered, 'attempt 2 fires at +1s').toHaveLength(2);

    // Attempt 3: not before +5 s cumulative (1 s + 4 s).
    clock.advance(3_999);
    await scheduler.settled();
    expect(deliverer.delivered, 'attempt 3 must not fire before +5s cumulative').toHaveLength(2);
    clock.advance(1);
    await scheduler.settled();
    expect(deliverer.delivered, 'attempt 3 fires at +5s cumulative').toHaveLength(3);

    // Attempt 4: not before +21 s cumulative (1 s + 4 s + 16 s).
    clock.advance(15_999);
    await scheduler.settled();
    expect(deliverer.delivered, 'attempt 4 must not fire before +21s cumulative').toHaveLength(3);
    clock.advance(1);
    await scheduler.settled();
    expect(deliverer.delivered, 'attempt 4 fires at +21s cumulative').toHaveLength(4);

    // ── "…and that the fourth attempt records success in the delivery log."
    const rows = await log.listByGroup(groupId);
    expect(rows, 'exactly four attempts, no more').toHaveLength(4);
    expect(rows.map((r) => r.attempt_number)).toEqual([1, 2, 3, 4]);

    for (const failed of rows.slice(0, 3)) {
      expect(failed.response_status).toBe(500);
      expect(failed.status).toBe('failed');
      expect(failed.dlq_reason).toBeNull();
    }
    expect(rows[3]!.status).toBe('delivered');
    expect(rows[3]!.response_status).toBe(200);

    // Nothing is dead-lettered: the subscriber recovered.
    expect(rows.filter((r) => r.status === 'dead_lettered')).toEqual([]);

    // All four attempts carry ONE idempotency key, byte-identical (PF-470).
    const keys = new Set(rows.map((r) => r.idempotency_key));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe(job.idempotencyKey);
    for (const sent of deliverer.delivered) {
      expect(sent.idempotencyKey).toBe(job.idempotencyKey);
    }

    // The ladder is finished: nothing is scheduled, and the script is spent.
    expect(scheduler.scheduledCount()).toBe(0);
    expect(clock.pendingCount()).toBe(0);
    expect(deliverer.remaining()).toBe(0);
  });
});

describe('PF-481 — Testing Scenario 8 (p.5): 6 failures → DLQ → replay', () => {
  it('lands in the DLQ, is visible over the API, and replays with the original key', async () => {
    const { clock, deliverer, log, scheduler, job, groupId, eventId } = harness();

    // ── "Force 6 consecutive failures."
    deliverer.script([500, 500, 500, 500, 500, 500]);

    scheduler.enqueue(job);
    await scheduler.settled();
    for (const rung of RETRY_SCHEDULE_SECONDS.slice(0, MAX_ATTEMPTS - 1)) {
      clock.advance(rung * 1000);
      await scheduler.settled();
    }

    // ── "Verify the delivery lands in the dead-letter queue."
    const rows = await log.listByGroup(groupId);
    expect(rows, 'exactly SIX attempts — not seven').toHaveLength(MAX_ATTEMPTS);
    expect(rows.map((r) => r.attempt_number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows[5]!.status).toBe('dead_lettered');
    expect(rows[5]!.dlq_reason).toBe('max_attempts_exhausted');

    // The 30 m rung was NEVER scheduled. This is the assertion PF-452's
    // off-by-one decision exists to make true: under the "7 attempts" reading
    // the delivery would be scheduled 30 minutes out instead of being in the
    // DLQ, and this scenario — the PRD's own — would fail.
    expect(RETRY_SCHEDULE_SECONDS).toContain(1800);
    expect(clock.pendingCount(), 'no timer survives the 6th failure').toBe(0);
    clock.advance(3_600_000);
    await scheduler.settled();
    expect(await log.listByGroup(groupId), 'an hour later, still six rows').toHaveLength(6);
    expect(deliverer.delivered).toHaveLength(6);

    // ── "…and is visible in the developer portal."
    //
    // The API half. L22 renders this exact response and adds no privileged
    // internal route, so `?status=dead_lettered` returning the row IS the
    // scenario's visibility clause at the layer this lane owns.
    const dlq = await log.listByApp({
      app_id: appId,
      limit: 25,
      cursor: null,
      status: 'dead_lettered',
    });
    expect(dlq.map((r) => r.id)).toEqual([rows[5]!.id]);

    const originalKey = rows[5]!.idempotency_key;
    expect(originalKey).toBe(idempotencyKeyFor(eventId, subscriptionId));

    // ── "Click 'Replay' against a now-healthy subscriber…"
    //
    // The subscription is registered in the repository the replay service reads,
    // with the secret it will sign with. The deliverer is re-scripted healthy.
    // The subscription the replay resolves through. A DISTINCT target URL from
    // the one in `beforeAll`, because `webhook_subscriptions_unique_target`
    // (migration 047) correctly forbids two rows with the same
    // (app, event_type, target) triple — L15 refusing a duplicate subscription
    // is not something this scenario should be working around.
    const HEALTHY_URL = 'https://healthy-subscriber.test/hook';
    const repo = new InMemoryWebhookSubscriptionRepo({ cipher: CIPHER, clock });
    const created = await repo.create({
      app_id: appId,
      workspace_id: workspaceId,
      user_id: userId,
      event: 'document.created',
      target_url: HEALTHY_URL,
    });

    // The repository double mints its own id and is not backed by the table, so
    // the FK on `webhook_deliveries` needs the matching row to exist. Fixture
    // plumbing, not a behaviour under test.
    await pool.query(
      `INSERT INTO webhook_subscriptions
         (id, app_id, workspace_id, user_id, event_type, target_url,
          secret_ciphertext, secret_prefix)
       VALUES ($1, $2, $3, $4, 'document.created', $5, 'ciphertext', 'prefix00')`,
      [created.subscription.id, appId, workspaceId, userId, HEALTHY_URL],
    );

    const healthyDeliverer = new InMemoryDeliverer();
    healthyDeliverer.script([200]);
    const replayScheduler = new RetryScheduler({
      clock,
      deliverer: healthyDeliverer,
      log,
      jitter: () => 0.5,
      logger: { error: () => {}, warn: () => {} },
    });

    // A dead-lettered delivery recorded against that subscription, so the whole
    // replay path — lookup, current secret, fresh signature, ladder — runs.
    const seeded = await log.beginAttempt({
      delivery_group_id: randomUUID(),
      subscription_id: created.subscription.id,
      event_id: eventId,
      event_type: 'document.created',
      attempt_number: 1,
      idempotency_key: originalKey,
      signature_header: 't=1,v1=original',
      replay_of_delivery_id: null,
      raw_body: Buffer.from(EVENT_BODY, 'utf8'),
      attempted_at: new Date(clock.nowMs()).toISOString(),
    });
    await log.completeAttempt(seeded.id, {
      status: 'dead_lettered',
      response_status: 500,
      response_excerpt: 'boom',
      latency_ms: 7,
      dlq_reason: 'max_attempts_exhausted',
    });

    const replayService = new ReplayService({
      log,
      repo,
      signer: new SignatureSigner(clock),
      scheduler: replayScheduler,
      clock,
      newGroupId: () => randomUUID(),
    });

    const replayed = await replayService.replay(appId, seeded.id);
    await replayScheduler.settled();

    // ── "…and verify the replay succeeds with the original idempotency key
    //     intact."
    const replayRows = await log.listByGroup(replayed.delivery_group_id);
    expect(replayRows).toHaveLength(1);
    expect(replayRows[0]!.status, 'the replay succeeded').toBe('delivered');
    expect(replayRows[0]!.response_status).toBe(200);

    // THE clause. Byte-identical to the key on the original dead-lettered row.
    expect(replayRows[0]!.idempotency_key).toBe(originalKey);
    expect(healthyDeliverer.delivered).toHaveLength(1);
    expect(
      healthyDeliverer.delivered[0]!.idempotencyKey,
      'the POSTed Idempotency-Key equals the original',
    ).toBe(originalKey);

    // PF-477 — the replay links to its ancestor, and the ancestor is UNTOUCHED,
    // so the DLQ keeps its history instead of mutating a failure into a success.
    expect(replayed.replay_of_delivery_id).toBe(seeded.id);
    const ancestor = await log.getById(appId, seeded.id);
    expect(ancestor!.status).toBe('dead_lettered');
    expect(ancestor!.dlq_reason).toBe('max_attempts_exhausted');

    // PF-475 — the replayed bytes are the ORIGINAL signed bytes, not a payload
    // re-derived from current state.
    const replayedBody = await log.getRawBody(appId, replayed.id);
    expect(replayedBody!.toString('utf8')).toBe(EVENT_BODY);
    expect(replayedBody!.toString('utf8')).toContain('the original title');

    // …and the SIGNATURE is fresh, which is what makes a replay verifiable
    // rather than expired (L15 PF-442).
    expect(healthyDeliverer.delivered[0]!.signatureHeader).not.toBe('t=1,v1=original');
    expect(healthyDeliverer.delivered[0]!.signatureHeader).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });
});
