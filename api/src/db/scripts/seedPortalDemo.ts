/**
 * PF-679 / PF-680 — the developer portal's deterministic demo fixture.
 *
 * p.12's demo script ends *"Then switch to the dev portal and replay one
 * delivery."* The single most likely way that shot fails is an empty
 * dead-letter queue and a presenter waiting six minutes on camera for a retry
 * ladder to exhaust itself. So the DLQ is SEEDED: one subscriber that returned
 * 500 six times, written straight into the delivery log with the same
 * `delivery_group_id` and the same `idempotency_key` the real deliverer would
 * have used.
 *
 * p.13 also requires a *"pre-registered read-only OAuth app"* to be visible on
 * the deployed instance. This script registers it and prints its `client_id`.
 * It never prints or stores a recoverable `client_secret` — the raw secret is
 * generated, hashed, and dropped, because p.2 says shown exactly once and a
 * seeding script that could re-show it would make that false.
 *
 * Idempotent: running it twice reuses the app it already created rather than
 * registering a second one, so a redeploy does not fill the portal's sidebar
 * with duplicates.
 *
 *     pnpm --filter @ship/api exec tsx src/db/scripts/seedPortalDemo.ts
 */
import { randomUUID } from 'node:crypto';
import { pool } from '../client.js';
import {
  PgOAuthAppRepo,
  generateClientId,
  generateClientSecret,
  hashClientSecret,
  secretPrefix,
} from '../../platform/apps/index.js';
import { PgWebhookSubscriptionRepo } from '../../platform/webhooks/pgSubscriptionRepo.js';
import { envSecretCipher } from '../../platform/webhooks/secretCipher.js';
import { PgDeliveryLog } from '../../platform/webhooks/pgDeliveryLog.js';
import type { Scope } from '../../platform/scopes/scopes.js';

const DEMO_APP_NAME = 'Portal Demo Integration';

/** Read-only, per p.13's "pre-registered read-only OAuth app" — plus the one
 *  scope the portal itself needs to render a delivery log at all. */
const DEMO_SCOPES: Scope[] = ['documents:read', 'issues:read', 'sprints:read', 'webhooks:manage'];

