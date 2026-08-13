/**
 * The request pipeline — PF-495's single seam.
 *
 * Everything that happens to a Ship request happens here, once: base-URL
 * joining, the `Authorization` header, refresh-on-401, the retry ladder,
 * `Retry-After`, rate-limit header parsing and the typed error. Resource
 * clients receive the resulting `Transport` and construct nothing.
 *
 * `http.ts` sits below this and owns the only `fetch(` call in the package.
 * That split is deliberate: a consumer who injects their own `HttpClient` (a
 * proxy, an instrumented client, a test double) inherits the retry policy and
 * the typed errors instead of reimplementing them, which is the failure mode a
 * second transport always produces.
 *
 * ── One rule about tokens, enforced by test ────────────────────────────────
 * No code path in this file puts a credential into a message, a log line or an
 * `Error.stack`. The token goes into a header and nowhere else.
 * `noTokenLeak.test.ts` drives a failing request with a recognisable token and
 * asserts it appears in no property of the thrown error, including `stack` and
 * the serialised form.
 */
import { buildRequestUrl } from './baseUrl.js';
import {
  errorFromResponse,
  notAuthenticatedError,
  ShipError,
  transportError,
  type ApiErrorBody,
} from './errors.js';
import type { HttpClient } from './http.js';
import { parseRateLimit, type RateLimitStatus } from './rateLimit.js';
import { computeRetryDelayMs, isRetryableStatus, MAX_ATTEMPTS, type SdkClock } from './retry.js';
import { exchangeRefreshToken, singleFlight } from './auth/refresh.js';
import type { ITokenStore, StoredTokens } from './auth/tokenStore.js';

/**
 * The seam every resource client plugs into (L18's four, and `DocumentsClient`).
 *
 * Defined here rather than beside `DocumentsClient` because it is the contract,
 * not a detail of one resource. Re-exported from `resources/documents.ts` so an
 * existing import path keeps working.
 */
export interface Transport {
  request<T>(
    method: string,
    path: string,
    options?: { query?: Record<string, string>; body?: unknown },
  ): Promise<T>;
}

/**
 * Refresh this many seconds BEFORE the access token actually expires.
 *
 * Without a skew, a token that expires in 400ms is used, 401s, and costs a
 * refresh plus a retry — for every caller that happens to be in that window.
 * Sixty seconds also covers modest clock drift between client and server, which
 * is the other way this goes wrong and the harder one to debug.
 */
export const REFRESH_SKEW_SECONDS = 60;

export interface TransportDeps {
  http: HttpClient;
  baseUrl: string;
  clock: SdkClock;
  /** A static token. Mutually exclusive with `tokenStore` at the client level. */
  token?: string | undefined;
  tokenStore?: ITokenStore | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  userAgent: string;
  maxAttempts?: number | undefined;
  /** Called after every response that carried rate-limit headers (PF-512). */
  onRateLimit?: ((status: RateLimitStatus) => void) | undefined;
}

interface Credential {
  accessToken: string;
  /** The store this credential came from, when it can be refreshed. */
  store: ITokenStore | null;
  refreshToken: string | null;
}

export class ShipTransport implements Transport {
  private readonly deps: TransportDeps;
  private readonly maxAttempts: number;

  constructor(deps: TransportDeps) {
    this.deps = deps;
    this.maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS;
  }

  async request<T>(
    method: string,
    path: string,
    options: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    const url = buildRequestUrl(this.deps.baseUrl, path, options.query ?? {}).toString();
    const serialisedBody = options.body !== undefined ? JSON.stringify(options.body) : undefined;

    let credential = await this.resolveCredential();
    let attempt = 0;
    let refreshAttempted = false;

    // Bounded by `maxAttempts` plus at most one extra pass for a refresh, so a
    // pathological server cannot turn this into an unbounded loop.
    for (;;) {
      const response = await this.send(url, method, credential.accessToken, serialisedBody, attempt);

      if (response.kind === 'transport') {
        if (attempt + 1 < this.maxAttempts) {
          await this.wait(attempt, null);
          attempt += 1;
          continue;
        }
        throw response.error;
      }

      const { status, headers, text } = response;
      const rateLimit = parseRateLimit(headers);
      if (rateLimit !== null) this.deps.onRateLimit?.(rateLimit);

      if (status >= 200 && status < 300) {
        return parseSuccessBody<T>(text);
      }

      const error = errorFromResponse({
        status,
        body: parseErrorBody(text),
        headers,
        rateLimit,
        nowMs: this.deps.clock.now(),
      });

      // ── 401 → refresh once, then retry once ──────────────────────────────
      //
      // Exactly once. A second refresh after a second 401 means the server is
      // rejecting freshly-minted tokens, and hammering it with rotations is the
      // pattern that revokes the family (PRD p.3).
      if (
        status === 401 &&
        !refreshAttempted &&
        credential.store !== null &&
        credential.refreshToken !== null
      ) {
        refreshAttempted = true;
        credential = await this.refresh(credential.store);
        continue;
      }

      if (isRetryableStatus(status) && attempt + 1 < this.maxAttempts) {
        await this.wait(attempt, error.retryAfterSeconds);
        attempt += 1;
        continue;
      }

      throw error;
    }
  }

