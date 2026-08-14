/**
 * PF-458–PF-463 — the delivery log contract, run against BOTH implementations,
 * plus the assertions only a real database can make.
 *
 * `InMemoryDeliveryLog` and `PgDeliveryLog` are a Liskov pair, and a pair is
 * only a pair if something checks. The in-memory double is what the scheduler
 * tests and Testing Scenarios 7 and 8 build against; if it disagrees with
 * Postgres about ordering, about app scoping, or about whether a second
 * completion is allowed, those scenarios pass and production does not.
 *
 * The suite is written ONCE and parameterised over a factory. Anything that can
 * only hold against Postgres — the CHECK constraints, the unique index, the
 * column list, the `EXPLAIN` plan — is in its own block at the bottom.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { pool } from '../../db/client.js';
import {
  DuplicateAttemptError,
  InMemoryDeliveryLog,
  DELIVERY_STATUSES,
  DLQ_REASONS,
  type BeginAttemptInput,
  type IDeliveryLog,
} from './deliveryLog.js';
import { PgDeliveryLog, firstAttemptLatencyP95Ms } from './pgDeliveryLog.js';

let workspaceId: string;
let userId: string;
let appA: string;
let appB: string;
let subA: string;
let subA2: string;
let subB: string;

const RAW_BODY = Buffer.from('{"id":"e1","type":"document.created"}', 'utf8');

beforeAll(async () => {
  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ('L16 log workspace') RETURNING id`,
  );
  workspaceId = ws.rows[0]!.id;

  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ('l16-log@ship.local', 'L16') RETURNING id`,
  );
  userId = user.rows[0]!.id;

  const app = async (clientId: string) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO oauth_apps
         (client_id, client_secret_hash, secret_prefix, name, redirect_uris,
          owner_user_id, workspace_id, requested_scopes)
       VALUES ($1, 'x', 'yyyyyyyy', $1, ARRAY['https://example.test/cb'], $2, $3,
               ARRAY['webhooks:manage'])
       RETURNING id`,
      [clientId, userId, workspaceId],
    );
    return r.rows[0]!.id;
  };
  appA = await app('ship_app_l16_a');
  appB = await app('ship_app_l16_b');

  const sub = async (appId: string, target: string, event = 'document.created') => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO webhook_subscriptions
         (app_id, workspace_id, user_id, event_type, target_url,
          secret_ciphertext, secret_prefix)
       VALUES ($1, $2, $3, $4, $5, 'ciphertext', 'prefix00')
       RETURNING id`,
      [appId, workspaceId, userId, event, target],
    );
    return r.rows[0]!.id;
  };
  subA = await sub(appA, 'https://a.test/hook');
  subA2 = await sub(appA, 'https://a2.test/hook', 'document.updated');
  subB = await sub(appB, 'https://b.test/hook');
});

beforeEach(async () => {
  await pool.query('DELETE FROM webhook_deliveries');
});

/** subscription id → owning app id, which is the join the Postgres log does. */
const appIdFor = (subscriptionId: string): string => (subscriptionId === subB ? appB : appA);

interface Fixture {
  name: string;
  make(): IDeliveryLog;
}

const FIXTURES: Fixture[] = [
  { name: 'InMemoryDeliveryLog', make: () => new InMemoryDeliveryLog(appIdFor) },
  { name: 'PgDeliveryLog', make: () => new PgDeliveryLog(pool) },
];

let groupSeq = 0;
const nextGroup = (): string => {
  groupSeq += 1;
  return `aaaaaaaa-0000-4000-8000-${String(groupSeq).padStart(12, '0')}`;
};

let eventSeq = 0;
/**
 * A fresh event id per delivery unless a test pins one.
 *
 * Not a constant, because migration 051's partial unique index
 * `(subscription_id, event_id, attempt_number) WHERE replay_of_delivery_id IS
 * NULL` correctly refuses two original attempt-1 rows for the same event to the
 * same subscription — which is PF-462 doing its job. A fixture that reused one
 * event id was asserting against a schema violation, not against a page.
 */
const nextEvent = (): string => {
  eventSeq += 1;
  return `99999999-9999-4999-8999-${String(eventSeq).padStart(12, '0')}`;
};

