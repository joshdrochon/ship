/**
 * PF-653 — the portal's transport to `/api/v1` is `@ship/sdk`'s `ShipClient`,
 * and there is no second one.
 *
 * PRD p.10: *"the portal reuses the public API like any other client (eat the
 * dog food)."* That sentence is only true if the portal compiles against the
 * same package a stranger installs — so every platform read in
 * every portal module under `web/src` goes through the client this module builds, and
 * `portalTransport.test.ts` fails the build on a direct `fetch('/api/v1…')`
 * anywhere under the portal.
 *
 * ── Why the token lives in memory and nowhere else ──────────────────────────
 * `@ship/sdk` ships a `LocalStorageTokenStore` (PF-507) and this module
 * deliberately does not use it. A portal token in `localStorage` is reachable by
 * any XSS on the page and survives the tab, which is the exact opposite of
 * PF-652's design: the token is minted on the authority of a 15-minute session
 * and must die with the tab. `InMemoryTokenStore` is the SDK's own answer and it
 * is what a first-party page should pick.
 *
 * There is a second, quieter reason. `web/src/lib/queryClient.ts` persists the
 * TanStack cache to **IndexedDB** and that store survives reload and logout, so
 * anything that reaches query state reaches disk. The portal token is therefore
 * never a query value either — it is held by this module's cache, keyed by app
 * id, in a plain module-scope `Map` that a page refresh clears.
 */
import { ShipClient, InMemoryTokenStore } from '@ship/sdk';
import { apiPost } from './api';

/** The `/api/apps/:id/portal-token` response body (PF-652). No refresh token. */
export interface PortalToken {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
  client_id: string;
}

/**
 * Where `/api/v1` lives, from the browser's point of view.
 *
 * The SDK's own resolution order is option → `SHIP_BASE_URL` → the published
 * instance (`baseUrl.ts`). None of those three can be right here: there is no
 * process environment in a browser, and the published default would send a
 * developer running against localhost to production. So the option is passed
 * explicitly, from the same source `web/src/lib/api.ts` uses for the internal
 * API — which keeps the dev-server proxy, the deployed origin and any future
 * path prefix all working without a second configuration knob.
 */
export function portalBaseUrl(): string {
  const configured = import.meta.env.VITE_API_URL as string | undefined;
  if (configured) return configured;
  return window.location.origin;
}

/**
 * Mints a portal token for an app the session user owns.
 *
 * Throws on any non-2xx. The caller decides what a 404 means (the app is not
 * yours, or is not there — PF-652 makes those indistinguishable on purpose).
 */
export async function mintPortalToken(appId: string): Promise<PortalToken> {
  const res = await apiPost(`/api/apps/${encodeURIComponent(appId)}/portal-token`, {});
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    const message = body?.error?.message ?? `Could not obtain a portal token (${res.status})`;
    throw new PortalTokenError(message, res.status);
  }
  return body.data as PortalToken;
}

export class PortalTokenError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'PortalTokenError';
  }
}

interface CachedClient {
  client: ShipClient;
  store: InMemoryTokenStore;
  /** Epoch ms. Re-minted before this, so a call does not race its own expiry. */
  expiresAtMs: number;
  scope: string;
  clientId: string;
}

/**
 * Module-scope, not React state: two components asking for the same app's client
 * must get the SAME client, or the portal mints a token per panel and the
 * developer's audit trail fills up with the portal's own bookkeeping (B11).
 *
 * Cleared by a page reload, which is the intended lifetime.
 */
const clients = new Map<string, CachedClient>();

/** Re-mint this many ms before the token actually expires. */
const REFRESH_SKEW_MS = 30_000;

/**
 * The one place a `ShipClient` is constructed in the web app.
 *
 * Returns a client already carrying a live token for `appId`, minting one if the
 * cache is empty or the held token is within `REFRESH_SKEW_MS` of expiry.
 */
export async function getPortalClient(appId: string): Promise<ShipClient> {
  const cached = clients.get(appId);
  if (cached && cached.expiresAtMs - REFRESH_SKEW_MS > Date.now()) {
    return cached.client;
  }

  const token = await mintPortalToken(appId);
  const store = new InMemoryTokenStore();
  const client = new ShipClient({
    baseUrl: portalBaseUrl(),
    token: token.access_token,
    tokenStore: store,
    userAgentSuffix: 'ship-dev-portal',
  });

  clients.set(appId, {
    client,
    store,
    expiresAtMs: Date.now() + token.expires_in * 1000,
    scope: token.scope,
    clientId: token.client_id,
  });
  return client;
}

/**
 * Drops the cached client so the next call re-mints.
 *
 * PF-660: a `kind: 'auth'` `ShipError` means the token expired under us —
 * the portal calls this once and retries, and only surfaces an error if the
 * second attempt fails too.
 */
export function invalidatePortalClient(appId: string): void {
  clients.delete(appId);
}

/** Test seam and logout hook — there is no other way to reach the Map. */
export function clearAllPortalClients(): void {
  clients.clear();
}

/** What the current token for this app is allowed to do, if one is held. */
export function portalTokenScopeFor(appId: string): string | null {
  return clients.get(appId)?.scope ?? null;
}
