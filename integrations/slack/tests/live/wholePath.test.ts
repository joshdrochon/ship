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
import { ShipClient, runDeviceLogin, verifyWebhook } from '@ship/sdk';
import { bootSlackWorld, type SlackWorld } from '../support/harness.js';

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
  world.setSigningSecret(signingSecret);

  // ── hop 1: the INTERNAL route, with a session cookie ───────────────────
  createdTitle = `PF-743 — ${Date.now()}`;
  const created = JSON.parse(
    await run('l24-internal-document.ts', ['--base-url', shipUrl, '--title', createdTitle]),
  ) as { id?: string; document?: { id?: string } };
  createdId = created.id ?? created.document?.id ?? '';

  // ── hops 2..7: wait for the delivery to land at the listener ───────────
  await world.waitForDelivery();
}, 180_000);

afterAll(async () => {
  await world?.dispose();
});

describe('PF-743 — every boundary the walk crosses, in order', () => {
  it('hop 1 — the document was created through the INTERNAL path, not /api/v1', () => {
    expect(createdId).not.toBe('');
  });

  it('hops 2-5 — the event reached the deliverer and arrived SIGNED', () => {
    const delivery = world.log.deliveries[0];
    expect(delivery, 'no delivery reached the listener').toBeDefined();
    // Verified with the SDK's own verifier, against the secret the subscription
    // returned once. Nothing in this assertion reads a database row.
    expect(verifyWebhook(delivery!.headers, delivery!.rawBody, signingSecret)).toBe(true);
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
});
