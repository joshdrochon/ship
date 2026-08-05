/**
 * FG-170/171 · Notification indicator + list view.
 *
 * ── Why this exists at all, given Q22 rules out a notification centre ───────
 * Q22 rejects a notification centre as the PLACE A DECISION IS MADE — the
 * approval belongs in the document, next to the evidence. It does not rule out
 * knowing that findings exist. Without an indicator the only way to discover an
 * open finding is to happen to open the right document, which makes the agent's
 * proactive half invisible.
 *
 * So the split is deliberate: this surface COUNTS and ROUTES, and it is the
 * banner in the document that ACCEPTS, DISMISSES and SNOOZES. There is no
 * action button in this list. Clicking a finding navigates to the document the
 * decision belongs in.
 *
 * ── Layout ─────────────────────────────────────────────────────────────────
 * A rail icon plus a popover anchored to it, so the 48px Icon Rail keeps its
 * width and no fifth panel appears (FG-174). The badge dot matches the one the
 * rail already uses for a due standup, so the rail keeps one visual vocabulary.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/cn';
import {
  isSetScoped,
  useFleetGraphNotifications,
  type FleetGraphNotification,
} from '@/hooks/useFleetGraphNotifications';

const FOCUS_RING =
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background';

export function FleetGraphRailIndicator() {
  const { data: notifications = [] } = useFleetGraphNotifications();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const count = notifications.length;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onPointerDown = (e: MouseEvent) => {
      if (e.target instanceof Node && containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  // Nothing to say and nothing to show — the rail stays as it was.
  if (count === 0) return null;

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Agent findings (${count} open)`}
        title={`Agent findings (${count} open)`}
        className={cn(
          'relative flex h-9 w-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-border/50 hover:text-foreground',
          open && 'bg-border text-foreground',
          FOCUS_RING
        )}
      >
        <AgentRailIcon />
        <span
          data-testid="fleetgraph-rail-badge"
          className="absolute right-1 top-1 h-2 w-2 rounded-full bg-amber-500"
        />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Open agent findings"
          className="absolute left-full top-0 z-50 ml-2 w-80 rounded-lg border border-border bg-background shadow-lg"
        >
          <FleetGraphNotificationList
            notifications={notifications}
            onNavigated={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

/**
 * FG-171 · The recipient's open findings.
 *
 * Read-only by design (see the header). Every row is a link to the document the
 * finding is about; the decision is taken there.
 */
export function FleetGraphNotificationList({
  notifications: override,
  onNavigated,
}: {
  notifications?: FleetGraphNotification[];
  onNavigated?: () => void;
}) {
  const navigate = useNavigate();
  const { data: fetched = [] } = useFleetGraphNotifications();
  const notifications = override ?? fetched;

  const go = useCallback(
    (n: FleetGraphNotification) => {
      if (!n.targetId) return;
      navigate(`/documents/${n.targetId}`);
      onNavigated?.();
    },
    [navigate, onNavigated]
  );

  return (
    <div className="p-2" data-testid="fleetgraph-notification-list">
      <div className="px-2 py-1 text-xs font-medium text-muted">
        Open findings ({notifications.length})
      </div>

      {notifications.length === 0 ? (
        <p className="m-0 px-2 py-2 text-xs text-muted">Nothing needs your attention.</p>
      ) : (
        <ul className="m-0 list-none space-y-0.5 p-0">
          {notifications.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => go(n)}
                disabled={!n.targetId}
                className={cn(
                  'w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-border/40 disabled:cursor-default disabled:hover:bg-transparent',
                  FOCUS_RING
                )}
              >
                <span className="block truncate text-xs font-medium text-foreground">
                  {n.title}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-muted">
                  {n.targetTitle ?? 'This workspace'}
                  {isSetScoped(n) ? ' · across this week' : ''}
                  {n.requiresApproval ? ' · needs a decision' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AgentRailIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="h-5 w-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 3v2m0 14v2M5.6 5.6l1.4 1.4m10 10 1.4 1.4M3 12h2m14 0h2M5.6 18.4 7 17m10-10 1.4-1.4"
      />
      <circle cx="12" cy="12" r="3.25" />
    </svg>
  );
}
