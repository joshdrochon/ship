/**
 * PF-721 — THE signed-delivery listener. One implementation, repository-wide.
 *
 * PRD p.7's drill example already assumes this shape: a subscriber that receives
 * a POST, hands the **raw** body plus the headers to `verifyWebhook`, and lets a
 * test wait until the delivery it cares about has arrived. Every webhook-
 * receiving integration in this tree needs exactly that, so there is one of it.
 *
 * ── Why one, insistently ───────────────────────────────────────────────────
 * Two listeners diverge on RAW-BODY HANDLING first, and that divergence is
 * invisible until it is catastrophic. The moment one of them parses JSON and
 * re-serialises before verifying, its HMAC is computed over bytes the server
 * never signed — key order, whitespace, unicode escapes — and the integration
 * rejects every legitimate delivery while looking fine in isolation. PF-741
 * exists to protect against precisely that, and it cannot protect a second copy
 * it does not know about. `oneListener.test.ts` greps `integrations/**` and
 * fails if a second `createServer` for delivery capture appears.
 *
 * Bytes are captured as a `Buffer` and never touched. `json()` is a CONVENIENCE
 * on the captured request, computed after the fact, so the verification path and
 * the reading path cannot be confused for one another.
 *
 * ── `waitFor` and the no-`setTimeout` rule (p.11) ──────────────────────────
 * The wait is EVENT-DRIVEN: every arriving request re-evaluates the predicate,
 * and a satisfied predicate resolves immediately. `timeoutMs` arms a timer that
 * can only ever REJECT — it never delays a success and it never advances the
 * happy path by a millisecond. p.11 forbids sleeping *for* an outcome; a
 * deadline that fires only when the outcome never came is the opposite of that,
 * and without one a lost delivery reads as a hung suite rather than a failure
 * naming what it was waiting for.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

/** One received HTTP request, bytes intact. */
export interface CapturedRequest {
  method: string;
  /** Path plus query, exactly as it arrived. */
  url: string;
  /** Lower-cased header names, as Node delivers them. */
  headers: Record<string, string>;
  /** The bytes the HMAC covers. Never re-serialised, never normalised. */
  rawBody: Buffer;
  /** `Date.now()` at the end of the body, for ordering assertions only. */
  receivedAt: number;
  /** 1-based arrival order. */
  sequence: number;
  /** Convenience for assertions. Computed AFTER capture; not on the verify path. */
  json<T = unknown>(): T;
  /** `Idempotency-Key`, hoisted because three tickets assert on it. */
  idempotencyKey: string | null;
}

/** What the listener answers with. Returning nothing means `200 {"ok":true}`. */
export interface ListenerReply {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

export type ListenerHandler = (request: CapturedRequest) => ListenerReply | Promise<ListenerReply>;

export interface WaitOptions {
  /** Rejects after this long. Never delays a success. Default 30 000. */
  timeoutMs?: number;
  /** Named in the rejection, so a failing wait says what it wanted. */
  what?: string;
}

export interface TestListener {
  /** `http://127.0.0.1:<port>` — a loopback target, which needs PF-575's opt-in. */
  readonly url: string;
  /** Every request, in arrival order. */
  readonly requests: readonly CapturedRequest[];
  /** Replaces the reply behaviour. The default is `200 {"ok":true}`. */
  respondWith(handler: ListenerHandler): void;
  /** Resolves as soon as `predicate` holds over everything received so far. */
  waitFor(predicate: (received: readonly CapturedRequest[]) => boolean, options?: WaitOptions): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function headerRecord(message: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

function readRawBody(message: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    message.on('data', (chunk: Buffer) => chunks.push(chunk));
    message.on('end', () => resolve(Buffer.concat(chunks)));
    message.on('error', reject);
  });
}

/**
 * Boots a listener on an ephemeral loopback port.
 *
 * Port 0, not a fixed number: several drills and the Slack suite run in the same
 * CI job, and a hard-coded port turns a parallel run into an `EADDRINUSE` that
 * reads as a broken test.
 */
export async function createTestListener(
  initialHandler: ListenerHandler = () => ({}),
): Promise<TestListener> {
  const received: CapturedRequest[] = [];
  const waiters: (() => void)[] = [];
  let handler = initialHandler;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const rawBody = await readRawBody(req);
      const headers = headerRecord(req);
      const captured: CapturedRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers,
        rawBody,
        receivedAt: Date.now(),
        sequence: received.length + 1,
        idempotencyKey: headers['idempotency-key'] ?? null,
        json<T = unknown>(): T {
          return JSON.parse(rawBody.toString('utf8')) as T;
        },
      };
      received.push(captured);

      let reply: ListenerReply;
      try {
        reply = await handler(captured);
      } catch (err) {
        // A throwing handler is a subscriber bug, and a subscriber bug is a 500
        // to the sender. Swallowing it would make the delivery look accepted.
        reply = { status: 500, body: JSON.stringify({ error: String(err) }) };
      }

      res.writeHead(reply.status ?? 200, {
        'content-type': 'application/json',
        ...(reply.headers ?? {}),
      });
      res.end(reply.body ?? JSON.stringify({ ok: true }));

      // Wake the waiters only AFTER the response is written, so a predicate that
      // sees N requests also knows N responses have gone back.
      //
      // DRAINED FIRST, then called. The obvious `while (waiters.length > 0)
      // waiters.pop()()` spins forever: a waiter whose predicate is still false
      // re-registers itself, the loop sees a non-empty array again, and the
      // process pegs a core. Measured, not theorised — it hung the idempotency
      // drill for twelve minutes at 98% CPU before this line changed, and it
      // could not show up in the testkit's own suite because every predicate
      // there is satisfied on the first request.
      const woken = waiters.splice(0, waiters.length);
      for (const wake of woken) wake();
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests: received,

    respondWith(next: ListenerHandler): void {
      handler = next;
    },

    waitFor(predicate, options = {}): Promise<void> {
      const { timeoutMs = DEFAULT_TIMEOUT_MS, what = 'the predicate to hold' } = options;
      if (predicate(received)) return Promise.resolve();

      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const deadline = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(
            new Error(
              `Timed out after ${timeoutMs} ms waiting for ${what}. ` +
                `${received.length} request(s) arrived: ` +
                received
                  .map((r) => `#${r.sequence} ${r.method} ${r.url} key=${r.idempotencyKey ?? '—'}`)
                  .join(' | '),
            ),
          );
        }, timeoutMs);

        const check = (): void => {
          if (settled) return;
          if (!predicate(received)) {
            waiters.push(check);
            return;
          }
          settled = true;
          clearTimeout(deadline);
          resolve();
        };
        waiters.push(check);
      });
    },

    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
