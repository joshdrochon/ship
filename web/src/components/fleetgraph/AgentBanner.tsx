/**
 * FG-155/156/157/158/159/161/172/173 · AgentBanner — the approval surface.
 *
 * Renders between the document title and the editor content, in the slot
 * `Editor` already exposes as `contentBanner` and `PlanQualityBanner` already
 * occupies. That placement is PRESEARCH.md Q22's decision, not a new one: the
 * confirmation belongs in the document the finding is about, where the human
 * can check the agent's reasoning against the evidence in front of them,
 * rather than in a notification centre (a second inbox) or a modal (an
 * interruption before the reader has their bearings).
 *
 * Shape is deliberately borrowed from `PlanQualityBanner`: `mb-4 pl-8`, a
 * single rounded, tinted, bordered row inside the editor column. It sits in
 * Main Content and adds no panel, so the 4-panel layout is untouched (FG-174).
 *
 * ── Dismiss is permanent, and the UI has to say so ──────────────────────────
 * Q23: a dismissed fingerprint never fires again for that target. A user who
 * reads "Dismiss" as "hide for now" will dismiss findings they wanted back, and
 * there is no undo. So Dismiss is a two-step: the first click swaps the action
 * row for one sentence naming the consequence and a confirm. Two steps rather
 * than a modal, and stated plainly rather than in red — the point is that the
 * user understands the action, not that they are frightened of it.
 *
 * Accept and Snooze are single-click. Neither is destructive: accept is what
 * the agent already proposed, and snooze re-runs the detector at wake, so a
 * mis-snooze costs at most a few business days of silence.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import {
  DEFAULT_SNOOZE_DAYS,
  SNOOZE_HORIZONS,
  isSetScoped,
  useFleetGraphActions,
  useFleetGraphNotificationsForTarget,
  type FleetGraphNotification,
  type SnoozeDays,
} from '@/hooks/useFleetGraphNotifications';

/**
 * Shared focus ring (FG-173).
 *
 * `focus-visible` rather than `focus` so a mouse click does not leave a ring
 * behind, and an explicit offset so the ring is legible against the tinted
 * banner background it sits on.
 */
const FOCUS_RING =
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background';

const ACTION_BUTTON =
  'rounded px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

export interface AgentBannerProps {
  /** The document in view. Findings are matched against `targetId`. */
  documentId: string | undefined;
  /** Test/storybook seam: bypass the query and render these findings. */
  notifications?: FleetGraphNotification[];
  className?: string;
}

export function AgentBanner({ documentId, notifications: override, className }: AgentBannerProps) {
  const { notifications: fetched } = useFleetGraphNotificationsForTarget(documentId);
  const notifications = override ?? fetched;

  /**
   * The mutation lives HERE rather than in the row, and that placement is load
   * bearing. FG-159 removes the row optimistically, so a row that owned its own
   * mutation would unmount the instant the request went out — taking its error
   * state with it. The rollback would then restore the finding with no
   * explanation attached, which reads as the click having done nothing.
   * `AgentBanner` survives the empty list (it returns null but stays mounted),
   * so the failure and the restored row arrive together.
   */
  const actions = useFleetGraphActions();

  if (notifications.length === 0) return null;

  return (
    <div className={cn('mb-4 pl-8 space-y-2', className)} data-testid="agent-banner">
      {notifications.map((n) => (
        <AgentFindingRow key={n.id} notification={n} actions={actions} />
      ))}
    </div>
  );
}

