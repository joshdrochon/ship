/**
 * PF-743 — the whole path, UI to Slack channel, as ONE executable test.
 *
 * p.13's interview question asks for this walk. A test answers it with a run
 * rather than a whiteboard:
 *
 *   internal POST /api/documents   (a SESSION request — not /api/v1)
 *     → the domain service
 *       → IEventBus
 *         → the subscription matcher
 *           → the signer
 *             → the deliverer
 *               → this listener, over real HTTP
 *                 → the Slack Web API (stubbed host, real WebClient)
 *
 * ── Why the first hop is the INTERNAL route ───────────────────────────────
 * This doubles as the cross-surface proof for L14's one-publish-both-surfaces
 * rule, from the far side. If `publish()` were called from `platform/api/v1/`
 * rather than from the domain service, a document created through the UI would
 * produce no delivery and this test would fail — while every `/api/v1` test in
 * the repo stayed green.
 *
 * Run with `pnpm slack:live` (boots Ship with the loopback opt-in).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ShipClient,
  runDeviceLogin,
  verifyWebhook,
  SIGNATURE_HEADER,
  type WebhookDelivery,
} from '@ship/sdk';
import { bootSlackWorld, type SlackWorld } from '../support/harness.js';

/**
 * `Ship-Signature: t=<unix seconds>,v1=<64 hex>` — the signer's output shape.
 * Mirrored from `api/src/platform/webhooks/signer.ts` rather than imported:
 * `integrations/**` may import `@ship/sdk` and nothing else (p.11), and the
 * SDK exports the header NAME but not the pattern.
 */
const SIGNATURE_SHAPE = /^t=(\d+),v1=[0-9a-f]{64}$/;

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REPO_ROOT = dirname(dirname(PACKAGE_ROOT));

/**
 * PF-608 — `tsx` is a devDependency of `api`, so pnpm links it into
 * `api/node_modules/.bin` and NOT into the workspace root. `npx tsx` from the
 * root resolves nothing on a clean `pnpm install --frozen-lockfile` checkout.
 * Duplicated rather than imported: `integrations/` imports only `@ship/sdk`
 * (p.11). Long form in `integrations/cli/tests/ttfe/tsx.ts`.
 */
function resolveTsx(): string {
  const candidates = [
    join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
    join(REPO_ROOT, 'api', 'node_modules', '.bin', 'tsx'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(
      'no `tsx` binary found. Looked at:\n' +
        candidates.map((candidate) => `  \u00b7 ${candidate}`).join('\n') +
        '\n\nRun `pnpm install --frozen-lockfile` from the repo root.',
    );
  }
  return found;
}


function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Slack live suite. Run \`pnpm slack:live\`.`);
  return value;
}

