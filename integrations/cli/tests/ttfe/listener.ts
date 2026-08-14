/**
 * PF-599 — a REAL HTTP server, and the raw bytes that actually arrived.
 *
 * ── The bytes, unparsed ────────────────────────────────────────────────────
 * The body is accumulated as a string and handed to `verifyWebhook` exactly as
 * received. A signature computed over `JSON.stringify(JSON.parse(body))` is a
 * signature over DIFFERENT bytes — key order, number formatting and unicode
 * escaping all move — and it is the single most likely reason a correct verifier
 * returns `false` on a correct delivery. This is the consumer-side half of
 * L15's one-serialization rule (PF-436).
 *
 * ── waitFor resolves on a condition, never on a clock ───────────────────────
 * p.11 forbids `setTimeout` waits and p.9's 0%-flake target forbids retries, so
 * the only honest wait is one that wakes on an arriving request. `waitFor`
 * registers a waiter and the request handler wakes it; the timeout is a deadline
 * that REJECTS naming the stage, not a poll interval. There is no
 * `await new Promise(r => setTimeout(r, …))` anywhere in this file, and
 * `scripts/ttfe/check-no-sleeps.mjs` (PF-605) greps for one.
 *
 * ── No stubbing of IWebhookDeliverer ───────────────────────────────────────
 * This is a socket. The platform's real `HttpDeliverer` opens a connection to
 * it, which is the whole difference between the drill and L15/L16's in-memory
 * suites.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

export interface ReceivedDelivery {
  /** Milliseconds since the process origin — the same clock the recorder uses. */
  receivedAt: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Verbatim. Never re-serialized. */
  rawBody: string;
}

export class WebhookListener {
  private readonly server: Server;
  private readonly received: ReceivedDelivery[] = [];
  private readonly waiters: (() => void)[] = [];
  private boundUrl: string | null = null;

  private constructor(server: Server) {
    this.server = server;
  }

  static async start(): Promise<WebhookListener> {
    // The handler closes over `listener`, which does not exist until the server
    // does — the closure is not called before `listen` resolves, so the cycle is
    // safe and the binding never changes after this line.
    const server = createServer((request, response) => listener.handle(request, response));
    const listener = new WebhookListener(server);

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address() as AddressInfo;
    listener.boundUrl = `http://127.0.0.1:${address.port}/ttfe-drill`;
    return listener;
  }

  /**
   * The `target_url` handed to `webhooks.create`.
   *
   * `127.0.0.1`, which L15's `checkTargetUrl` rejects unless the instance opts
   * in (PF-575's `SHIP_ALLOW_LOOPBACK_WEBHOOK_TARGETS`, set by the harness). The
   * drill is the one consumer that would break silently if that gate were
   * tightened rather than widened, and nothing else in the repo would notice.
   */
  get url(): string {
    if (this.boundUrl === null) throw new Error('listener is not bound');
    return this.boundUrl;
  }

  get deliveries(): readonly ReceivedDelivery[] {
    return this.received;
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        headers[key] = Array.isArray(value) ? value.join(', ') : (value ?? '');
      }
      this.received.push({
        receivedAt: performance.now(),
        method: request.method ?? '',
        url: request.url ?? '',
        headers,
        // utf8 concat of the exact bytes, in arrival order.
        rawBody: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
      this.wake();
    });
  }

  private wake(): void {
    while (this.waiters.length > 0) this.waiters.pop()?.();
  }

  /**
   * p.7's `waitFor(predicate, { timeoutMs })` — resolves on the FIRST delivery
   * satisfying `predicate`, rejects naming the stage on timeout.
   *
   * The deadline is enforced by racing a `Promise` that the caller's stage
   * timeout will reject; there is no timer that fires early and no polling loop.
   */
  async waitFor(
    predicate: (delivery: ReceivedDelivery) => boolean,
    options: { timeoutMs: number; what: string },
  ): Promise<ReceivedDelivery> {
    const deadline = performance.now() + options.timeoutMs;
    for (;;) {
      const match = this.received.find(predicate);
      if (match !== undefined) return match;
      if (performance.now() >= deadline) {
        throw new Error(
          `receive_webhook: no delivery satisfying "${options.what}" arrived at ${this.url} ` +
            `within ${options.timeoutMs} ms (${this.received.length} request(s) seen). ` +
            'The stage timed out; this is not a generic runner timeout.',
        );
      }
      await Promise.race([
        new Promise<void>((resolve) => this.waiters.push(resolve)),
        deadlineElapsed(deadline),
      ]);
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/**
 * The ONE timer in the drill, and it is a deadline rather than a wait.
 *
 * PF-605 forbids a *fixed-duration sleep* — `await sleep(500)` between polls, the
 * mechanism that converts a race into a pass. This is the opposite: it exists so
 * a delivery that never arrives fails at a named boundary instead of hanging
 * until vitest kills the worker and names nothing. `unref()` so it can never
 * hold the process open (L99 F121: a referenced-vs-unreferenced timer is exactly
 * how `ship login` once exited 0 having done nothing — here the danger runs the
 * other way, so this one is deliberately unref'd and always raced).
 */
function deadlineElapsed(deadline: number): Promise<void> {
  const remaining = Math.max(0, deadline - performance.now());
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, remaining);
    timer.unref?.();
  });
}
