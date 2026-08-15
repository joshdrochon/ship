/**
 * PF-655 / PF-663 — the session user's own OAuth apps.
 *
 * This is the ONE portal read that does not go over `/api/v1`, and the reason is
 * structural rather than a shortcut: p.3's scope registry is seven scopes and
 * none of them could gate app CRUD, so `GET /api/apps` is the session-cookie
 * surface (PF-651, and `api/src/routes/apps.ts`'s own header). Everything to the
 * right of this sidebar — deliveries, subscriptions, replay — goes through
 * `@ship/sdk` with the app's own bearer token.
 *
 * ── Why this is not a TanStack query ────────────────────────────────────────
 * `web/src/lib/queryClient.ts` persists the query cache to IndexedDB
 * (`ship-query-cache` / `tanstack-query`) and that store survives reload and
 * logout. Nothing in an app's read projection is secret — `toPublicApp` has no
 * slot for a `client_secret` — but the portal's *other* reads carry response
 * bodies from third-party subscribers and, in S2, a shown-once secret. Keeping
 * every portal read on the same plain-state path means there is one rule to
 * check ("portal data never enters the query cache") rather than a per-hook
 * judgement call that someone gets wrong later. PF-667 is the assertion.
 */
import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';

/** `toPublicApp`'s projection (PF-038). There is no secret field in this shape. */
export interface PortalApp {
  id: string;
  client_id: string;
  name: string;
  redirect_uris: string[];
  requested_scopes: string[];
  secret_prefix: string;
  secret_version: number;
  active: boolean;
  created_at: string;
}

export interface UsePortalAppsResult {
  apps: PortalApp[] | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * PF-663 — the single app record, for the panel that shows the OWNER's full row.
 *
 * A separate read rather than a `find()` over `usePortalApps`' list, for two
 * reasons that both showed up while building rotation:
 *
 *   * `GET /api/apps/:id` is PF-043's owner-scoped single read, so a URL typed
 *     with someone else's app id lands on the same not-found body the list's
 *     absence implies. Filtering a list client-side would render "loading"
 *     forever instead.
 *   * Rotation changes `secret_prefix` and `secret_version` on THIS app. A
 *     targeted reload after rotating is one request; re-reading every app the
 *     developer owns to refresh one row is not.
 */
export function usePortalApp(appId: string | null): {
  app: PortalApp | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [app, setApp] = useState<PortalApp | null>(null);
  const [loading, setLoading] = useState(appId !== null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!appId) {
      setApp(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    apiGet(`/api/apps/${encodeURIComponent(appId)}`)
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !body?.success) {
          setError(body?.error?.message ?? `Could not load this app (${res.status})`);
          setApp(null);
          return;
        }
        setApp(body.data as PortalApp);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not load this app');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [appId, nonce]);

  return { app, loading, error, reload };
}

export function usePortalApps(): UsePortalAppsResult {
  const [apps, setApps] = useState<PortalApp[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    apiGet('/api/apps')
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !body?.success) {
          setError(body?.error?.message ?? `Could not load your apps (${res.status})`);
          setApps(null);
          return;
        }
        setApps(body.data as PortalApp[]);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not load your apps');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return { apps, loading, error, reload };
}
