/**
 * PF-655 — the contextual sidebar (panel 2 of 4) is the session user's own apps.
 *
 * Selecting an app is what scopes every panel to its right, and it is what
 * triggers PF-652's token mint — nothing is minted until a developer picks an
 * app, so a portal visit that only looks at the app list spends no `/api/v1`
 * quota and writes no rows into the developer's own audit trail (B11).
 *
 * A second owner's apps are ABSENT from this list rather than present-and-403,
 * because `/api/apps` scopes at the repository (PF-044). There is no client-side
 * filter here that could be bypassed.
 *
 * ── PF-664 / PF-666 / PF-668 — registration lives HERE, and that is a design
 *    decision rather than a convenient place to hang a button ─────────────────
 *
 * The register form and the shown-once secret are modals rendered by this
 * component, over the app list. Neither has a route, a URL parameter, or an
 * entry in `history.state`. That is what makes p.15's Back-button vector
 * unreachable rather than merely unlikely: there is no history entry to return
 * to, so Back leaves the portal entirely and coming forward again remounts a
 * component whose state is empty. `PortalPage` is not involved, so the secret
 * never crosses a route boundary at all.
 *
 * The list reloads after the dialog is dismissed, not when the app is created —
 * the new app appearing behind the modal would invite the developer to click
 * away from the only copy of their secret.
 */
import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { usePortalApps } from '@/hooks/usePortalApps';
import { RegisterAppDialog, type RegisteredApp } from './RegisterAppDialog';
import { SecretOnceDialog } from './SecretOnceDialog';

export function PortalAppsSidebar() {
  const { apps, loading, error, reload } = usePortalApps();
  const [registering, setRegistering] = useState(false);
  /**
   * The one place the raw `client_secret` lives, and it lives in plain component
   * state (PF-667). Never `setQueryData`, never a query key, never
   * `localStorage`: `web/src/lib/queryClient.ts` persists the TanStack cache to
   * IndexedDB and that store survives reload AND logout, so a secret that
   * reached query state would be a secret written to disk.
   */
  const [issued, setIssued] = useState<RegisteredApp | null>(null);

  const registerButton = (
    <button
      type="button"
      data-testid="register-app-open"
      onClick={() => setRegistering(true)}
      className="mx-3 my-2 rounded border border-accent bg-accent/10 px-2 py-1 text-xs text-accent hover:bg-accent/20"
    >
      Register app
    </button>
  );

  const dialogs = (
    <>
      {registering && (
        <RegisterAppDialog
          onCancel={() => setRegistering(false)}
          onRegistered={(app) => {
            // The form unmounts on success, so PF-664's "cannot be re-entered"
            // holds by construction rather than by disabling a button.
            setRegistering(false);
            setIssued(app);
          }}
        />
      )}
      {issued && (
        <SecretOnceDialog
          title="App registered"
          appName={issued.name}
          clientId={issued.client_id}
          secret={issued.client_secret}
          /*
            `'none'`, not `issued.rotation_policy`. This app was created seconds
            ago and has no previous secret, so D3's model has nothing to describe
            here — showing "the previous secret stopped working immediately. Any
            integration still using it is failing now" to someone registering
            their FIRST app is the UI stating a consequence that did not happen.
            The rotation policy is still rendered where it applies, by
            `RotateSecretDialog` and by the rotate branch of this same dialog.
          */
          rotationPolicy="none"
          onDismiss={() => {
            setIssued(null);
            reload();
          }}
        />
      )}
    </>
  );

  if (loading) {
    return (
      <div className="px-3 py-2 text-sm text-muted" role="status">
        Loading your apps…
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-3 py-2 text-sm text-red-400" role="alert">
        {error}
      </div>
    );
  }

  if (!apps || apps.length === 0) {
    return (
      <div className="flex flex-col">
        <div className="px-3 py-2 text-sm text-muted">
          <p className="m-0">No OAuth apps yet.</p>
          <p className="mt-1 mb-0">
            Register one to get a <code>client_id</code>, subscribe to events, and watch deliveries
            here.
          </p>
        </div>
        {registerButton}
        {dialogs}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {registerButton}
      <nav aria-label="Your OAuth apps" className="flex flex-col">
        {apps.map((app) => (
          <NavLink
            key={app.id}
            to={`/portal/${app.id}`}
            className={({ isActive }) =>
              cn(
                'flex flex-col gap-0.5 px-3 py-2 text-left text-sm transition-colors',
                isActive ? 'bg-accent/10 text-accent' : 'text-foreground hover:bg-border/30'
              )
            }
          >
            <span className="truncate font-medium">{app.name}</span>
            <span className="truncate font-mono text-xs text-muted">{app.client_id}</span>
            {!app.active && (
              // Deactivated is a STATE, not an absence. Hiding the row would make
              // a deactivated app look deleted, and the owner would go looking for
              // it in a list it will never be in again.
              <span className="text-xs text-red-400">deactivated</span>
            )}
          </NavLink>
        ))}
      </nav>
      {dialogs}
    </div>
  );
}

export type { RegisteredApp };
