import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, seedDeadLetteredLadder, type Page } from './fixtures/isolated-env';

/**
 * PF-662 — **Testing Scenario 8, the portal half**, through the rendered UI.
 *
 * PRD p.5: *"Verify the delivery lands in the dead-letter queue and is visible
 * in the developer portal. Click "Replay" against a now-healthy subscriber."*
 * PRD p.12's demo script ends *"Then switch to the dev portal and replay one
 * delivery."*
 *
 * The word this file exists for is **"Click"**. L16's `dlqAndReplay.test.ts`
 * already proves the replay service preserves the idempotency key; no API test
 * can prove a grader can find the dead-lettered row on a screen and press a
 * button, and that is the half p.5 and p.12 grade.
 *
 * ── The division of labour with L16, stated so neither side assumes ─────────
 * **PF-481 owns the ladder.** Six real attempts cost the schedule p.4 mandates
 * (1s, 4s, 16s, 1m, 5m) — six and a half minutes before the DLQ row exists,
 * against a 60 s per-test budget. So the six failures are seeded
 * (`seedDeadLetteredLadder`) with one shared `idempotency_key`, which is the
 * precondition; everything after the seed is real, including the replay's HTTP
 * request to a live subscriber.
 *
 * ── "A now-healthy subscriber" is literal here ──────────────────────────────
 * `target_url` is immutable by design (PATCH takes only `active`), so a
 * subscriber cannot be re-pointed — which means the healthy target has to be the
 * SAME URL that was failing. This file runs a local HTTP server that answers
 * 200 and records what it received. The seeded history is the unhealthy past;
 * the live server is the healthy present. Loopback targets are permitted because
 * the API runs under `NODE_ENV=test` (`localTargetsPermitted`), which is exactly
 * the door that constant exists to open.
 *
 * That server is also the strongest available assertion. "The replay carried the
 * original idempotency key" is checked at the SUBSCRIBER — the header a real
 * integration would dedupe on — rather than by reading our own database back.
 *
 * ── STATUS: written, never executed ────────────────────────────────────────
 * This spec has not been run: the agent that wrote it did not own the test
 * database that run. It is live rather than `fixme` on purpose — a spec that
 * fails loudly tells the truth about itself, and a skipped one does not. The
 * first person to run the e2e suite owns confirming or fixing it, and the board
 * entry for PF-662 says the same rather than claiming a pass.
 */

test.describe.configure({ mode: 'serial' });

const APP_NAME = 'TS8 Replay Subscriber';
const REDIRECT_URI = 'https://ts8-replay.example/callback';

/** Every request the subscriber received, in order. */
interface Received {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function startSubscriber(received: Received[]): Promise<{ server: Server; url: string }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      // Healthy. This is the "now-healthy subscriber" p.5 asks for.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/hook` };
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.locator('#email').fill('dev@ship.local');
  await page.locator('#password').fill('admin123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL('/login');
}

test.describe('L22 PF-662 — TS-8: the dead letter is visible, and Replay is clicked', () => {
  let server: Server | undefined;
  const received: Received[] = [];

  test.afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  });

