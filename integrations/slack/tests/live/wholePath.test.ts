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

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Slack live suite. Run \`pnpm slack:live\`.`);
  return value;
}

function run(script: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', join(REPO_ROOT, 'scripts', script), ...args], {
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
  const page = await client.webhooks.deliveries.list({ subscription_id: subscriptionId });
  deliveryRow = page.data.find((d) => d.event_type === 'document.created');
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
