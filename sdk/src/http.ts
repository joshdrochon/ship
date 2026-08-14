/**
 * PF-495 / PF-496 — THE ONE PLACE `@ship/sdk` CALLS `fetch`.
 *
 * `oneFetchSite.test.ts` greps every file under `sdk/src/**` for a `fetch(` call
 * and fails unless this module is the only match. That is not tidiness: two
 * transports means two auth behaviours, two retry policies and two places a
 * token can leak into a log, and the second one is always added by someone who
 * did not know the first existed. Every resource client (L18's four, and this
 * lane's `DocumentsClient`) receives an injected `Transport` and constructs no
 * request of its own.
 *
 * ── Zero polyfills (PF-496) ────────────────────────────────────────────────
 * `globalThis.fetch`, and nothing else. `node-fetch`, `undici`, `axios` and
 * `cross-fetch` are all absent and stay absent: `package.json` declares
 * `engines.node >= 20`, where `fetch` has been global and unflagged since 18,
 * and the browser has had it for years. This is also the cheapest way to fail
 * p.8's drill-stage-1 outcome ("no peer-dependency errors") and the fastest way
 * to spend the p.9 250 KB budget — `dependencies` is empty and `noDependencies
 * .test.ts` keeps it that way.
 */
import type { HeaderReader } from './errors.js';

/** The subset of `fetch` this SDK uses. Structurally satisfied by the global. */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<HttpResponse>;

/**
 * The subset of `Response` this SDK reads. A real `Response` satisfies it, and
 * so does a plain object in a test — which is what lets the retry and error
 * tests run with no server and no `setTimeout`.
 */
export interface HttpResponse {
  readonly status: number;
  readonly headers: HeaderReader;
  text(): Promise<string>;
}

export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface HttpClient {
  send(request: HttpRequest): Promise<HttpResponse>;
}

/**
 * Resolves the global `fetch`, or explains precisely what is missing.
 *
 * Thrown at CONSTRUCTION rather than on first request: a runtime without
 * `fetch` is a environment problem, and the useful stack is the one that points
 * at the `new ShipClient(...)` line.
 */
export function resolveGlobalFetch(): FetchLike {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  if (typeof candidate !== 'function') {
    throw new TypeError(
      '@ship/sdk requires a global fetch. Node 20+ and every current browser have one; ' +
        'on an older runtime, supply your own via `new ShipClient({ http })`. The SDK ' +
        'deliberately ships no HTTP dependency — see package.json `engines` and the ' +
        '250 KB install budget.',
    );
  }
  return candidate as FetchLike;
}

/**
 * The `HttpClient` every `ShipClient` uses unless one is injected.
 *
 * Note what it does NOT do: no retries, no auth, no error mapping. Those live in
 * `transport.ts`, above this seam, so a consumer swapping in their own HTTP
 * layer (a proxy, an instrumented client, a test double) inherits the retry
 * policy and the typed errors rather than having to reimplement them.
 */
export function createFetchHttpClient(fetchImpl?: FetchLike): HttpClient {
  const impl = fetchImpl ?? resolveGlobalFetch();
  return {
    send(request: HttpRequest): Promise<HttpResponse> {
      return impl(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body !== undefined ? { body: request.body } : {}),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      });
    },
  };
}
