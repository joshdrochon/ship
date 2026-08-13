/**
 * PF-509 — refresh is SINGLE-FLIGHT, keyed on the token-store instance.
 *
 * ── Why this is not a performance optimisation ──────────────────────────────
 * PRD p.3 mandates one-time-use refresh tokens with rotation and FAMILY
 * REVOCATION. L06 implements it as a conditional `UPDATE … WHERE spent_at IS
 * NULL` inside one transaction, which is correct — and it is exactly what makes
 * a naive client destructive. Ten concurrent calls that each notice a 401 and
 * each POST the same refresh token produce one winner and nine presentations of
 * an already-spent token, and the server's answer to a spent token is *revoke
 * the whole family*. The user is logged out, mid-drill, by a client that was
 * only trying to be helpful.
 *
 * So: one in-flight refresh per store. Losers await the winner's promise and
 * retry with whatever it produced. Ten concurrent expired calls → exactly ONE
 * `/oauth/token` request and ten successful responses.
 *
 * ── The scope of the guarantee, stated honestly (L99 D14) ───────────────────
 * The key is the STORE INSTANCE, which means the guarantee holds within one
 * process. Two terminals running L19's CLI are two processes sharing one
 * `~/.ship/credentials.json`, and this promise cannot see across that boundary.
 * L06 shipped strict rotation as the default with a same-generation replay
 * window available behind `REFRESH_REPLAY_WINDOW_MS` (default `0`) and argued
 * against relying on it — behind more than one API instance the window can only
 * be served from a process-local cache, because tokens are hashed at rest, so
 * it converts a deterministic failure into a load-balancer-dependent one.
 *
 * **This client is therefore built to work under STRICT rotation and assumes no
 * window exists.** What it does instead:
 *
 *   - re-reads the store immediately before exchanging, so a refresh performed
 *     by another process since this request began is picked up rather than
 *     overwritten (`load()` inside the critical section, not before it);
 *   - treats a failed refresh as logged-out (`kind: 'auth'`) and does NOT retry
 *     it, because a second attempt with a token the server has already rejected
 *     is the same destructive pattern one level up.
 *
 * A cross-process lock (an O_EXCL lockfile beside the credential) is the real
 * fix for concurrent CLIs. It belongs with the CLI that has the concurrency
 * problem (L19), not in a library that also runs in a browser, and it is called
 * out here rather than silently omitted.
 */
import type { HttpClient } from '../http.js';
import { buildOAuthTokenUrl } from '../baseUrl.js';
import { ShipError } from '../errors.js';
import type { ITokenStore, StoredTokens } from './tokenStore.js';

/**
 * In-flight refreshes, keyed by store instance.
 *
 * A `WeakMap` rather than a field on the client: two `ShipClient`s sharing one
 * store must share one refresh, which is the whole point, and a field on the
 * client would give each of them its own. Weak so a discarded store does not
 * pin its promise.
 */
const inFlight = new WeakMap<ITokenStore, Promise<StoredTokens>>();

/** Test-only: how many refreshes are currently in flight for this store. */
export function hasInFlightRefresh(store: ITokenStore): boolean {
  return inFlight.has(store);
}

/**
 * Runs `exchange` at most once per store at a time.
 *
 * The entry is removed in a microtask AFTER the promise settles, not inside a
 * `finally` that runs before awaiters are resumed — otherwise a caller arriving
 * in that gap starts a second refresh, which is the failure this function
 * exists to prevent.
 */
export function singleFlight(
  store: ITokenStore,
  exchange: () => Promise<StoredTokens>,
): Promise<StoredTokens> {
  const existing = inFlight.get(store);
  if (existing !== undefined) return existing;

  const promise = exchange();
  inFlight.set(store, promise);

  const release = (): void => {
    if (inFlight.get(store) === promise) inFlight.delete(store);
  };
  promise.then(release, release);

  return promise;
}

export interface RefreshDeps {
  http: HttpClient;
  baseUrl: string;
  clientId: string;
  clientSecret?: string;
  /** Unix ms, injected. Used to compute `expiresAtSeconds` from `expires_in`. */
  nowMs: number;
}

/** RFC 6749 §5.1 — the token endpoint's success body, as L06 emits it. */
interface TokenResponseBody {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

/**
 * Exchanges a refresh token for a new pair.
 *
 * `/oauth/token` is a SIBLING of `/api/v1` on the server and speaks RFC 6749's
 * `application/x-www-form-urlencoded` request and `{error, error_description}`
 * failure body — NOT L07's `ApiError` envelope. Two specs, two surfaces; the
 * error is translated into a `ShipError` here so a consumer still catches one
 * type.
 *
 * ⚑ Client authentication: L06's `authenticateClient` requires BOTH `client_id`
 * and `client_secret` (or HTTP Basic) and returns null without them, so a public
 * client — a CLI, which by RFC 6749 §2.1 has no secret — cannot currently
 * refresh against this server. That is a server-side gap, reported rather than
 * worked around; the secret is sent when supplied.
 */
export async function exchangeRefreshToken(
  deps: RefreshDeps,
  refreshToken: string,
): Promise<StoredTokens> {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: deps.clientId,
  });
  if (deps.clientSecret !== undefined) form.set('client_secret', deps.clientSecret);

  const response = await deps.http.send({
    url: buildOAuthTokenUrl(deps.baseUrl).toString(),
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: form.toString(),
  });

  const raw = await response.text().catch(() => '');
  // No initializer: both branches below assign, and `no-useless-assignment` is
  // an error-level rule in this repo, so a dead `= null` fails `pnpm lint`.
  let parsed: unknown;
  try {
    parsed = raw === '' ? null : JSON.parse(raw);
  } catch {
    parsed = null;
  }

  if (response.status < 200 || response.status >= 300) {
    const oauthError = (parsed as { error?: unknown; error_description?: unknown } | null)?.error;
    const description = (parsed as { error_description?: unknown } | null)?.error_description;
    throw new ShipError({
      kind: 'auth',
      code: null,
      status: response.status,
      // The refresh token itself is NEVER interpolated into this message. See
      // PF-495's second assertion and `noTokenLeak.test.ts`.
      message:
        `Refreshing the access token failed` +
        (typeof oauthError === 'string' ? ` (${oauthError})` : '') +
        (typeof description === 'string' ? `: ${description}` : '.') +
        ` The stored credential is no longer usable — re-authenticate.`,
      requestId: response.headers.get('x-request-id'),
    });
  }

  const body = (parsed ?? {}) as TokenResponseBody;
  if (typeof body.access_token !== 'string' || body.access_token === '') {
    throw new ShipError({
      kind: 'auth',
      code: null,
      status: response.status,
      message: 'The token endpoint returned no access_token. Re-authenticate.',
    });
  }

  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : null;

  return {
    accessToken: body.access_token,
    // Rotation means the response carries a NEW refresh token and the presented
    // one is now spent. Falling back to the presented token when the server
    // omits one would store a credential that is guaranteed to revoke the family
    // on next use — `null` (re-authenticate) is the correct answer.
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    expiresAtSeconds: expiresIn !== null ? Math.floor(deps.nowMs / 1000) + expiresIn : null,
    scopes:
      typeof body.scope === 'string' && body.scope.trim() !== '' ? body.scope.trim().split(/\s+/) : [],
  };
}