  test('a dead-lettered delivery is visible in the DLQ and replays with its original key', async ({
    page,
    dbContainer,
  }) => {
    // A browser login, a registration, a subscription, a seed and a live HTTP
    // round trip. The default 60 s budget is for a UI test.
    test.setTimeout(3 * 60_000);

    const subscriber = await startSubscriber(received);
    server = subscriber.server;

    await login(page);
    await page.goto('/portal');

    // ── Register an app that can manage webhooks ────────────────────────────
    await page.getByTestId('register-app-open').click();
    await page.getByTestId('register-app-name').fill(APP_NAME);
    await page.getByTestId('register-app-redirects').fill(REDIRECT_URI);
    await page.getByTestId('scope-webhooks:manage').check();
    await page.getByTestId('register-app-submit').click();

    await expect(page.getByTestId('secret-once-dialog')).toBeVisible();
    await page.getByTestId('secret-once-ack').check();
    await page.getByTestId('secret-once-dismiss').click();

    // Selecting the app is what mints the PF-652 portal token; every call after
    // this point is `/api/v1` with that app's own bearer.
    await page.getByRole('link', { name: new RegExp(APP_NAME) }).click();
    await expect(page).toHaveURL(/\/portal\/[0-9a-f-]{36}/);

    // ── Subscribe to the local subscriber, through the UI ───────────────────
    await page.getByTestId('portal-tab-subscriptions').click();
    await page.getByTestId('create-subscription-open').click();
    await page.getByTestId('subscription-event').selectOption('issue.created');
    await page.getByTestId('subscription-target-url').fill(subscriber.url);
    await page.getByTestId('create-subscription-submit').click();

    // The shown-once dialog carries the subscription id as its identifier — the
    // only place the test can read it without going around the UI.
    await expect(page.getByTestId('secret-once-dialog')).toBeVisible();
    const subscriptionId = (
      await page.getByTestId('secret-once-client-id').textContent()
    )!.trim();
    expect(subscriptionId).toMatch(/^[0-9a-f-]{36}$/);
    await page.getByTestId('secret-once-ack').check();
    await page.getByTestId('secret-once-dismiss').click();

    // ── The precondition PF-481 owns: six failures, one idempotency key ─────
    const { idempotencyKey } = await seedDeadLetteredLadder(
      dbContainer.getConnectionUri(),
      subscriptionId
    );

    // ── p.5, first half: "visible in the developer portal" ──────────────────
    await page.getByTestId('portal-tab-deliveries').click();
    await page.getByTestId('dlq-view').click();
    await expect(page.getByTestId('dlq-view')).toHaveText('Showing dead-letter queue');

    const log = page.getByTestId('delivery-log');
    await expect(log).toContainText('dead_lettered');
    // Exactly ONE row: the DLQ view filters server-side on `status`, so the five
    // `failed` attempts must not be here. Counted by replay buttons — one per
    // data row — rather than by `role="row"`, which would also count the header.
    const rows = log.locator('[data-testid^="replay-"]');
    await expect(rows).toHaveCount(1);

    // The reason an operator came for (PF-458/PF-474): "never coming back"
    // versus "down for six minutes". It lives in the properties panel, which is
    // the only place `dlq_reason` is rendered — the log's columns do not carry
    // it, so asserting it against the list would be asserting the wrong pane.
    await log.getByRole('gridcell').first().click();
    const properties = page.locator('#properties-portal');
    await expect(properties).toContainText('max_attempts_exhausted');
    await expect(properties).toContainText('attempt number');

    // ── p.5, second half: the word "Click" ──────────────────────────────────
    const before = received.length;
    await rows.first().click();

    const notice = page.getByTestId('replay-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(idempotencyKey);

    // ── The assertion that matters, taken at the SUBSCRIBER ─────────────────
    await expect
      .poll(() => received.length, {
        message:
          'the replayed delivery never reached the local subscriber — the replay was ' +
          'accepted by the API but no HTTP request arrived',
        timeout: 30_000,
      })
      .toBeGreaterThan(before);

    const replayed = received[received.length - 1]!;
    // Byte-identical. A subscriber that deduped the first delivery dedupes this
    // one, which is the entire point of preserving the key across a replay.
    expect(replayed.headers['idempotency-key']).toBe(idempotencyKey);
    // And it is signed with the subscription's CURRENT secret, freshly stamped,
    // so it verifies rather than reading as expired.
    expect(String(replayed.headers['ship-signature'] ?? '')).toMatch(/t=\d+,v1=/);

    // ── PF-477: the original row is kept, not mutated into a success ────────
    // The DLQ view is still on (the filter lives in the URL), so this asserts
    // the ORIGINAL row survived the replay rather than being rewritten into a
    // success — which is exactly the record an operator came to read.
    await expect(rows).toHaveCount(1);
    await expect(log).toContainText('dead_lettered');

    // And the replay is an ADDED row: leaving the DLQ view shows both.
    await page.getByTestId('dlq-view').click();
    await expect(page.getByTestId('dlq-view')).toHaveText('Dead-letter queue');
    await expect
      .poll(async () => await log.locator('[data-testid^="replay-"]').count(), {
        message: 'the replayed attempt never appeared as a new row in the unfiltered log',
        timeout: 30_000,
      })
      .toBeGreaterThan(1);
  });
});
