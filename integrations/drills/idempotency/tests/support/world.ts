/**
 * PF-728 — subscribing and receiving the way a stranger would.
 *
 * Everything below goes through `@ship/sdk` and HTTP. The one privileged act in
 * the whole drill — approving a device grant, which needs a browser and a
 * session — is a SUBPROCESS running `scripts/l19-device-approve.ts`, exactly as
 * L19's harness does it, so this package holds no credential of its own.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ShipClient, runDeviceLogin, type WebhookSubscriptionWithSecret } from '@ship/sdk';
import { createTestListener, type CapturedRequest, type TestListener } from '@ship/integration-testkit';
import { createDedupeSubscriber, type DedupeSubscriber } from '../../src/subscriber.js';

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REPO_ROOT = dirname(dirname(dirname(PACKAGE_ROOT)));

/**
 * PF-608 — `tsx` is a devDependency of `api`, so pnpm links it into
 * `api/node_modules/.bin` and NOT into the workspace root. `npx tsx` from the
 * root therefore resolves nothing on a clean `pnpm install --frozen-lockfile`
 * checkout, and every test in this drill that logs in died with
 * `approval subprocess exited 127: sh: tsx: command not found`. Given a
 * reachable registry it is worse: `npx` downloads an unpinned tsx and the drill
 * measures a toolchain the lockfile does not name.
 *
 * Duplicated rather than imported — `integrations/` imports only `@ship/sdk`
 * (p.11) and the fence runs both ways. The long form lives in
 * `integrations/cli/tests/ttfe/tsx.ts`.
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


function required(name: string, why: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required by the idempotency drill. ${why}\n` +
        'Run it with `pnpm drill:idempotency`.\n' +
        'See integrations/drills/idempotency/README.md.',
    );
  }
  return value;
}

export function baseUrl(): string {
  return required('SHIP_DRILL_BASE_URL', 'It must point at a booted Ship.').replace(/\/+$/, '');
}

export function clientId(): string {
  return required('SHIP_DRILL_CLIENT_ID', 'The registered public app the drill logs in as.');
}

/** The scopes this drill needs. `webhooks:manage` gates all six webhook methods. */
export const SCOPES = ['documents:read', 'documents:write', 'webhooks:manage'];

function approve(userCode: string, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      resolveTsx(),
      [join(REPO_ROOT, 'scripts', 'l19-device-approve.ts'), '--user-code', userCode, '--base-url', url, '--decision', 'allow'],
      { env: { ...process.env }, cwd: REPO_ROOT },
    );
    let output = '';
    child.stdout.on('data', (c: Buffer) => (output += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (output += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`approval subprocess exited ${code}:\n${output}`)),
    );
  });
}

/** A `ShipClient` holding a token minted by a real device grant. */
export async function authenticatedClient(): Promise<ShipClient> {
  const url = baseUrl();
  let seen: string | null = null;
  let announce: (() => void) | null = null;
  const codeArrived = new Promise<void>((resolve) => {
    announce = resolve;
  });

  const flow = runDeviceLogin({
    baseUrl: url,
    clientId: clientId(),
    scopes: SCOPES,
    onUserCode: (code) => {
      seen = code;
      announce?.();
    },
  });

  await codeArrived;
  const code = seen as string | null;
  if (code === null) throw new Error('the SDK reported no user code');
  await approve(code, url);
  const result = await flow;

  return new ShipClient({ baseUrl: url, token: result.tokens.accessToken });
}

export interface Subscribed {
  listener: TestListener;
  subscriber: DedupeSubscriber;
  subscription: WebhookSubscriptionWithSecret;
  /** Every request the listener saw, for the key assertions. */
  received: readonly CapturedRequest[];
  dispose: () => Promise<void>;
}

/**
 * A fresh listener + a fresh subscription, wired to a fresh dedupe subscriber.
 *
 * ONE PER TEST, deliberately. Deliveries from a previous test's retry ladder are
 * still in flight while the next one starts, and a shared listener would count
 * them — which is how a key-equality assertion passes for the wrong reason. A
 * new subscription per test also means each test's `sideEffects` array is
 * exactly its own.
 *
 * The target is `http://127.0.0.1:<port>`, which `checkTargetUrl` refuses unless
 * `SHIP_ALLOW_LOOPBACK_WEBHOOK_TARGETS=true` — PF-575's named, default-off
 * opt-in, set by `pnpm drill:idempotency` and by nothing that is deployed.
 */
export async function subscribe(
  client: ShipClient,
  event: 'document.created' | 'document.updated',
  answer?: (attempt: number) => number,
): Promise<Subscribed> {
  const listener = await createTestListener();

  const subscription = await client.webhooks.create({ event, target_url: listener.url });

  // The secret is shown EXACTLY ONCE (p.2). Captured here at creation, because
  // there is no second chance — `list()` and `get()` do not carry it, and the
  // SDK makes that a type error rather than a runtime undefined (PF-525).
  const subscriber = createDedupeSubscriber({
    secret: subscription.signing_secret,
    ...(answer !== undefined ? { answer } : {}),
  });

  listener.respondWith((request) => {
    const decision = subscriber.handle(request);
    return { status: decision.status, body: decision.body };
  });

  return {
    listener,
    subscriber,
    subscription,
    received: listener.requests,
    dispose: async () => {
      // Deactivate first, so an in-flight ladder stops rather than hammering a
      // closed port and filling the log with noise from a finished test.
      await client.webhooks.delete(subscription.id).catch(() => undefined);
      await listener.close();
    },
  };
}

/** Every `Idempotency-Key` the listener saw, in arrival order. */
export function keysOf(received: readonly CapturedRequest[]): (string | null)[] {
  return received.map((r) => r.idempotencyKey);
}
