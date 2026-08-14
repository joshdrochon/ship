/**
 * PF-739, PF-741, PF-742, PF-744 — the listener, driven over real HTTP.
 *
 * The Slack API is stubbed; the Slack CLIENT is real. `WebClient` is pointed at
 * the stub through `slackApiUrl`, so every assertion here rides the same request
 * builder and the same error shape production uses.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MissingConfigError, loadConfig, REQUIRED_ENV_VARS } from '../src/config.js';
import { INSTALL_PATH, OAUTH_CALLBACK_PATH } from '../src/server.js';
import { bootSlackWorld, signShipDelivery, SHIP_BASE_URL, type SlackWorld } from './support/harness.js';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

let world: SlackWorld | null = null;

afterEach(async () => {
  await world?.dispose();
  world = null;
});

function documentCreated(id = 'doc_1', title: string | null = 'Quarterly plan'): Buffer {
  return Buffer.from(
    JSON.stringify({
      id: 'evt_1',
      type: 'document.created',
      created_at: new Date().toISOString(),
      workspace_id: 'ws_1',
      data: { id, document_type: 'wiki', ...(title !== null ? { title } : {}) },
    }),
    'utf8',
  );
}

async function deliver(url: string, body: Buffer, headers: Record<string, string>): Promise<Response> {
  return fetch(url, { method: 'POST', headers, body });
}

describe('PF-739 — it boots from named variables, or it does not boot', () => {
  it('a missing variable fails at BOOT, naming every one that is missing', () => {
    let error: unknown;
    try {
      loadConfig({ SLACK_CLIENT_ID: 'x' });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(MissingConfigError);
    const missing = (error as MissingConfigError).missing;
    // All at once, not one per restart.
    expect(missing).toContain('SLACK_CLIENT_SECRET');
    expect(missing).toContain('SHIP_WEBHOOK_SIGNING_SECRET');
    expect(missing).not.toContain('SLACK_CLIENT_ID');
    expect(missing.length).toBe(REQUIRED_ENV_VARS.length - 1);
  });

  it('the README names every variable the code requires', () => {
    const readme = readFileSync(join(PACKAGE_ROOT, 'README.md'), 'utf8');
    for (const name of REQUIRED_ENV_VARS) expect(readme, `${name} is undocumented`).toContain(name);
  });

  it('a complete environment produces a config and no throw', () => {
    const config = loadConfig({
      SLACK_CLIENT_ID: 'a',
      SLACK_CLIENT_SECRET: 'b',
      SLACK_SIGNING_SECRET: 'c',
      SHIP_CLIENT_ID: 'd',
      SHIP_CLIENT_SECRET: 'e',
      SHIP_BASE_URL: 'https://ship.example.test/',
      SHIP_WEBHOOK_SIGNING_SECRET: 'f',
    });
    expect(config.shipBaseUrl).toBe('https://ship.example.test');
  });
});

describe('PF-740 — installation is Slack OAuth, never a pasted bot token', () => {
  it('GET /slack/install redirects to Slack with the app id and scopes', async () => {
    world = await bootSlackWorld();
    const response = await fetch(`${world.url}${INSTALL_PATH}`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.host).toBe('slack.com');
    expect(location.pathname).toBe('/oauth/v2/authorize');
    expect(location.searchParams.get('client_id')).toBe('slack_client_id');
    expect(location.searchParams.get('scope')).toContain('chat:write');
    expect(location.searchParams.get('redirect_uri')).toContain(OAUTH_CALLBACK_PATH);
  });

  it('the callback exchanges the code and persists a bot token PER WORKSPACE', async () => {
    world = await bootSlackWorld({ installed: false });
    world.setSlackPolicy({
      status: 200,
      body: {
        ok: true,
        access_token: 'xoxb-installed-token',
        bot_user_id: 'U_INSTALLED',
        team: { id: 'T_INSTALLED', name: 'Acme' },
      },
    });

    expect(world.installations.size()).toBe(0);
    const response = await fetch(`${world.url}${OAUTH_CALLBACK_PATH}?code=slack_code_123`);
    expect(response.status).toBe(200);

    expect(world.installations.size()).toBe(1);
    const installed = world.installations.get('T_INSTALLED');
    expect(installed?.botToken).toBe('xoxb-installed-token');
    expect(installed?.teamName).toBe('Acme');

    // The exchange really went over the wire to (the stubbed) Slack.
    const call = world.slackCalls.at(-1);
    expect(call?.url).toContain('oauth.v2.access');
    expect(call?.rawBody.toString('utf8')).toContain('slack_code_123');
  });

  it('a callback with no code is refused rather than half-installing', async () => {
    world = await bootSlackWorld({ installed: false });
    const response = await fetch(`${world.url}${OAUTH_CALLBACK_PATH}`);
    expect(response.status).toBe(400);
    expect(world.installations.size()).toBe(0);
  });
});

describe('PF-741 — the Ship signature is verified first, over the RAW body', () => {
  it('a valid delivery posts to Slack', async () => {
    world = await bootSlackWorld();
    const body = documentCreated();
    const response = await deliver(world.webhookUrl, body, signShipDelivery(body));

    expect(response.status).toBe(200);
    expect(world.log.posts).toHaveLength(1);
    const posted = world.slackCalls.find((c) => c.url.includes('chat.postMessage'));
    expect(posted).toBeDefined();
  });

  it('a TAMPERED body → 4xx and NO Slack message', async () => {
    world = await bootSlackWorld();
    const body = documentCreated();
    const headers = signShipDelivery(body);

    // One byte different from what was signed. This is the case an app-wide
    // express.json() would also produce accidentally, on every legitimate
    // delivery, by re-serialising before verifying.
    const tampered = Buffer.from(body.toString('utf8').replace('doc_1', 'doc_2'), 'utf8');
    const response = await deliver(world.webhookUrl, tampered, headers);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(world.log.posts).toHaveLength(0);
    expect(world.slackCalls.filter((c) => c.url.includes('chat.postMessage'))).toHaveLength(0);
  });

  it('a `t` six minutes old → 4xx and NO Slack message', async () => {
    // Produced by moving the OBSERVER's clock, not by waiting six minutes.
    const signedAt = 1_700_000_000;
    world = await bootSlackWorld({ nowSeconds: () => signedAt + 6 * 60 });
    const body = documentCreated();
    const response = await deliver(world.webhookUrl, body, signShipDelivery(body, signedAt));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(world.log.posts).toHaveLength(0);
  });

  it('the same signature at the same instant DOES verify — the clock is the variable', async () => {
    const signedAt = 1_700_000_000;
    world = await bootSlackWorld({ nowSeconds: () => signedAt });
    const body = documentCreated();
    const response = await deliver(world.webhookUrl, body, signShipDelivery(body, signedAt));
    expect(response.status).toBe(200);
    expect(world.log.posts).toHaveLength(1);
  });
});

describe('PF-742 — exactly two event types post, and a third posts nothing', () => {
  it('document.updated reaches the listener and produces ZERO Slack calls', async () => {
    world = await bootSlackWorld();
    const body = Buffer.from(
      JSON.stringify({
        id: 'evt_9',
        type: 'document.updated',
        created_at: new Date().toISOString(),
        workspace_id: 'ws_1',
        data: { id: 'doc_9', title: 'Should not be posted' },
      }),
      'utf8',
    );
    const response = await deliver(world.webhookUrl, body, signShipDelivery(body));

    // 200, not 4xx: the subscription is somebody's deliberate act, and a 4xx
    // would dead-letter a delivery Ship was right to send.
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ posted: false });
    expect(world.log.ignored).toHaveLength(1);
    expect(world.slackCalls.filter((c) => c.url.includes('chat.postMessage'))).toHaveLength(0);
  });

  it('the message carries the id and a link back to Ship', async () => {
    world = await bootSlackWorld();
    const body = documentCreated('doc_42', 'Quarterly plan');
    await deliver(world.webhookUrl, body, signShipDelivery(body));

    const text = world.log.posts[0]?.text ?? '';
    expect(text).toContain('Quarterly plan');
    expect(text).toContain(`${SHIP_BASE_URL}/documents/doc_42`);
  });

  it('the title appears ONLY when the payload carries one — it is never fetched', async () => {
    world = await bootSlackWorld();
    const body = documentCreated('doc_private', null);
    await deliver(world.webhookUrl, body, signShipDelivery(body));

    const text = world.log.posts[0]?.text ?? '';
    expect(text).toContain('doc_private');
    expect(text).toContain(`${SHIP_BASE_URL}/documents/doc_private`);
    // Degraded to id-and-link. A renderer that "helpfully" fetched the document
    // would read around L15's private-document gate with its own token.
    expect(text).not.toContain('null');
    expect(text).not.toContain('undefined');
    // And no read went out to recover it.
    expect(world.slackCalls.filter((c) => c.url.includes('conversations'))).toHaveLength(0);
  });
});

describe('PF-744 — Slack being down must not corrupt Ship retry semantics', () => {
  it('Slack 500 → this listener returns 5xx, so Ship retries', async () => {
    world = await bootSlackWorld();
    world.setSlackPolicy({ status: 500, body: { ok: false, error: 'internal_error' } });

    const body = documentCreated();
    const response = await deliver(world.webhookUrl, body, signShipDelivery(body));

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await response.json()).toMatchObject({ disposition: 'transient' });
    expect(world.log.posts).toHaveLength(0);
  });

  it('channel_not_found → 4xx, so the delivery dead-letters immediately', async () => {
    world = await bootSlackWorld();
    world.setSlackPolicy({ status: 200, body: { ok: false, error: 'channel_not_found' } });

    const body = documentCreated();
    const response = await deliver(world.webhookUrl, body, signShipDelivery(body));

    // Six attempts against a channel that no longer exists is six attempts
    // wasted, and only the SUBSCRIBER can tell that apart from an outage.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(await response.json()).toMatchObject({ disposition: 'permanent' });
  });

  it('ratelimited → 5xx, because being rate-limited BY Slack is transient', async () => {
    world = await bootSlackWorld();
    world.setSlackPolicy({ status: 429, body: { ok: false, error: 'ratelimited' } });

    const body = documentCreated();
    const response = await deliver(world.webhookUrl, body, signShipDelivery(body));
    expect(response.status).toBeGreaterThanOrEqual(500);
  });
});

describe('PF-741 — there is no app-wide body parser, and that is asserted structurally', () => {
  it('the source mounts express.raw on the webhook route and no json parser anywhere', () => {
    const server = readFileSync(join(PACKAGE_ROOT, 'src', 'server.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    expect(server).toContain('express.raw(');
    // The bug this integration is famous for. A comment saying "do not add
    // express.json()" is not a mechanism; this is.
    expect(server).not.toMatch(/express\.json\s*\(/);
    expect(server).not.toMatch(/express\.urlencoded\s*\(/);
    expect(server).not.toMatch(/app\.use\s*\(\s*express\./);
  });
});
