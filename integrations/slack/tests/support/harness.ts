/**
 * A booted Slack listener, a stubbed Slack API, and a signer.
 *
 * The stubbed Slack is PF-721's shared listener with a router in its handler —
 * one listener implementation across `integrations/**`, and `oneListener.test.ts`
 * enforces it. The REAL `@slack/bolt` `WebClient` is pointed at it through
 * `slackApiUrl`, so every assertion below rides the same request builder and the
 * same error shape production uses.
 */
import type { Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { SIGNATURE_HEADER } from '@ship/sdk';
import { createTestListener, type CapturedRequest, type TestListener } from '@ship/integration-testkit';
import { createSlackListener, WEBHOOK_PATH } from '../../src/server.js';
import { createInstallationStore, createSlackGateway, type InstallationStore } from '../../src/slack.js';
import type { SlackIntegrationConfig } from '../../src/config.js';

export const SHIP_WEBHOOK_SECRET = 'whsec_slack_drill_secret';
export const SHIP_BASE_URL = 'https://ship.example.test';

/** What the stubbed Slack should answer for `chat.postMessage`. */
export interface SlackStubPolicy {
  status?: number;
  body?: Record<string, unknown>;
}

export interface SlackWorld {
  /** The listener under test. */
  url: string;
  webhookUrl: string;
  log: ReturnType<typeof createSlackListener>['log'];
  installations: InstallationStore;
  /** Every request the stubbed Slack received. */
  slackCalls: readonly CapturedRequest[];
  setSlackPolicy(policy: SlackStubPolicy): void;
  /**
   * Swaps the signing secret the listener verifies against.
   *
   * PF-743 needs the listener booted BEFORE the subscription exists — the
   * subscription's `target_url` is this listener's port — and the signing
   * secret only exists after `webhooks.create` returns it, once. Rather than
   * boot twice, the config object is mutated in place.
   */
  setSigningSecret(secret: string): void;
  /** Resolves once at least `count` deliveries have reached the listener. */
  waitForDelivery(count?: number, timeoutMs?: number): Promise<void>;
  dispose(): Promise<void>;
}

export function signShipDelivery(body: Buffer, atSeconds = Math.floor(Date.now() / 1000)): Record<string, string> {
  const v1 = createHmac('sha256', SHIP_WEBHOOK_SECRET)
    .update(Buffer.concat([Buffer.from(`${atSeconds}.`, 'utf8'), body]))
    .digest('hex');
  return {
    'content-type': 'application/json',
    'idempotency-key': `evt_${atSeconds}:sub_1`,
    [SIGNATURE_HEADER]: `t=${atSeconds},v1=${v1}`,
  };
}

export async function bootSlackWorld(
  options: { nowSeconds?: () => number; installed?: boolean; signingSecret?: string } = {},
): Promise<SlackWorld> {
  // ── the stubbed Slack ────────────────────────────────────────────────────
  const slackStub: TestListener = await createTestListener();
  let policy: SlackStubPolicy = { status: 200, body: { ok: true, ts: '1700000000.000100' } };
  slackStub.respondWith(() => ({
    status: policy.status ?? 200,
    body: JSON.stringify(policy.body ?? { ok: true }),
    headers: { 'content-type': 'application/json' },
  }));

  const config: SlackIntegrationConfig = {
    slackClientId: 'slack_client_id',
    slackClientSecret: 'slack_client_secret',
    slackSigningSecret: 'slack_signing_secret',
    shipClientId: 'ship_app_grader_demo',
    shipClientSecret: 'ship_client_secret',
    shipBaseUrl: SHIP_BASE_URL,
    shipWebhookSigningSecret: options.signingSecret ?? SHIP_WEBHOOK_SECRET,
    port: 0,
    publicUrl: 'http://127.0.0.1:0',
    // `/api/` is what WebClient appends method names to.
    slackApiUrl: `${slackStub.url}/api/`,
  };

  const installations = createInstallationStore();
  if (options.installed !== false) {
    installations.save({
      teamId: 'T_TEST',
      teamName: 'Ship Test Workspace',
      botToken: 'xoxb-test-token',
      botUserId: 'U_BOT',
      installedAt: new Date().toISOString(),
    });
  }

  const { app, log } = createSlackListener({
    config,
    slack: createSlackGateway({ slackApiUrl: config.slackApiUrl as string }),
    installations,
    channel: '#ship-events',
    ...(options.nowSeconds !== undefined ? { nowSeconds: options.nowSeconds } : {}),
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    webhookUrl: `${url}${WEBHOOK_PATH}`,
    log,
    installations,
    slackCalls: slackStub.requests,
    setSlackPolicy(next) {
      policy = next;
    },
    setSigningSecret(secret) {
      config.shipWebhookSigningSecret = secret;
    },
    /**
     * Polls rather than sleeping a guessed interval: it returns the instant the
     * delivery lands, and the only fixed number is the ceiling that turns a
     * delivery that never comes into a legible failure instead of a hang. Same
     * shape as `waitForHealth` in scripts/l24-drill-server.ts.
     */
    async waitForDelivery(count = 1, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (log.deliveries.length < count) {
        if (Date.now() > deadline) {
          throw new Error(
            `Timed out after ${timeoutMs} ms waiting for ${count} delivery/deliveries. ` +
              `${log.deliveries.length} arrived.`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    dispose: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await slackStub.close();
    },
  };
}