async function main(): Promise<void> {
  const owner = await pool.query<{ id: string; last_workspace_id: string }>(
    `SELECT id, last_workspace_id FROM users WHERE email = 'dev@ship.local'`
  );
  if (owner.rowCount === 0) {
    throw new Error('dev@ship.local not found. Run `pnpm db:seed` first.');
  }
  const ownerUserId = owner.rows[0]!.id;

  const ws = await pool.query<{ id: string }>(
    `SELECT workspace_id AS id FROM workspace_memberships WHERE user_id = $1 LIMIT 1`,
    [ownerUserId]
  );
  const workspaceId = owner.rows[0]!.last_workspace_id ?? ws.rows[0]!.id;

  const appsRepo = new PgOAuthAppRepo(pool);

  const existing = await pool.query<{ id: string; client_id: string }>(
    `SELECT id, client_id FROM oauth_apps WHERE name = $1 AND owner_user_id = $2 LIMIT 1`,
    [DEMO_APP_NAME, ownerUserId]
  );

  let appId: string;
  let clientId: string;

  if (existing.rowCount && existing.rows[0]) {
    appId = existing.rows[0].id;
    clientId = existing.rows[0].client_id;
    console.log(`↺ Reusing existing demo app ${clientId}`);
  } else {
    // Generated, hashed, and dropped on the floor. There is deliberately no
    // path from this script to a readable secret — p.2's "never recoverable
    // thereafter" has to be true of the seeding path too, or it is not true.
    const raw = generateClientSecret();
    const app = await appsRepo.create({
      clientId: generateClientId(),
      clientSecretHash: hashClientSecret(raw),
      secretPrefix: secretPrefix(raw),
      name: DEMO_APP_NAME,
      ownerUserId,
      workspaceId,
      redirectUris: ['https://example.test/callback'],
      requestedScopes: DEMO_SCOPES,
    });
    appId = app.id;
    clientId = app.clientId;
    console.log(`✅ Registered demo app ${clientId}`);
  }

  const subsRepo = new PgWebhookSubscriptionRepo(pool, envSecretCipher());

  const existingSubs = await pool.query<{ id: string }>(
    `SELECT id FROM webhook_subscriptions WHERE app_id = $1 LIMIT 1`,
    [appId]
  );

  let subscriptionId: string;
  if (existingSubs.rowCount && existingSubs.rows[0]) {
    subscriptionId = existingSubs.rows[0].id;
    console.log('↺ Reusing existing subscription');
  } else {
    const created = await subsRepo.create({
      app_id: appId,
      workspace_id: workspaceId,
      user_id: ownerUserId,
      event: 'issue.created',
      // A host that does not resolve: the story the DLQ tells is "this
      // subscriber was never reachable", which is the honest one for a fixture.
      target_url: 'https://subscriber.invalid/hooks/ship',
    });
    subscriptionId = created.subscription.id;
    console.log('✅ Created subscription (signing secret discarded, shown once)');
  }

  const already = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM webhook_deliveries WHERE subscription_id = $1`,
    [subscriptionId]
  );
  if (Number(already.rows[0]!.n) > 0) {
    console.log(`↺ Delivery log already has ${already.rows[0]!.n} rows — leaving it alone`);
    console.log(`\nPortal: /portal/${appId}`);
    await pool.end();
    return;
  }

  const log = new PgDeliveryLog(pool);

  // One ladder: six attempts, all 500, the sixth dead-lettered. Same
  // `delivery_group_id` and same `idempotency_key` across all six — that is the
  // property Testing Scenario 8 (p.5) checks survives a replay.
  const groupId = randomUUID();
  const eventId = randomUUID();
  const idempotencyKey = randomUUID();
  const body = Buffer.from(
    JSON.stringify({ id: eventId, type: 'issue.created', data: { id: randomUUID() } })
  );
  const base = Date.now() - 60 * 60 * 1000;

  for (let attempt = 1; attempt <= 6; attempt++) {
    const attemptedAt = new Date(base + attempt * 60_000).toISOString();
    const row = await log.beginAttempt({
      delivery_group_id: groupId,
      subscription_id: subscriptionId,
      event_id: eventId,
      event_type: 'issue.created',
      attempt_number: attempt,
      idempotency_key: idempotencyKey,
      signature_header: `t=${Math.floor(new Date(attemptedAt).getTime() / 1000)},v1=seeded`,
      replay_of_delivery_id: null,
      raw_body: body,
      attempted_at: attemptedAt,
    });
    await log.completeAttempt(row.id, {
      status: attempt === 6 ? 'dead_lettered' : 'failed',
      response_status: 500,
      response_excerpt: '{"error":"upstream unavailable"}',
      latency_ms: 120 + attempt,
      dlq_reason: attempt === 6 ? 'max_attempts_exhausted' : null,
    });
  }
  console.log('✅ Seeded a six-attempt ladder ending in the dead-letter queue');

  // A delivered row too, so the log is not uniformly red and the status filter
  // has something to discriminate.
  const okGroup = randomUUID();
  const okEvent = randomUUID();
  const okRow = await log.beginAttempt({
    delivery_group_id: okGroup,
    subscription_id: subscriptionId,
    event_id: okEvent,
    event_type: 'document.created',
    attempt_number: 1,
    idempotency_key: randomUUID(),
    signature_header: 't=1,v1=seeded',
    replay_of_delivery_id: null,
    raw_body: Buffer.from(JSON.stringify({ id: okEvent, type: 'document.created' })),
    attempted_at: new Date(base + 10 * 60_000).toISOString(),
  });
  await log.completeAttempt(okRow.id, {
    status: 'delivered',
    response_status: 200,
    response_excerpt: 'ok',
    latency_ms: 87,
    dlq_reason: null,
  });
  console.log('✅ Seeded one delivered attempt');

  console.log(`\nPortal: /portal/${appId}`);
  console.log(`client_id: ${clientId}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
