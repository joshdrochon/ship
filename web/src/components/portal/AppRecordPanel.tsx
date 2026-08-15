/**
 * PF-663 / PF-670 — the owner's full app record, and the door to rotation.
 *
 * PRD p.4 asks the portal to cover *"listing apps"* and *"viewing/rotating
 * client_secret"*. The sidebar (PF-655) answers "which apps are mine"; this
 * panel answers "what IS this app", which is a different question and needs
 * four things the sidebar has no room for:
 *
 *   `client_id`     in full, and copyable. It is not a secret (PF-032) and it is
 *                   the first value a developer has to paste into their config.
 *                   Truncating it to fit would make the screen useless for the
 *                   one task it exists for.
 *   scopes          rendered with the description from `ScopeRegistry`, the same
 *                   source PF-070's 403 body reads. A scope's description is
 *                   therefore written once and cannot disagree with itself
 *                   between the consent screen, the error body and this panel.
 *   redirect URIs   byte-for-byte as registered, because that is how L04
 *                   compares them at authorize time — a panel that normalised a
 *                   trailing slash would hide the exact reason a redirect fails.
 *   created_at      the "is this the app I made in the demo?" question.
 *
 * `secret_prefix` and `secret_version` are here too, and they are the closest
 * thing to a secret this projection carries — which is the point of PF-035's
 * design: a prefix NAMES a secret without being one, so an operator can tell
 * which credential a service is holding without the credential being readable.
 *
 * ── The raw secret is not here, and cannot be ───────────────────────────────
 * `GET /api/apps/:id` runs through `toPublicApp`, PF-038's `.strict()` allowlist,
 * which has no slot for `client_secret` at all. p.2's "shown exactly once" is a
 * property of the SERVER, not a UI choice — so this panel is incapable of
 * displaying the secret even if someone asked it to, and `apps.test.ts` asserts
 * no read response carries a field named `*secret*` beyond the prefix and
 * version. Rotation is the only recovery, and the button below says so.
 */
import { useState } from 'react';
import type { PortalApp } from '@/hooks/usePortalApps';
import type { PortalScope } from '@/hooks/usePortalRegistry';
import type { RotationPolicy } from './SecretOnceDialog';
import { SecretOnceDialog } from './SecretOnceDialog';
import { RotateSecretDialog, type RotatedSecret } from './RotateSecretDialog';

export interface AppRecordPanelProps {
  app: PortalApp;
  /** From `GET /api/apps/registry`; `null` while it loads or if it failed. */
  scopeRegistry: PortalScope[] | null;
  rotationPolicy: RotationPolicy | null;
  /** Re-read the app after rotation, so `secret_version` stops being stale. */
  onRotated: () => void;
}

export function AppRecordPanel({
  app,
  scopeRegistry,
  rotationPolicy,
  onRotated,
}: AppRecordPanelProps) {
  const [open, setOpen] = useState(false);
  const [rotating, setRotating] = useState(false);
  /**
   * The ONLY place a raw secret exists in this component tree, and it exists as
   * plain React state — never `setQueryData`, never a query key, never
   * `localStorage` (PF-667). `web/src/lib/queryClient.ts` persists the TanStack
   * cache to IndexedDB and that store outlives both reload and logout, so a
   * secret that reached query state would be a secret written to disk.
   */
  const [rotated, setRotated] = useState<RotatedSecret | null>(null);

  const describe = (scope: string): string | null =>
    scopeRegistry?.find((s) => s.scope === scope)?.description ?? null;

  return (
    <section className="border-b border-border px-4 py-3" data-testid="app-record">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          data-testid="app-record-toggle"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-2 text-sm text-foreground hover:text-accent"
        >
          <span className="text-xs text-muted">{open ? '▾' : '▸'}</span>
          <span className="font-medium">{app.name}</span>
          <code className="font-mono text-xs text-muted" data-testid="app-record-client-id">
            {app.client_id}
          </code>
        </button>

        <button
          type="button"
          data-testid="rotate-secret-open"
          onClick={() => setRotating(true)}
          className="rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-border/40"
        >
          Rotate secret
        </button>
      </div>

      {open && (
        <dl className="mt-3 grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-xs">
          <dt className="text-muted">client_id</dt>
          <dd className="m-0 break-all font-mono text-foreground">{app.client_id}</dd>

          <dt className="text-muted">scopes</dt>
          <dd className="m-0">
            <ul className="m-0 list-none p-0" data-testid="app-record-scopes">
              {app.requested_scopes.map((s) => (
                <li key={s} className="mb-1">
                  <code className="font-mono text-foreground">{s}</code>
                  {describe(s) && <span className="ml-2 text-muted">{describe(s)}</span>}
                </li>
              ))}
            </ul>
          </dd>

          <dt className="text-muted">redirect_uris</dt>
          <dd className="m-0">
            <ul className="m-0 list-none p-0" data-testid="app-record-redirects">
              {app.redirect_uris.map((u) => (
                <li key={u} className="mb-1 break-all font-mono text-foreground">
                  {u}
                </li>
              ))}
            </ul>
          </dd>

          <dt className="text-muted">client_secret</dt>
          <dd className="m-0 text-foreground" data-testid="app-record-secret-prefix">
            <code className="font-mono">{app.secret_prefix}…</code>{' '}
            <span className="text-muted">
              version {app.secret_version} — stored as a hash. The full value was shown once at
              creation and cannot be shown again; rotate to get a new one.
            </span>
          </dd>

          <dt className="text-muted">created</dt>
          <dd className="m-0 text-foreground" data-testid="app-record-created">
            {app.created_at}
          </dd>

          <dt className="text-muted">status</dt>
          <dd className="m-0 text-foreground">{app.active ? 'active' : 'deactivated'}</dd>
        </dl>
      )}

      {rotating && (
        <RotateSecretDialog
          appId={app.id}
          appName={app.name}
          rotationPolicy={rotationPolicy}
          onCancel={() => setRotating(false)}
          onRotated={(result) => {
            setRotating(false);
            setRotated(result);
            onRotated();
          }}
        />
      )}

      {rotated && (
        <SecretOnceDialog
          title="Secret rotated"
          appName={rotated.name}
          clientId={rotated.client_id}
          secret={rotated.client_secret}
          rotationPolicy={rotated.rotation_policy}
          // Dropping the state is what makes the value unreachable afterwards:
          // there is no route holding it and no history entry to go Back to.
          onDismiss={() => setRotated(null)}
        />
      )}
    </section>
  );
}