  /** The one place a delay is taken. Injected clock — PF-513. */
  private async wait(attempt: number, retryAfterSeconds: number | null): Promise<void> {
    const delay = computeRetryDelayMs({
      attempt,
      retryAfterSeconds,
      random: this.deps.clock.random(),
    });
    if (delay > 0) await this.deps.clock.sleep(delay);
  }

  private async send(
    url: string,
    method: string,
    accessToken: string,
    body: string | undefined,
    _attempt: number,
  ): Promise<
    | { kind: 'response'; status: number; headers: { get(name: string): string | null }; text: string }
    | { kind: 'transport'; error: ShipError }
  > {
    const headers: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      'user-agent': this.deps.userAgent,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';

    try {
      const response = await this.deps.http.send({
        url,
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
      });
      // Read the body eagerly and defensively: a truncated or non-JSON body is
      // one of PF-501's four cases, and a `text()` that rejects must not become
      // an unhandled rejection two frames up.
      const text = await response.text().catch(() => '');
      return { kind: 'response', status: response.status, headers: response.headers, text };
    } catch (error) {
      return { kind: 'transport', error: transportError(error) };
    }
  }

  /**
   * PF-508 — resolving a credential, and the corruption contract.
   *
   * `load()` is called EXACTLY ONCE per request and its rejection is swallowed
   * into "logged out". A store that throws, a store that returns garbage and a
   * store that is empty are the same answer to the caller: there is no usable
   * credential. None of the three writes anything back — no `save()`, and no
   * `clear()`, because `clear()` is a write and a credential this SDK cannot
   * parse may still be one a human can repair.
   */
  private async resolveCredential(): Promise<Credential> {
    if (this.deps.token !== undefined && this.deps.token !== '') {
      return { accessToken: this.deps.token, store: null, refreshToken: null };
    }

    const store = this.deps.tokenStore;
    if (store === undefined) {
      throw notAuthenticatedError(
        'no token and no token store were supplied. Pass `{ token }`, or a `tokenStore` a login flow has written to.',
      );
    }

    let stored: StoredTokens | null;
    try {
      stored = await store.load();
    } catch {
      throw notAuthenticatedError(
        'the token store could not be read. Nothing was written back — repair or delete the credential, then log in again.',
      );
    }

    if (stored === null || stored.accessToken === '') {
      throw notAuthenticatedError('the token store holds no usable credential. Log in first.');
    }

    // Proactive refresh: an access token already past (or within the skew of)
    // its expiry is refreshed before it is spent on a request that will 401.
    if (
      stored.refreshToken !== null &&
      stored.expiresAtSeconds !== null &&
      this.deps.clock.now() / 1000 >= stored.expiresAtSeconds - REFRESH_SKEW_SECONDS
    ) {
      return this.refresh(store);
    }

    return {
      accessToken: stored.accessToken,
      store,
      refreshToken: stored.refreshToken,
    };
  }

  /**
   * PF-509 — one refresh per store, whatever the concurrency.
   *
   * The store is re-read INSIDE the critical section, so a refresh completed by
   * another process since this request began is picked up rather than
   * overwritten with a token that is already spent (L99 D14).
   */
  private async refresh(store: ITokenStore): Promise<Credential> {
    const clientId = this.deps.clientId;
    if (clientId === undefined || clientId === '') {
      throw notAuthenticatedError(
        'the access token needs refreshing but no `clientId` was supplied. A client that persists credentials must identify itself to /oauth/token.',
      );
    }

    const tokens = await singleFlight(store, async () => {
      const current = await store.load().catch(() => null);
      const refreshToken = current?.refreshToken ?? null;
      if (refreshToken === null) {
        throw notAuthenticatedError('there is no refresh token to exchange. Log in again.');
      }

      const refreshed = await exchangeRefreshToken(
        {
          http: this.deps.http,
          baseUrl: this.deps.baseUrl,
          clientId,
          ...(this.deps.clientSecret !== undefined
            ? { clientSecret: this.deps.clientSecret }
            : {}),
          nowMs: this.deps.clock.now(),
        },
        refreshToken,
      );

      // The ONLY write in the whole pipeline, and it happens with a complete
      // pair in hand — never partially, never on a failure path.
      await store.save(refreshed);
      return refreshed;
    });

    return {
      accessToken: tokens.accessToken,
      store,
      refreshToken: tokens.refreshToken,
    };
  }
}

/**
 * A 2xx body. Empty (204, or a 200 with no content) resolves to `undefined`
 * rather than throwing on `JSON.parse('')`.
 */
function parseSuccessBody<T>(text: string): T {
  if (text.trim() === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new ShipError({
      kind: 'server',
      code: null,
      status: 200,
      message: 'Ship returned a successful status with a body that is not JSON.',
      cause: error,
    });
  }
}

/**
 * PF-501 — a failure body that may be an envelope, may be a proxy's HTML, and
 * may be nothing at all. Returns `null` for everything that is not a JSON
 * object carrying a string `code` and a string `message`, which sends
 * `errorFromResponse` down the status-based path.
 */
function parseErrorBody(text: string): ApiErrorBody | null {
  if (text.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.code !== 'string' || typeof candidate.message !== 'string') return null;
  return {
    code: candidate.code,
    message: candidate.message,
    ...(candidate.details !== undefined ? { details: candidate.details } : {}),
    ...(typeof candidate.request_id === 'string' ? { request_id: candidate.request_id } : {}),
  };
}
