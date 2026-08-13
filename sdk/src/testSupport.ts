/**
 * Test doubles for the SDK's own suite.
 *
 * Lives in `src/` rather than in a test file for the reason the API package
 * gives for `bearerTestSupport.ts`: it is compiled by `tsc -p tsconfig.json`, so
 * the doubles and the interfaces they stand in for cannot drift without
 * `pnpm type-check` noticing. It is exported from NO entry point, so it does not
 * reach a consumer.
 *
 * `FakeClock` is why PF-513 holds: every retry test advances a counter instead
 * of waiting, and `sleeps` is the assertion surface — the ladder is checked by
 * reading what the client ASKED to wait, which is the actual contract, rather
 * than by measuring elapsed time, which is a flaky test dressed as a rigorous one.
 */
import type { HeaderReader } from './errors.js';
import type { HttpClient, HttpRequest, HttpResponse } from './http.js';
import type { SdkClock } from './retry.js';
import type { ITokenStore, StoredTokens } from './auth/tokenStore.js';

/** Case-insensitive header lookup over a plain object, like `Headers`. */
export function headersOf(source: Record<string, string> = {}): HeaderReader {
  const lower = new Map<string, string>();
  for (const [key, value] of Object.entries(source)) lower.set(key.toLowerCase(), value);
  return { get: (name) => lower.get(name.toLowerCase()) ?? null };
}

export interface StubResponse {
  status: number;
  body?: unknown;
  /** Raw body, for the not-JSON cases PF-501 covers. Wins over `body`. */
  raw?: string;
  headers?: Record<string, string>;
}

export function jsonResponse(stub: StubResponse): HttpResponse {
  const text =
    stub.raw !== undefined ? stub.raw : stub.body === undefined ? '' : JSON.stringify(stub.body);
  return {
    status: stub.status,
    headers: headersOf(stub.headers),
    text: () => Promise.resolve(text),
  };
}

/**
 * A scripted `HttpClient`.
 *
 * `queue` is consumed in order; when it runs out the last entry repeats, so a
 * test that means "and then it keeps succeeding" does not have to push twenty
 * copies. `requests` is the assertion surface for attempt counts (PF-510) and
 * for "exactly one refresh" (PF-509).
 */
export class StubHttpClient implements HttpClient {
  readonly requests: HttpRequest[] = [];
  private readonly queue: (StubResponse | Error)[];

  constructor(queue: (StubResponse | Error)[]) {
    if (queue.length === 0) throw new Error('StubHttpClient needs at least one scripted response.');
    this.queue = [...queue];
  }

  /** Requests that went to `/api/v1/...`, i.e. not the token endpoint. */
  get apiRequests(): HttpRequest[] {
    return this.requests.filter((r) => !r.url.includes('/oauth/token'));
  }

  /** Requests that went to `/oauth/token`. PF-509 asserts this is length 1. */
  get refreshRequests(): HttpRequest[] {
    return this.requests.filter((r) => r.url.includes('/oauth/token'));
  }

  send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const index = Math.min(this.requests.length - 1, this.queue.length - 1);
    const next = this.queue[index];
    if (next === undefined) throw new Error('StubHttpClient ran off the end of its queue.');
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(jsonResponse(next));
  }
}

/**
 * A clock that never waits.
 *
 * `sleep` records the requested duration, advances `nowMs` by it, and resolves
 * immediately. `random` is fixed at 1 by default so `computeRetryDelayMs`'s
 * full-jitter multiplier is the identity and the ladder is exactly predictable;
 * a jitter test sets it explicitly.
 */
export class FakeClock implements SdkClock {
  readonly sleeps: number[] = [];
  private nowMs: number;
  private randomValue: number;

  constructor(startMs = 1_700_000_000_000, randomValue = 1) {
    this.nowMs = startMs;
    this.randomValue = randomValue;
  }

  now(): number {
    return this.nowMs;
  }

  advance(ms: number): void {
    this.nowMs += ms;
  }

  setRandom(value: number): void {
    this.randomValue = value;
  }

  random(): number {
    return this.randomValue;
  }

  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.nowMs += ms;
    return Promise.resolve();
  }
}

/** Counts every call, so PF-508 can assert `load` once and `save` never. */
export class CountingTokenStore implements ITokenStore {
  loadCalls = 0;
  saveCalls = 0;
  clearCalls = 0;

  constructor(private readonly behaviour: () => Promise<StoredTokens | null>) {}

  load(): Promise<StoredTokens | null> {
    this.loadCalls += 1;
    return this.behaviour();
  }

  save(): Promise<void> {
    this.saveCalls += 1;
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.clearCalls += 1;
    return Promise.resolve();
  }
}