function AgentFindingRow({
  notification,
  actions,
}: {
  notification: FleetGraphNotification;
  actions: ReturnType<typeof useFleetGraphActions>;
}) {
  const { accept, dismiss, snooze, reset, activeId } = actions;
  // Scope the shared mutation's pending/error state to the row it belongs to,
  // so one finding's failure does not print an error on its siblings.
  const isPending = actions.isPending && activeId === notification.id;
  const error = activeId === notification.id ? actions.error : null;
  const [confirmingDismiss, setConfirmingDismiss] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const snoozeRef = useRef<HTMLDivElement | null>(null);
  const snoozeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const dismissTriggerRef = useRef<HTMLButtonElement | null>(null);

  const setScoped = isSetScoped(notification);

  /**
   * Backing out of the dismiss confirmation has to put focus back on Dismiss,
   * and it cannot do so inline: the confirmation REPLACES the action row, so
   * the Dismiss button is unmounted at the moment the user cancels and its ref
   * is null. Focus is therefore requested here and applied in the effect below,
   * after the button has remounted. Without this a keyboard user lands on
   * <body> and has to tab in from the top of the page again (FG-172).
   */
  const restoreDismissFocusRef = useRef(false);

  const cancelDismiss = useCallback(() => {
    restoreDismissFocusRef.current = true;
    setConfirmingDismiss(false);
  }, []);

  useEffect(() => {
    if (confirmingDismiss || !restoreDismissFocusRef.current) return;
    restoreDismissFocusRef.current = false;
    dismissTriggerRef.current?.focus();
  }, [confirmingDismiss]);

  // Escape closes the snooze menu and returns focus to its trigger, and backs
  // out of the dismiss confirmation — both reachable without a pointer (FG-172).
  useEffect(() => {
    if (!snoozeOpen && !confirmingDismiss) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (snoozeOpen) {
        setSnoozeOpen(false);
        snoozeTriggerRef.current?.focus();
      } else if (confirmingDismiss) {
        cancelDismiss();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [snoozeOpen, confirmingDismiss, cancelDismiss]);

  // Click-away for the snooze menu.
  useEffect(() => {
    if (!snoozeOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (snoozeRef.current && !snoozeRef.current.contains(e.target as Node)) {
        setSnoozeOpen(false);
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [snoozeOpen]);

  const handleAccept = useCallback(() => {
    reset();
    void accept(notification.id).catch(() => {});
  }, [accept, notification.id, reset]);

  const handleDismiss = useCallback(() => {
    reset();
    setConfirmingDismiss(false);
    void dismiss(notification.id).catch(() => {});
  }, [dismiss, notification.id, reset]);

  const handleSnooze = useCallback(
    (days: SnoozeDays) => {
      reset();
      setSnoozeOpen(false);
      void snooze(notification.id, days).catch(() => {});
    },
    [notification.id, reset, snooze]
  );

  const headingId = `fg-finding-${notification.id}`;

  return (
    <section
      aria-labelledby={headingId}
      data-testid="agent-finding"
      data-signal-type={notification.signalType}
      className="w-full rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2.5"
    >
      <div className="flex items-start gap-3">
        <AgentGlyph />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={headingId} className="m-0 text-sm font-medium text-foreground">
              {notification.title}
            </h3>
            {/*
              FG-161. A set-scoped finding is about the week's whole allocation,
              not about whatever the reader clicked to get here. Saying so is
              the difference between "why is this on the sprint page" and an
              obviously-correct placement.
            */}
            {setScoped && (
              <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                Across this week
              </span>
            )}
          </div>

          {/* The proposed action (FG-157). */}
          {notification.body && (
            <p className="mt-1 mb-0 text-xs leading-relaxed text-muted">{notification.body}</p>
          )}

          {error && (
            <p role="alert" className="mt-1 mb-0 text-xs text-red-400">
              That didn&rsquo;t save. The finding is still open — try again.
            </p>
          )}

          {confirmingDismiss ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-xs text-foreground">
                Dismiss for good? This finding won&rsquo;t be raised again.
              </span>
              <button
                type="button"
                autoFocus
                onClick={handleDismiss}
                disabled={isPending}
                className={cn(
                  ACTION_BUTTON,
                  FOCUS_RING,
                  'border border-border bg-border/40 text-foreground hover:bg-border/60'
                )}
              >
                Dismiss permanently
              </button>
              <button
                type="button"
                onClick={cancelDismiss}
                className={cn(ACTION_BUTTON, FOCUS_RING, 'text-muted hover:text-foreground')}
              >
                Keep it
              </button>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleAccept}
                disabled={isPending}
                className={cn(
                  ACTION_BUTTON,
                  FOCUS_RING,
                  'bg-accent text-white hover:bg-accent/90'
                )}
              >
                Accept
              </button>

              <button
                type="button"
                ref={dismissTriggerRef}
                onClick={() => setConfirmingDismiss(true)}
                disabled={isPending}
                title="Dismissed findings are not raised again"
                className={cn(
                  ACTION_BUTTON,
                  FOCUS_RING,
                  'border border-border text-muted hover:bg-border/40 hover:text-foreground'
                )}
              >
                Dismiss
              </button>

              <div className="relative" ref={snoozeRef}>
                <button
                  type="button"
                  ref={snoozeTriggerRef}
                  onClick={() => setSnoozeOpen((open) => !open)}
                  disabled={isPending}
                  aria-haspopup="menu"
                  aria-expanded={snoozeOpen}
                  className={cn(
                    ACTION_BUTTON,
                    FOCUS_RING,
                    'border border-border text-muted hover:bg-border/40 hover:text-foreground'
                  )}
                >
                  Snooze
                </button>

                {/*
                  FG-158. Horizons are BUSINESS days because every detector
                  threshold is measured in business days (Q23) — an hours-scale
                  snooze would wake before the underlying state could plausibly
                  have changed and re-present an identical finding. 3 is the
                  default and is marked as such rather than merely being first.
                */}
                {snoozeOpen && (
                  <div
                    role="menu"
                    aria-label="Snooze for"
                    className="absolute left-0 top-full z-50 mt-1 w-44 rounded-md border border-border bg-background p-1 shadow-lg"
                  >
                    {SNOOZE_HORIZONS.map((days) => (
                      <button
                        key={days}
                        type="button"
                        role="menuitem"
                        onClick={() => handleSnooze(days)}
                        className={cn(
                          'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs text-foreground hover:bg-border/40',
                          FOCUS_RING
                        )}
                      >
                        <span>
                          {days} business {days === 1 ? 'day' : 'days'}
                        </span>
                        {days === DEFAULT_SNOOZE_DAYS && (
                          <span className="text-[10px] uppercase tracking-wide text-muted">
                            Default
                          </span>
                        )}
                      </button>
                    ))}
                    <p className="m-0 px-2 pb-1 pt-1.5 text-[10px] leading-tight text-muted">
                      We re-check when it wakes. If it resolved itself, it
                      won&rsquo;t come back.
                    </p>
                  </div>
                )}
              </div>

              {isPending && (
                <span className="text-xs text-muted" role="status">
                  Saving&hellip;
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function AgentGlyph() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="mt-0.5 h-4 w-4 shrink-0 text-amber-400"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01" />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
      />
    </svg>
  );
}