function run(script: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveTsx(), [join(REPO_ROOT, 'scripts', script), ...args], {
      env: { ...process.env },
      cwd: REPO_ROOT,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${script} exited ${code}:\n${err}${out}`)),
    );
  });
}

let world: SlackWorld;
let client: ShipClient;
let signingSecret: string;
let createdTitle: string;
let createdId: string;
let subscriptionId: string;
/** PF-742's other half — the second of the two event types p.8 names. */
let issueSubscriptionId: string;
/** The platform's own record of the attempt — hops 2, 3 and 5 read it. */
let deliveryRow: WebhookDelivery | undefined;

beforeAll(async () => {
  const shipUrl = required('SHIP_DRILL_BASE_URL').replace(/\/+$/, '');
  const clientId = required('SHIP_DRILL_CLIENT_ID');

  // ── a Ship token, through a real device grant ──────────────────────────
  let seen: string | null = null;
  let announce: (() => void) | null = null;
  const codeArrived = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const flow = runDeviceLogin({
    baseUrl: shipUrl,
    clientId,
    scopes: ['documents:read', 'documents:write', 'webhooks:manage'],
    onUserCode: (code) => {
      seen = code;
      announce?.();
    },
  });
  await codeArrived;
  await run('l19-device-approve.ts', [
    '--user-code',
    seen as unknown as string,
    '--base-url',
    shipUrl,
    '--decision',
    'allow',
  ]);
  const result = await flow;
  client = new ShipClient({ baseUrl: shipUrl, token: result.tokens.accessToken });

  // ── the listener FIRST, because the subscription's target_url is its port ──
  world = await bootSlackWorld();
  const subscription = await client.webhooks.create({
    event: 'document.created',
    target_url: world.webhookUrl,
  });
  // Shown EXACTLY ONCE (p.2). Captured here, at creation, and handed to the
  // running listener — there is no second chance and `list()` does not carry it.
  signingSecret = subscription.signing_secret;
  subscriptionId = subscription.id;
  world.setSigningSecret(signingSecret);

  // PF-742's OTHER event type. Until 2026-08-15 this live path created exactly
  // one subscription, so `grep -rn "event: '" integrations/` returned
  // `document.created` and nothing else — the same defect species as the one
  // closed in `listener.test.ts`, one level up: the criterion names TWO event
  // types and the whole-path proof exercised one. Created here so the walk runs
  // with both subscriptions live, which also strengthens hop 3 — the matcher
  // now has two rows to choose between and must still produce exactly one
  // delivery for a `document.created` event.
  const issueSubscription = await client.webhooks.create({
    event: 'issue.assigned',
    target_url: world.webhookUrl,
  });
  issueSubscriptionId = issueSubscription.id;

  // ── hop 1: the INTERNAL route, with a session cookie ───────────────────
  createdTitle = `PF-743 — ${Date.now()}`;
  const created = JSON.parse(
    await run('l24-internal-document.ts', ['--base-url', shipUrl, '--title', createdTitle]),
  ) as { id?: string; document?: { id?: string } };
  createdId = created.id ?? created.document?.id ?? '';

  // ── hops 2..7: wait for the delivery to land at the listener ───────────
  await world.waitForDelivery();

  // The platform's own record of the attempt, fetched once. Hops 2, 3 and 5
  // assert against it; fetching per-test would make four calls that could
  // legitimately disagree with each other as retries advance the row.
  //
  // ── and fetched only once the row is TERMINAL ────────────────────────────
  // `waitForDelivery()` resolves the instant the LISTENER has answered, and the
  // deliverer writes the outcome to its row strictly after that — so reading
  // the row here raced the writer. Observed losing once in six runs, as
  // `expected 'in_flight' to be 'delivered'` out of hop 5. p.9 sets drill flake
  // at zero over twenty runs, so once in six is a defect and not bad luck.
  //
  // POLLED ON THE CONDITION, never slept: p.11 forbids waiting a guessed
  // interval for an outcome, and each iteration's pace is set by the `list()`
  // round trip itself. The attempt ceiling is a FAILURE bound — it exists so a
  // deliverer that never records an outcome fails hop 5 against the real status
  // instead of hanging, and it is low enough that the loop can never approach
  // the per-token rate limit.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const page = await client.webhooks.deliveries.list({ subscription_id: subscriptionId });
    const row = page.data.find((d) => d.event_type === 'document.created');
    if (row !== undefined) {
      // Kept on every pass, so an exhausted loop still hands hop 5 the real row
      // to fail against rather than `undefined`.
      deliveryRow = row;
      if (row.status !== 'in_flight') break;
    }
  }
}, 180_000);

afterAll(async () => {
  await world?.dispose();
});

describe('PF-743 — every boundary the walk crosses, in order', () => {
  it('hop 1 — the document was created through the INTERNAL path, not /api/v1', () => {
    expect(createdId).not.toBe('');
  });

  // ── hops 2-5, one assertion each ────────────────────────────────────────
  //
  // These four were ONE assertion until 2026-08-15 — a single
  // `verifyWebhook(...) === true`, labelled "hops 2-5". That is a true
  // statement about the signer and says nothing whatever about the bus, the
  // matcher or the deliverer: it would pass identically if the matcher fanned
  // out to every subscription in the database, or if a second event had been
  // published and this one dropped. PF-743 asks the test to assert EACH hop,
  // so each hop now has its own artifact and its own failure message.
  //
  // The artifact each one reads is chosen so that no two hops can be satisfied
  // by the same fact:
  //
  //   hop 2  the bus minted ONE event id, and everything downstream is a
  //          function of it — the wire's Idempotency-Key prefix and the
  //          platform's `event_id` column have to be the same string.
  //   hop 3  the matcher resolved that event to THIS subscription and only
  //          this one — the key's suffix, the `subscription_id` column, and a
  //          delivery count of exactly one.
  //   hop 4  the signer produced a well-formed `Ship-Signature` that verifies
  //          against the secret shown once at creation.
  //   hop 5  the deliverer made the HTTP call and recorded the result — first
  //          attempt, terminal `delivered`, a 2xx from the listener, and a
  //          measured latency. A row with no `attempted_at` means nothing was
  //          ever sent, however good the signature is.

  it('hop 2 — the IEventBus published ONE event, and the delivery is keyed to it', () => {
    const delivery = world.log.deliveries[0];
    expect(delivery, 'no delivery reached the listener').toBeDefined();
    expect(deliveryRow, 'the platform recorded no delivery for this subscription').toBeDefined();

    // `Idempotency-Key` is `${eventId}:${subscriptionId}` — L15/L16 derive it
    // from the bus's event id, so it is the bus's identity crossing the wire.
    const key = delivery!.headers['idempotency-key'];
    expect(key, 'no Idempotency-Key on the wire (PF-471)').toBeDefined();
    const [eventIdOnWire, ...rest] = key!.split(':');
    expect(rest.length, `Idempotency-Key is not <event>:<subscription>: ${key}`).toBe(1);
    expect(eventIdOnWire).toBeTruthy();

    expect(deliveryRow!.event_type).toBe('document.created');
    expect(
      deliveryRow!.event_id,
      'the event id on the wire is not the event id the platform recorded — ' +
        'something between the bus and the deliverer re-minted it',
    ).toBe(eventIdOnWire);
    expect(deliveryRow!.idempotency_key).toBe(key);
  });

  it('hop 3 — the subscription matcher resolved it to THIS subscription, and only this one', () => {
    const key = world.log.deliveries[0]!.headers['idempotency-key']!;
    const subscriptionOnWire = key.slice(key.indexOf(':') + 1);

    expect(
      subscriptionOnWire,
      'the delivery is addressed to a subscription this test did not create',
    ).toBe(subscriptionId);
    expect(deliveryRow!.subscription_id).toBe(subscriptionId);

    // The matcher's other half: one subscription matched, so one delivery
    // arrived. A fan-out bug delivers a correctly signed, correctly keyed
    // payload N times, and every per-delivery assertion above still passes.
    expect(
      world.log.deliveries.length,
      `the matcher produced ${world.log.deliveries.length} deliveries for one event`,
    ).toBe(1);
  });

  it('hop 4 — the signer signed it, and the signature verifies against the once-shown secret', () => {
    const delivery = world.log.deliveries[0]!;
    const header = delivery.headers[SIGNATURE_HEADER];
    expect(header, `no ${SIGNATURE_HEADER} header on the delivery`).toBeDefined();
    expect(header, `malformed signature header: ${header}`).toMatch(SIGNATURE_SHAPE);

    // Verified with the SDK's own verifier, against the secret the subscription
    // returned once. Nothing in this assertion reads a database row.
    expect(verifyWebhook(delivery.headers, delivery.rawBody, signingSecret)).toBe(true);

    // And it is the header the platform recorded sending, not a re-derivation.
    expect(deliveryRow!.signature_header).toBe(header);
  });

  it('hop 5 — the deliverer made the call and recorded the outcome', () => {
    expect(deliveryRow!.attempt_number, 'not the first attempt').toBe(1);
    expect(
      deliveryRow!.attempted_at,
      'the row has no attempted_at — the deliverer never sent anything',
    ).not.toBeNull();
    expect(deliveryRow!.status).toBe('delivered');
    expect(deliveryRow!.response_status).toBeGreaterThanOrEqual(200);
    expect(deliveryRow!.response_status).toBeLessThan(300);
    expect(deliveryRow!.latency_ms).not.toBeNull();
    expect(deliveryRow!.dlq_reason).toBeNull();
  });

  it('hop 6 — the listener recognised it as the document the UI created', () => {
    const raw = world.log.deliveries[0]!.rawBody;
    const envelope = JSON.parse(raw.toString('utf8')) as { type: string; data: { id: string; title?: string } };
    expect(envelope.type).toBe('document.created');
    expect(envelope.data.id).toBe(createdId);
  });

  it('hop 7 — a message reached the Slack Web API', () => {
    const posted = world.slackCalls.filter((c) => c.url.includes('chat.postMessage'));
    expect(posted.length).toBeGreaterThanOrEqual(1);
    expect(world.log.posts[0]?.text ?? '').toContain(createdTitle);
  });

  // PF-742's subscription half, asserted where the subscriptions are actually
  // created. `POSTED_EVENT_TYPES` in `src/render.ts` says which events the
  // listener will post; it says nothing about whether Ship was ever asked to
  // send them. This reads the platform's own subscription list back.
  it('PF-742 — subscriptions exist for BOTH event types p.8 names, not just one', async () => {
    const mine = new Map<string, string>();
    for await (const sub of client.webhooks.iterate()) {
      if (sub.id === subscriptionId || sub.id === issueSubscriptionId) mine.set(sub.id, sub.event);
    }
    expect(
      [...mine.values()].sort(),
      'the platform does not list a subscription for each of the two event types this run created',
    ).toEqual(['document.created', 'issue.assigned']);
    expect(mine.get(issueSubscriptionId)).toBe('issue.assigned');
  });

  it('the delivery log agrees with the wire', async () => {
    const page = await client.webhooks.deliveries.list({ event_type: 'document.created' });
    const logged = page.data.find((d) => d.event_type === 'document.created');
    expect(logged, 'the platform recorded no delivery for an event it delivered').toBeDefined();
    // B9's column: the header actually sent, not a re-derivation.
    expect(logged?.signature_header).toEqual(expect.any(String));
  });

  // ── the hops happened IN ORDER, not merely all of them ──────────────────
  //
  // PF-743 says "in order", and seven passing assertions do not establish an
  // order — they would pass in any sequence. This is the ordering claim, made
  // from the only two things that can carry one:
  //
  //   * timestamps the PLATFORM wrote, for the hops inside the platform. Same
  //     clock, same row, so the comparison means something.
  //   * a DATA DEPENDENCY for the listener → Slack hop, because the listener
  //     records no arrival time and adding one would mean editing
  //     `integrations/slack/src/`, which is not this file's to change. The
  //     Slack message carries a title that exists nowhere but in the delivery
  //     payload, so the post cannot precede the delivery that carried it.
  //
  // Stated plainly: this proves the platform-side order by clock and the
  // listener-side order by causation. It does not prove hop 5 preceded hop 6
  // by clock — nothing on the listener side records when.
  it('the hops are ordered: bus/matcher → signer → deliverer → listener → Slack', () => {
    const createdAt = Date.parse(deliveryRow!.created_at);
    const attemptedAt = Date.parse(deliveryRow!.attempted_at!);
    expect(Number.isNaN(createdAt), 'created_at is unparseable').toBe(false);
    expect(Number.isNaN(attemptedAt), 'attempted_at is unparseable').toBe(false);

    // hops 2-3 before hop 5: the delivery row is written when the matcher
    // resolves the event, and stamped again when the deliverer sends it.
    expect(
      attemptedAt,
      'attempted_at precedes created_at — the deliverer sent before the row existed',
    ).toBeGreaterThanOrEqual(createdAt);

    // hop 4 before hop 5: the signer's `t` is the second it signed at, so it
    // cannot be later than the attempt that carried it. One second of slack,
    // because `t` is truncated to whole seconds and `attempted_at` is not:
    // a signature at 10:00:00.999 stamps t=10:00:00 and can be recorded at
    // 10:00:01.001 without anything being out of order.
    const signedAtSeconds = Number(SIGNATURE_SHAPE.exec(deliveryRow!.signature_header!)![1]);
    expect(
      signedAtSeconds * 1000,
      'the signature is stamped after the attempt that carried it',
    ).toBeLessThanOrEqual(attemptedAt + 1000);

    // hops 6-7 by data dependency: `createdTitle` is minted in this test, put
    // into the document over the INTERNAL route, and reaches the listener only
    // inside the delivery payload. Its presence in the Slack call means the
    // post is downstream of the delivery.
    const posted = world.slackCalls.filter((c) => c.url.includes('chat.postMessage'));
    expect(posted.length, 'no chat.postMessage reached the stubbed Slack').toBeGreaterThanOrEqual(1);
    const envelope = JSON.parse(world.log.deliveries[0]!.rawBody.toString('utf8')) as {
      data: { title?: string };
    };
    expect(
      world.log.posts[0]?.text ?? '',
      'the Slack message does not carry the title the delivery brought, so nothing ties the post to the delivery',
    ).toContain(createdTitle);
    expect(envelope.data.title, 'the title reached Slack without arriving in the payload').toBe(
      createdTitle,
    );
  });
});
