/**
 * `ShipClient` — the front door, typed.
 *
 * MVP gate item 8 (PRD p.2) is written as this, verbatim:
 *
 *     new ShipClient({ token }).me()
 *
 * That expression now COMPILES (PF-491 / L99 F19 — `baseUrl` was required, so
 * the gate's own example was a type error) and resolves a base URL at runtime
 * from `SHIP_BASE_URL` or the published default. See `baseUrl.ts` for the
 * resolution order and for PF-494's path-prefix fix.
 *
 *     const client = new ShipClient({ token });                  // gate item 8
 *     const client = new ShipClient({ token, baseUrl });          // self-hosted
 *     const client = new ShipClient({ tokenStore, clientId });    // CLI, refreshing
 *
 * Everything about a request — auth, retries, rate limits, typed errors — lives
 * in `transport.ts`, and every resource client receives that one transport
 * (PF-495).
 */
import { resolveBaseUrl, type BaseUrlSource } from './baseUrl.js';
import { createFetchHttpClient, type HttpClient } from './http.js';
import type { RateLimitStatus } from './rateLimit.js';
import { realClock, type SdkClock } from './retry.js';
import { ShipTransport, type Transport } from './transport.js';
import { DocumentsClient } from './resources/documents.js';
import { InMemoryTokenStore, type ITokenStore } from './auth/tokenStore.js';

/** Sent as `User-Agent`. Version is a literal because the SDK reads no package.json at runtime. */
export const SDK_USER_AGENT = 'ship-sdk-js/0.1.0';

export interface ShipClientOptions {
  /**
   * e.g. `https://ship.example.com`, or `https://host/ship` behind a path
   * prefix — the prefix is preserved (PF-494).
   *
   * OPTIONAL, which is what makes MVP gate item 8's `new ShipClient({ token })`
   * a legal expression. Resolution order when omitted: `SHIP_BASE_URL` in the
   * environment, then the published instance.
   */
  baseUrl?: string;

  /**
   * A static access token — the simplest path, and the one the gate uses.
   *
   * Wins over `tokenStore` when both are given, and disables refresh: a caller
   * who hard-codes a token has told us where the credential comes from, and
   * silently replacing it with a rotated one from a store would be surprising.
   */
  token?: string;

  /**
   * Managed credentials. The client reads through it on every request, refreshes
   * on expiry or on a 401, and writes the rotated pair back — once, atomically,
   * and never partially. See `auth/tokenStore.ts` for the contract and
   * `auth/refresh.ts` for the single-flight guarantee (PF-509).
   */
  tokenStore?: ITokenStore;

  /** Required to refresh: `/oauth/token` authenticates the client (RFC 6749 §2.3.1). */
  clientId?: string;

  /**
   * The client secret, for a confidential client.
   *
   * ⚑ L06's token endpoint requires BOTH `client_id` and `client_secret`, so a
   * public client (a CLI, which per RFC 6749 §2.1 has no secret) cannot refresh
   * against Ship today. Reported to L06/L19 rather than worked around here.
   */
  clientSecret?: string;

  /** Overrides the HTTP layer. Retries, auth and typed errors still apply above it. */
  http?: HttpClient;

  /** Clock and timer injection — PF-513. Defaults to the real ones. */
  clock?: SdkClock;

  /** Total attempts including the first. Defaults to `RETRY_POLICY.maxAttempts`. */
  maxAttempts?: number;

  /** Appended to the SDK's own `User-Agent`, for a consumer that wants to be identifiable. */
  userAgentSuffix?: string;
}

/**
 * The authenticated caller: which app, which user (or none, for a
 * machine-to-machine token), and what the token is allowed to do.
 *
 * ⚑ **Hand-declared, and NOT yet asserted against the served spec.** PF-493
 * requires this shape to be checked against `GET /api/v1/me`'s response schema
 * in `docs/openapi.json` rather than against another hand-written literal — and
 * that route does not exist. `/api/v1/me` is L10's, L13 shipped `documents`
 * only, and TWO tests on the integration branch actively assert `/me` is absent
 * from the mounted route set (`documents.regression.test.ts` and
 * `scope-fitness.test.ts`). So this type is the SDK's best statement of the
 * contract and nothing more; see the lane report.
 *
 * The field names are snake_case because they are wire names — this is the
 * server's JSON, not a JS object the SDK invented.
 */
export interface Me {
  app: { client_id: string; name: string };
  user: { id: string; name: string } | null;
  scopes: string[];
}

export class ShipClient {
  readonly documents: DocumentsClient;

  /** Where the base URL came from — `'option' | 'env' | 'default'`. Useful in a support log. */
  readonly baseUrlSource: BaseUrlSource;
  readonly baseUrl: string;

  private readonly transport: Transport;
  private lastRateLimit: RateLimitStatus | null = null;

  constructor(options: ShipClientOptions = {}) {
    const resolved = resolveBaseUrl(options.baseUrl);
    this.baseUrl = resolved.url;
    this.baseUrlSource = resolved.source;

    // A store exists even for the static-token path, so a later `login()` has
    // somewhere to write and two clients built the same way do not silently get
    // different refresh behaviour.
    const tokenStore = options.tokenStore ?? new InMemoryTokenStore();

    this.transport = new ShipTransport({
      http: options.http ?? createFetchHttpClient(),
      baseUrl: this.baseUrl,
      clock: options.clock ?? realClock,
      token: options.token,
      tokenStore,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      userAgent:
        options.userAgentSuffix !== undefined
          ? `${SDK_USER_AGENT} ${options.userAgentSuffix}`
          : SDK_USER_AGENT,
      maxAttempts: options.maxAttempts,
      onRateLimit: (status) => {
        this.lastRateLimit = status;
      },
    });

    this.documents = new DocumentsClient(this.transport);
  }

  /**
   * `GET /api/v1/me` — MVP gate item 8's assertion: auth plus a typed round-trip,
   * end to end.
   */
  me(): Promise<Me> {
    return this.transport.request<Me>('GET', '/me');
  }

  /**
   * PF-512 — the rate-limit triple from the most recent response that carried
   * one, on the success path as well as the error path.
   *
   * `null` means no response so far has reported rate limits, which is different
   * from `{limit: null, …}` (a response reported some of them and not others)
   * and very different from a `0` that means "unknown".
   */
  get rateLimit(): RateLimitStatus | null {
    return this.lastRateLimit;
  }
}