function attempt(overrides: Partial<BeginAttemptInput> = {}): BeginAttemptInput {
  return {
    delivery_group_id: overrides.delivery_group_id ?? nextGroup(),
    subscription_id: subA,
    event_id: nextEvent(),
    event_type: 'document.created',
    attempt_number: 1,
    idempotency_key: 'evt-1:sub-a',
    signature_header: 't=1000,v1=deadbeef',
    replay_of_delivery_id: null,
    raw_body: RAW_BODY,
    attempted_at: '2026-08-13T12:00:00.000000Z',
    ...overrides,
  };
}

describe.each(FIXTURES)('the delivery log contract — $name', ({ make }) => {
  it('PF-459 — beginAttempt records in_flight with no outcome yet', async () => {
    const log = make();
    const row = await log.beginAttempt(attempt());

    expect(row.status).toBe('in_flight');
    expect(row.response_status).toBeNull();
    expect(row.response_excerpt).toBeNull();
    expect(row.latency_ms).toBeNull();
    expect(row.dlq_reason).toBeNull();
    expect(row.attempt_number).toBe(1);
    expect(row.idempotency_key).toBe('evt-1:sub-a');
    expect(row.signature_header).toBe('t=1000,v1=deadbeef');
    // `created_at` mirrors `attempted_at` so L08's KeysetRow contract holds.
    expect(row.created_at).toBe(row.attempted_at);
  });

  it('completeAttempt writes the outcome and returns the updated row', async () => {
    const log = make();
    const row = await log.beginAttempt(attempt());
    const done = await log.completeAttempt(row.id, {
      status: 'delivered',
      response_status: 200,
      response_excerpt: 'ok',
      latency_ms: 42,
      dlq_reason: null,
    });

    expect(done.id).toBe(row.id);
    expect(done.status).toBe('delivered');
    expect(done.response_status).toBe(200);
    expect(done.latency_ms).toBe(42);
  });

  it('a second completion is refused — a terminal fact is not rewritten', async () => {
    const log = make();
    const row = await log.beginAttempt(attempt());
    await log.completeAttempt(row.id, {
      status: 'delivered',
      response_status: 200,
      response_excerpt: null,
      latency_ms: 1,
      dlq_reason: null,
    });

    await expect(
      log.completeAttempt(row.id, {
        status: 'dead_lettered',
        response_status: 500,
        response_excerpt: null,
        latency_ms: 1,
        dlq_reason: 'max_attempts_exhausted',
      }),
    ).rejects.toThrow();
  });

  it('PF-462 — a duplicate (group, attempt) raises DuplicateAttemptError', async () => {
    const log = make();
    const group = nextGroup();
    await log.beginAttempt(attempt({ delivery_group_id: group, attempt_number: 3 }));

    await expect(
      log.beginAttempt(attempt({ delivery_group_id: group, attempt_number: 3 })),
    ).rejects.toBeInstanceOf(DuplicateAttemptError);
  });

  it('PF-462 — a REPLAY may restart at attempt 1 for the same event', async () => {
    // The reason the constraint is keyed on the group and not on p.4's triple:
    // a replay is a new ladder against the same (subscription, event), so the
    // literal reading would refuse the feature the PRD asks for.
    const log = make();
    // The SAME event id on purpose — that is the collision the partial index
    // has to allow through for a replay and refuse for a second original.
    const eventId = nextEvent();
    const original = await log.beginAttempt(attempt({ attempt_number: 1, event_id: eventId }));
    const replay = await log.beginAttempt(
      attempt({ attempt_number: 1, event_id: eventId, replay_of_delivery_id: original.id }),
    );

    expect(replay.id).not.toBe(original.id);
    expect(replay.replay_of_delivery_id).toBe(original.id);
    expect(replay.delivery_group_id).not.toBe(original.delivery_group_id);
  });

  it('PF-463 — listByApp returns only the calling app\'s rows', async () => {
    const log = make();
    await log.beginAttempt(attempt({ subscription_id: subA }));
    await log.beginAttempt(attempt({ subscription_id: subB }));

    const mine = await log.listByApp({ app_id: appA, limit: 25, cursor: null });
    const theirs = await log.listByApp({ app_id: appB, limit: 25, cursor: null });

    expect(mine).toHaveLength(1);
    expect(mine[0]!.subscription_id).toBe(subA);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.subscription_id).toBe(subB);
  });

  it('listByApp is newest-first and honours limit', async () => {
    const log = make();
    for (const [i, ts] of ['12:00:00', '12:00:01', '12:00:02'].entries()) {
      await log.beginAttempt(
        attempt({ attempted_at: `2026-08-13T${ts}.000000Z`, idempotency_key: `k${i}` }),
      );
    }
    const page = await log.listByApp({ app_id: appA, limit: 2, cursor: null });
    expect(page).toHaveLength(2);
    expect(page[0]!.attempted_at > page[1]!.attempted_at).toBe(true);
    expect(page[0]!.idempotency_key).toBe('k2');
  });

  it('the cursor resumes exactly after the last row, with no overlap and no gap', async () => {
    const log = make();
    const written = [];
    for (let i = 0; i < 5; i += 1) {
      written.push(
        await log.beginAttempt(
          attempt({ attempted_at: `2026-08-13T12:00:0${i}.000000Z`, idempotency_key: `k${i}` }),
        ),
      );
    }
    const first = await log.listByApp({ app_id: appA, limit: 2, cursor: null });
    const second = await log.listByApp({
      app_id: appA,
      limit: 2,
      cursor: { timestamp: first[1]!.attempted_at, id: first[1]!.id },
    });
    const walked = [...first, ...second].map((r) => r.idempotency_key);
    expect(walked).toEqual(['k4', 'k3', 'k2', 'k1']);
    expect(new Set(walked).size).toBe(4);
  });

  it('PF-464 — status, subscription_id and event_type all filter, and they AND', async () => {
    const log = make();
    const dead = await log.beginAttempt(attempt({ subscription_id: subA }));
    await log.completeAttempt(dead.id, {
      status: 'dead_lettered',
      response_status: 500,
      response_excerpt: null,
      latency_ms: 5,
      dlq_reason: 'max_attempts_exhausted',
    });
    const live = await log.beginAttempt(
      attempt({ subscription_id: subA2, event_type: 'document.updated' }),
    );
    await log.completeAttempt(live.id, {
      status: 'delivered',
      response_status: 200,
      response_excerpt: null,
      latency_ms: 5,
      dlq_reason: null,
    });

    const dlq = await log.listByApp({
      app_id: appA,
      limit: 25,
      cursor: null,
      status: 'dead_lettered',
    });
    expect(dlq).toHaveLength(1);
    expect(dlq[0]!.id).toBe(dead.id);

    const byType = await log.listByApp({
      app_id: appA,
      limit: 25,
      cursor: null,
      event_type: 'document.updated',
    });
    expect(byType.map((r) => r.id)).toEqual([live.id]);

    // AND, not OR: a dead-lettered row of a DIFFERENT event type matches neither.
    const both = await log.listByApp({
      app_id: appA,
      limit: 25,
      cursor: null,
      status: 'dead_lettered',
      event_type: 'document.updated',
    });
    expect(both).toEqual([]);
  });

  it('PF-478 — getById and getRawBody are app-scoped, so a foreign id is null', async () => {
    const log = make();
    const row = await log.beginAttempt(attempt({ subscription_id: subA }));

    expect((await log.getById(appA, row.id))?.id).toBe(row.id);
    // Not "forbidden with a body" — literally nothing. A repository that cannot
    // return a row it was not asked for makes PF-478 structural.
    expect(await log.getById(appB, row.id)).toBeNull();
    expect(await log.getRawBody(appB, row.id)).toBeNull();
  });

  it('PF-475 — getRawBody returns the exact signed bytes, unchanged', async () => {
    const log = make();
    const row = await log.beginAttempt(attempt());
    const body = await log.getRawBody(appA, row.id);
    expect(body).not.toBeNull();
    expect(Buffer.compare(body!, RAW_BODY)).toBe(0);
  });

  it('listByGroup returns one ladder, oldest attempt first', async () => {
    const log = make();
    const group = nextGroup();
    for (const n of [1, 2, 3]) {
      const row = await log.beginAttempt(
        attempt({ delivery_group_id: group, attempt_number: n }),
      );
      await log.completeAttempt(row.id, {
        status: n === 3 ? 'delivered' : 'failed',
        response_status: n === 3 ? 200 : 500,
        response_excerpt: null,
        latency_ms: 1,
        dlq_reason: null,
      });
    }
    const rows = await log.listByGroup(group);
    expect(rows.map((r) => r.attempt_number)).toEqual([1, 2, 3]);
  });

  it('PF-472 — keyUsage counts attempts and lists distinct terminal statuses', async () => {
    const log = make();
    const group = nextGroup();
    for (const n of [1, 2]) {
      const row = await log.beginAttempt(
        attempt({ delivery_group_id: group, attempt_number: n, idempotency_key: 'shared-key' }),
      );
      await log.completeAttempt(row.id, {
        status: n === 2 ? 'delivered' : 'failed',
        response_status: n === 2 ? 200 : 500,
        response_excerpt: null,
        latency_ms: 1,
        dlq_reason: null,
      });
    }

    const usage = await log.keyUsage(appA, 'shared-key');
    expect(usage.attempt_count).toBe(2);
    expect(usage.terminal_statuses).toEqual(['delivered', 'failed']);

    // The honest residual, asserted so it is not forgotten: this counts what WE
    // sent. It cannot say whether the subscriber processed it twice.
    const unknown = await log.keyUsage(appA, 'never-sent');
    expect(unknown.attempt_count).toBe(0);
    expect(unknown.terminal_statuses).toEqual([]);
  });

  it('PF-484 — findResumable returns in_flight ladders with their bytes', async () => {
    const log = make();
    const hanging = await log.beginAttempt(attempt({ attempt_number: 2 }));
    const done = await log.beginAttempt(attempt({ attempt_number: 1 }));
    await log.completeAttempt(done.id, {
      status: 'delivered',
      response_status: 200,
      response_excerpt: null,
      latency_ms: 1,
      dlq_reason: null,
    });

    const resumable = await log.findResumable();
    expect(resumable.map((r) => r.record.id)).toEqual([hanging.id]);
    expect(Buffer.compare(resumable[0]!.raw_body, RAW_BODY)).toBe(0);
  });

  it('PF-483 — prune deletes old rows but NEVER an unreplayed DLQ row', async () => {
    const log = make();
    const old = await log.beginAttempt(attempt({ attempted_at: '2026-01-01T00:00:00.000000Z' }));
    await log.completeAttempt(old.id, {
      status: 'delivered',
      response_status: 200,
      response_excerpt: null,
      latency_ms: 1,
      dlq_reason: null,
    });
    const oldDead = await log.beginAttempt(
      attempt({ attempted_at: '2026-01-01T00:00:00.000000Z' }),
    );
    await log.completeAttempt(oldDead.id, {
      status: 'dead_lettered',
      response_status: 500,
      response_excerpt: null,
      latency_ms: 1,
      dlq_reason: 'max_attempts_exhausted',
    });

    const deleted = await log.prune('2026-06-01T00:00:00.000000Z');
    expect(deleted).toBe(1);

    const left = await log.listByApp({ app_id: appA, limit: 25, cursor: null });
    // Deleting the DLQ is deleting the thing the portal exists to show.
    expect(left.map((r) => r.id)).toEqual([oldDead.id]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Only against Postgres: the schema itself.
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-458 — migration 051 ships the columns the PRD\'s requirements need', () => {
  it('every column exists with the stated nullability', async () => {
    const result = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'webhook_deliveries'
        ORDER BY column_name`,
    );
    const nullability = Object.fromEntries(
      result.rows.map((r) => [r.column_name, r.is_nullable === 'YES']),
    );

    // p.4's six, and each of ours with the requirement it serves. `true` =
    // nullable. `response_status` is nullable because a timeout has no status;
    // `latency_ms` and `response_excerpt` because an attempt that never
    // completed has neither.
    expect(nullability).toEqual({
      id: false,
      delivery_group_id: false,
      subscription_id: false,
      app_id: false,
      event_id: false,
      event_type: false,
      attempt_number: false,
      status: false,
      response_status: true,
      response_excerpt: true,
      latency_ms: true,
      idempotency_key: false,
      dlq_reason: true,
      attempted_at: false,
      raw_body: false,
      signature_header: true,
      replay_of_delivery_id: true,
    });
  });

  it('the FK to webhook_subscriptions cascades', async () => {
    const result = await pool.query<{ delete_rule: string; foreign_table: string }>(
      `SELECT rc.delete_rule, ccu.table_name AS foreign_table
         FROM information_schema.referential_constraints rc
         JOIN information_schema.table_constraints tc
           ON tc.constraint_name = rc.constraint_name
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = rc.constraint_name
        WHERE tc.table_name = 'webhook_deliveries'
          AND ccu.table_name = 'webhook_subscriptions'`,
    );
    expect(result.rows[0]?.delete_rule).toBe('CASCADE');
  });

  it('PF-460 — the excerpt CHECK fails at the DATABASE, not in a code path', async () => {
    // The whole point of the constraint: a deliverer that forgets to truncate
    // must not be able to store a megabyte of someone's HTML error page per
    // attempt. At 6 attempts times p.9's fanout that is the storage line item.
    const log = new PgDeliveryLog(pool);
    const row = await log.beginAttempt(attempt());
    // Completed first: an in_flight row is forbidden from carrying ANY outcome,
    // so testing the excerpt cap against one would trip the wrong constraint.
    await log.completeAttempt(row.id, {
      status: 'delivered',
      response_status: 200,
      response_excerpt: 'ok',
      latency_ms: 1,
      dlq_reason: null,
    });

    await expect(
      pool.query(`UPDATE webhook_deliveries SET response_excerpt = $1 WHERE id = $2`, [
        'x'.repeat(281),
        row.id,
      ]),
    ).rejects.toThrow(/response_excerpt/);

    // 280 is accepted — the cap is 256 chars of body plus room for a marker.
    await expect(
      pool.query(`UPDATE webhook_deliveries SET response_excerpt = $1 WHERE id = $2`, [
        'x'.repeat(280),
        row.id,
      ]),
    ).resolves.toBeTruthy();
  });

  it('an in_flight row cannot carry an outcome, and a DLQ row must carry a reason', async () => {
    const log = new PgDeliveryLog(pool);
    const row = await log.beginAttempt(attempt());

    await expect(
      pool.query(`UPDATE webhook_deliveries SET response_status = 200 WHERE id = $1`, [row.id]),
    ).rejects.toThrow(/in_flight_has_no_outcome/);

    await expect(
      pool.query(
        `UPDATE webhook_deliveries SET status = 'dead_lettered', dlq_reason = NULL WHERE id = $1`,
        [row.id],
      ),
    ).rejects.toThrow(/dlq_reason_coherent/);
  });

  it('the status and dlq_reason CHECKs enumerate exactly the TypeScript unions', async () => {
    // Two places that must agree: a widened union with an un-widened CHECK is a
    // 500 at runtime, and a widened CHECK with an un-widened union is a value
    // nothing can read.
    const result = await pool.query<{ check_clause: string }>(
      `SELECT cc.check_clause
         FROM information_schema.check_constraints cc
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = cc.constraint_name
        WHERE ccu.table_name = 'webhook_deliveries'`,
    );
    const clauses = result.rows.map((r) => r.check_clause).join(' ');
    for (const status of DELIVERY_STATUSES) expect(clauses).toContain(`'${status}'`);
    for (const reason of DLQ_REASONS) expect(clauses).toContain(`'${reason}'`);
  });

  it('PF-462 — the partial unique index pins one row per attempt of an ORIGINAL', async () => {
    const result = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'webhook_deliveries'
          AND indexname = 'idx_webhook_deliveries_original_attempt'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.indexdef).toContain('UNIQUE');
    expect(result.rows[0]!.indexdef).toContain('subscription_id, event_id, attempt_number');
    expect(result.rows[0]!.indexdef).toContain('replay_of_delivery_id IS NULL');
  });

  it('PF-463 — the per-app page plans as an index scan, with no Seq Scan and no Sort', async () => {
    // A small table makes Postgres prefer a seq scan whatever the index says —
    // finding F44 is exactly that failure, and it flaked for L09 for days. Seed
    // enough rows that the index is the cheaper plan, and assert against the
    // REAL page predicate rather than a simplified one.
    //
    // Seeded with ONE `generate_series` INSERT rather than 400 `beginAttempt`
    // round trips. The rows here are a PLANNER FIXTURE, not a contract
    // assertion — `beginAttempt`'s behaviour is already proven by the contract
    // suite above — and 400 sequential round trips took the test past vitest's
    // 5 s default under a loaded database, which is a timeout that reads as a
    // planner failure.
    await pool.query(
      `INSERT INTO webhook_deliveries (
         delivery_group_id, subscription_id, app_id, event_id, event_type,
         attempt_number, status, idempotency_key, attempted_at, raw_body
       )
       SELECT gen_random_uuid(), $1, $2, gen_random_uuid(), 'document.created',
              1, 'delivered', 'bulk-' || i,
              TIMESTAMPTZ '2026-01-01 00:00:00Z' + (i * INTERVAL '1 second'),
              $3
         FROM generate_series(0, 399) AS i`,
      [subA, appA, RAW_BODY],
    );
    await pool.query('ANALYZE webhook_deliveries');

    const plan = await pool.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT id, attempted_at
         FROM webhook_deliveries
        WHERE app_id = $1
          AND (attempted_at, id) < ($2::timestamptz, $3::uuid)
        ORDER BY attempted_at DESC, id DESC
        LIMIT 25`,
      [appA, '2026-01-01T00:05:00.000000Z', '99999999-9999-4999-8999-999999999999'],
    );
    const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(text, text).not.toMatch(/Seq Scan on webhook_deliveries/);
    // No Sort node either: the index already delivers the rows in the ORDER BY's
    // order, which is what makes the page O(1) at depth rather than O(n).
    expect(text, text).not.toMatch(/^\s*(->\s*)?Sort/m);
    expect(text, text).toMatch(/Index (Only )?Scan.*idx_webhook_deliveries_keyset/);
  });

  it('PF-461 — the P95 first-attempt latency is computable from the column', async () => {
    // p.6: "Webhook delivery latency (P95, first attempt) < 2s". A target no
    // query can evaluate is not a target.
    const log = new PgDeliveryLog(pool);
    expect(await firstAttemptLatencyP95Ms(pool)).toBeNull();

    // 100 first attempts with latencies 10 … 1000 ms, in one INSERT. Same
    // reasoning as the planner fixture above: these rows exist to be
    // percentile'd, and `completeAttempt`'s behaviour is proven elsewhere.
    await pool.query(
      `INSERT INTO webhook_deliveries (
         delivery_group_id, subscription_id, app_id, event_id, event_type,
         attempt_number, status, idempotency_key, attempted_at, raw_body,
         response_status, latency_ms
       )
       SELECT gen_random_uuid(), $1, $2, gen_random_uuid(), 'document.created',
              1, 'delivered', 'p95-' || i,
              TIMESTAMPTZ '2026-02-01 00:00:00Z' + (i * INTERVAL '1 second'),
              $3, 200, i * 10
         FROM generate_series(1, 100) AS i`,
      [subA, appA, RAW_BODY],
    );
    // A retry's latency must NOT be in the population — it says nothing about
    // how fast the first delivery was.
    const retry = await log.beginAttempt(attempt({ attempt_number: 2, idempotency_key: 'noise' }));
    await log.completeAttempt(retry.id, {
      status: 'delivered',
      response_status: 200,
      response_excerpt: null,
      latency_ms: 900_000,
      dlq_reason: null,
    });

    const p95 = await firstAttemptLatencyP95Ms(pool);
    expect(p95).not.toBeNull();
    expect(p95!).toBeGreaterThan(900);
    expect(p95!).toBeLessThan(1000);
    expect(p95!, 'p.6 sets the first-attempt P95 target at 2 s').toBeLessThan(2000);
  });
});
