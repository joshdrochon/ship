/**
 * PF-664 / PF-670 — the two facts the portal's write surface cannot invent for
 * itself: the scope registry, and D3's rotation policy.
 *
 * ── Scopes (PF-664) ─────────────────────────────────────────────────────────
 * The register form's checkboxes are generated from
 * `scopeRegistry.list()`, served by `GET /api/apps/registry`. L03's Open/Closed
 * claim (PF-066) is that adding a scope touches `platform/scopes/scopes.ts` and
 * nothing else; a literal array in this file would be the first thing to
 * falsify it, and it would falsify it QUIETLY — the eighth scope would be
 * registrable over the API and simply invisible in the UI, with nothing failing.
 *
 * ── `rotation_policy` (PF-670) ──────────────────────────────────────────────
 * **D3** — instant revocation versus a Stripe-style grace period — is L02's
 * decision and is unresolved. It exists in the server as the single constant
 * `ROTATION_POLICY` (`api/src/routes/apps.ts`), and it reaches the rotate
 * confirmation from here so that a flip is a data change rather than a portal
 * rewrite. Hard-coding "the old secret dies now" and then flipping D3 would make
 * the UI describe a security model the server does not implement.
 *
 * It is served here rather than added to `toPublicApp` deliberately: that
 * projection is PF-038's `.strict()` allowlist and the policy is a property of
 * the SERVER, not of any one app. Publishing it per-app would suggest apps can
 * differ, which they cannot.
 *
 * ── No fallback, on purpose ─────────────────────────────────────────────────
 * There is no default list and no default policy for the failure case. A form
 * that renders a stale hard-coded scope set registers apps against scopes that
 * may not exist; a confirmation that assumes `instant` when the server did not
 * answer states a consequence it does not know. Both fail loudly instead.
 *
 * Plain state, not TanStack query — `web/src/lib/queryClient.ts` persists the
 * query cache to IndexedDB, and PF-667's rule for this lane is that portal data
 * stays off that path with no per-hook judgement call. Nothing here is secret;
 * the rule is uniform so that the hook which DOES touch a secret is not the one
 * exception someone has to remember.
 */
import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';
import type { RotationPolicy } from '@/components/portal/SecretOnceDialog';

/** `ScopeDefinition`'s published shape (PF-062). */
export interface PortalScope {
  scope: string;
  resource: string;
  action: string;
  /** Written once, in the registry. Shown here, on the consent screen and in 403 bodies. */
  description: string;
}

export interface UsePortalRegistryResult {
  scopes: PortalScope[] | null;
  /** `null` until the server answers — never assumed. */
  rotationPolicy: RotationPolicy | null;
  loading: boolean;
  error: string | null;
}

export function usePortalRegistry(): UsePortalRegistryResult {
  const [scopes, setScopes] = useState<PortalScope[] | null>(null);
  const [rotationPolicy, setRotationPolicy] = useState<RotationPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    apiGet('/api/apps/registry')
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !body?.success) {
          setError(body?.error?.message ?? `Could not load the app registry (${res.status})`);
          setScopes(null);
          return;
        }
        setScopes(body.data.scopes as PortalScope[]);
        setRotationPolicy(body.data.rotation_policy as RotationPolicy);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not load the app registry');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { scopes, rotationPolicy, loading, error };
}
