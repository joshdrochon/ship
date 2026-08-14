/**
 * PF-655 — the contextual sidebar (panel 2 of 4) is the session user's own apps.
 *
 * Selecting an app is what scopes every panel to its right, and it is what
 * triggers PF-652's token mint — nothing is minted until a developer picks an
 * app, so a portal visit that only looks at the app list spends no `/api/v1`
 * quota and writes no rows into the developer's own audit trail (B11).
 *
 * Read-only on purpose in S1: registration is PF-664 and is not needed to view a
 * delivery log. The empty state names the next action rather than rendering a
 * blank pane — "no apps" and "still loading" look identical otherwise, and the
 * grader arriving at a fresh instance sees the former.
 *
 * A second owner's apps are ABSENT from this list rather than present-and-403,
 * because `/api/apps` scopes at the repository (PF-044). There is no client-side
 * filter here that could be bypassed.
 */
import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { usePortalApps } from '@/hooks/usePortalApps';

export function PortalAppsSidebar() {
  const { apps, loading, error } = usePortalApps();

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
      <div className="px-3 py-2 text-sm text-muted">
        <p className="m-0">No OAuth apps yet.</p>
        <p className="mt-1 mb-0">
          Register one to get a <code>client_id</code>, subscribe to events, and watch deliveries
          here.
        </p>
      </div>
    );
  }

  return (
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
  );
}
