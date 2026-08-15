/**
 * A stub Ship, on loopback, for the claims that are about WHEN and HOW OFTEN
 * the CLI talks to a server rather than about what a real Ship answers.
 *
 * ── Why a stub and not the booted instance ─────────────────────────────────
 * Three of this lane's remaining acceptance criteria are counting or timing
 * claims that a real server cannot be made to produce on demand:
 *
 *   PF-564  "after a `slow_down` response no request is sent inside
 *            interval + 5s" — a real Ship only emits `slow_down` when a client
 *            polls too fast, which is exactly the behaviour under test, so
 *            asking it to emit one means first breaking the thing being proved.
 *   PF-567  "having issued EXACTLY ONE /oauth/token refresh" — a count, which
 *            needs a request log the test owns.
 *   PF-578  a TAMPERED delivery. A correct deliverer never sends one.
 *
 * So the stub is the seam for the negative and timing cases, and
 * `tests/server/` remains the seam for "does this work against real Ship".
 * Neither replaces the other: a green stub suite proves nothing about the
 * platform, and the server suite cannot produce a forged signature.
 *
 * ── The timestamps are the CLOCK's, not the wall's ─────────────────────────
 * Every recorded request carries `atMs` read from the clock the test injected
 * into the CLI (p.11 forbids timing tests against the wall clock, and PF-564
 * asks for the measurement to come "through L17's injected clock"). With a fake
 * clock whose `sleep` advances time and resolves immediately, the suite runs in
 * milliseconds and the assertions are exact rather than tolerance-banded.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  /** Path only, no query string. */
  path: string;
  query: URLSearchParams;
  body: string;
  /** Form fields, when the body was `application/x-www-form-urlencoded`. */
  form: URLSearchParams;
  headers: IncomingMessage['headers'];
  /** From the INJECTED clock — see the file header. */
  atMs: number;
}

export interface StubReply {
  status: number;
  /** Serialised as JSON when it is not a string. */
  body: unknown;
  headers?: Record<string, string>;
}

export type StubHandler = (request: RecordedRequest) => StubReply | undefined;

export class StubShip {
  readonly requests: RecordedRequest[] = [];
  private readonly server: Server;
  private port = 0;

  private constructor(
    private readonly handler: StubHandler,
    private readonly nowMs: () => number,
  ) {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  static async start(handler: StubHandler, nowMs: () => number = Date.now): Promise<StubShip> {
    const stub = new StubShip(handler, nowMs);
    await new Promise<void>((resolve, reject) => {
      stub.server.once('error', reject);
      stub.server.listen(0, '127.0.0.1', resolve);
    });
    stub.port = (stub.server.address() as AddressInfo).port;
    return stub;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Every request whose path matched, in arrival order. */
  to(path: string): RecordedRequest[] {
    return this.requests.filter((request) => request.path === path);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

    const url = new URL(request.url ?? '/', this.baseUrl);
    const contentType = request.headers['content-type'] ?? '';
    const recorded: RecordedRequest = {
      method: request.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      body,
      form: contentType.includes('x-www-form-urlencoded')
        ? new URLSearchParams(body)
        : new URLSearchParams(),
      headers: request.headers,
      atMs: this.nowMs(),
    };
    this.requests.push(recorded);

    const reply = this.handler(recorded) ?? {
      status: 404,
      body: {
        error: {
          type: 'not_found',
          message: `stub has no handler for ${recorded.method} ${recorded.path}`,
          request_id: 'stub',
        },
      },
    };

    const payload = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    response.writeHead(reply.status, {
      'content-type': 'application/json',
      ...(reply.headers ?? {}),
    });
    response.end(payload);
  }
}

/**
 * A clock that never waits.
 *
 * `sleep` ADVANCES `now` and resolves — so a poll loop that waits five seconds
 * costs the suite nothing and the interval it waited is still observable, which
 * is the whole reason PF-564 can be asserted exactly rather than approximately.
 * There is no `setTimeout` anywhere in this file (p.11).
 */
export function fakeClock(startMs = 1_700_000_000_000): {
  now(): number;
  sleep(ms: number): Promise<void>;
  random(): number;
  advance(ms: number): void;
} {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    random: () => 0.5,
    sleep: (ms: number) => {
      nowMs += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}
