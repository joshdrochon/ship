/**
 * PF-671 / PF-672 / PF-673 — the selected app's webhook subscriptions.
 *
 * PRD p.4 asks the portal for *"managing subscriptions"*, and p.8's Signature
 * Challenge evaluation row expects a subscription created through the SDK to
 * *"appear in dev portal"*. This is the screen that row means.
 *
 * ── `active: false` is a STATE, not an absence (PF-671) ─────────────────────
 * PF-426 makes deactivation a matcher input rather than a delete: the dispatcher
 * reads `active` to decide whether an event produces a delivery at all, and the
 * row stays so the delivery log keeps a resolvable `subscription_id` after a
 * subscriber walks away. A list that hid inactive rows would make a deactivated
 * subscription look destroyed, and its owner would go looking for it somewhere
 * it will never be.
 *
 * ── `secret_prefix`, never the secret (PF-423) ─────────────────────────────
 * The first eight characters say WHICH secret a subscription is signing with,
 * which is the question an operator debugging a signature failure actually has,
 * without the row holding anything worth stealing. There is no route that
 * returns the secret again — `rotate` mints a new one (p.2's model), and the
 * portal shows that through `SecretOnceDialog`.
 *
 * ── PF-673: the two verbs, and the ONE correction this file makes ───────────
 * The ticket was written expecting `DELETE /:id` to remove the row and cascade
 * its delivery history away. **The shipped API does not do that.** The route
 * (`api/src/platform/api/v1/webhooks/routes.ts`) is declared *"Deactivate a
 * subscription. Idempotent; the row is retained"* — it sets `active` to false,
 * stamps `deactivated_at`, and answers the second call with the same 200. So
 * `PATCH {active:false}` and `DELETE` are the same effect reached by two verbs,
 * and there is no destructive action to warn about.
 *
 * Rendering the ticket's copy would have been the exact failure the ticket
 * exists to prevent, pointed the other way: a UI telling a developer their
 * delivery history is about to be erased, when the server keeps every row. So
 * this panel offers ONE control — Deactivate / Reactivate — and states the two
 * facts that are true: no further deliveries are attempted, and the history
 * stays. `PATCH` is what it calls, because `PATCH` is the verb that also goes
 * back the other way.
 */
import { useState } from 'react';
import type { WebhookSubscription, WebhookSubscriptionWithSecret, ShipEventType } from '@ship/sdk';
import { SelectableList } from '@/components/SelectableList';
import { cn } from '@/lib/cn';
import { usePortalSubscriptions } from '@/hooks/usePortalSubscriptions';
import { CreateSubscriptionDialog } from './CreateSubscriptionDialog';
import { SecretOnceDialog } from './SecretOnceDialog';

export interface SubscriptionsPanelProps {
  appId: string;
  appName: string;
  /**
   * Focuses the delivery log on one subscription. The subscription list is where
   * a developer knows a target URL; the delivery log's `subscription_id` filter
   * (PF-657) is where they find out whether it is working, and making them copy
   * a UUID between the two would be the portal withholding a join it already has.
   */
  onShowDeliveries: (subscriptionId: string) => void;
}

export function SubscriptionsPanel({ appId, appName, onShowDeliveries }: SubscriptionsPanelProps) {
  const {
    subscriptions,
    loading,
    error,
    hasNext,
    hasPrevious,
    next,
    previous,
    reload,
    pageNumber,
    create,
    setActive,
  } = usePortalSubscriptions(appId);

  const [creating, setCreating] = useState(false);
  /**
   * The only copy of a signing secret this app will ever emit, in plain component
   * state (PF-667). Never a query key, never `setQueryData`: `queryClient.ts`
   * persists the TanStack cache to IndexedDB and that store survives reload AND
   * logout, so a secret reaching query state is a secret written to disk.
   */
  const [issued, setIssued] = useState<WebhookSubscriptionWithSecret | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function toggleActive(sub: WebhookSubscription) {
    setBusyId(sub.id);
    setActionError(null);
    try {
      await setActive(sub.id, !sub.active);
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : 'The subscription could not be updated.'
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden" data-testid="subscriptions-panel">
      <header className="flex flex-col gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="m-0 text-base font-medium text-foreground">Webhook subscriptions</h2>
          <span className="text-xs text-muted">
            via <code>@ship/sdk</code> → <code>/api/v1/webhooks</code>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="create-subscription-open"
            onClick={() => setCreating(true)}
            className="rounded border border-accent bg-accent/10 px-2 py-1 text-xs text-accent hover:bg-accent/20"
          >
            New subscription
          </button>
        </div>
        {actionError && (
          <p className="m-0 text-xs text-red-400" role="alert" data-testid="subscription-action-error">
            {actionError}
          </p>
        )}
      </header>

      <div className="flex-1 overflow-auto" data-testid="subscription-list">
        {error && (
          <div className="m-4 rounded border border-red-400/40 bg-red-400/5 p-3" role="alert">
            <p className="m-0 text-sm text-red-400">{error.message}</p>
            {error.requestId && (
              <p className="m-0 mt-1 font-mono text-xs text-muted">request_id: {error.requestId}</p>
            )}
            {error.retryAfterSeconds !== null && (
              <p className="m-0 mt-1 text-xs text-muted">
                Rate limited — the portal shares this app&apos;s bucket with your own integration.
                Try again in {error.retryAfterSeconds}s.
              </p>
            )}
            <button
              type="button"
              data-testid="subscription-retry"
              onClick={reload}
              disabled={error.retryAfterSeconds !== null}
              className="mt-2 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-border/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Retry
            </button>
          </div>
        )}

        {!error && (
          <SelectableList<WebhookSubscription>
            items={subscriptions ?? []}
            loading={loading}
            selectable={false}
            ariaLabel="Webhook subscriptions"
            columns={[
              { key: 'state', label: 'State' },
              { key: 'event', label: 'Event' },
              { key: 'target', label: 'Target URL' },
              { key: 'secret', label: 'Signing secret' },
              { key: 'created', label: 'Created' },
              { key: 'actions', label: '' },
            ]}
            emptyState={
              <div className="p-6 text-sm text-muted" data-testid="subscriptions-empty">
                <p className="m-0 font-medium text-foreground">No subscriptions for this app.</p>
                <p className="m-0 mt-1">
                  A subscription binds one event type to one target URL. Until there is one, nothing
                  this app does produces a webhook delivery — which is also why the delivery log is
                  empty.
                </p>
              </div>
            }
            /* `<td>` cells only — `renderRow`'s output lands directly inside a `<tr>`. */
            renderRow={(s) => (
              <>
                <td
                  className={cn(
                    'px-4 py-2 text-sm font-medium',
                    s.active ? 'text-green-400' : 'text-amber-300'
                  )}
                  role="gridcell"
                  data-testid={`subscription-state-${s.id}`}
                >
                  {s.active ? 'active' : 'inactive'}
                </td>
                <td className="px-4 py-2 text-sm text-muted" role="gridcell">
                  {s.event}
                </td>
                <td className="px-4 py-2 font-mono text-xs text-muted" role="gridcell">
                  {s.target_url}
                </td>
                <td className="px-4 py-2 font-mono text-xs text-muted" role="gridcell">
                  {/* PF-423 — the clear-text identifier, never the secret. */}
                  {s.secret_prefix}… <span className="not-italic">v{s.secret_version}</span>
                </td>
                <td className="px-4 py-2 text-xs text-muted" role="gridcell">
                  {s.created_at}
                </td>
                <td className="px-4 py-2" role="gridcell">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      data-testid={`subscription-deliveries-${s.id}`}
                      onClick={() => onShowDeliveries(s.id)}
                      className="rounded border border-border px-2 py-0.5 text-xs text-foreground hover:bg-border/40"
                    >
                      Deliveries
                    </button>
                    <button
                      type="button"
                      data-testid={`subscription-toggle-${s.id}`}
                      disabled={busyId === s.id}
                      onClick={() => void toggleActive(s)}
                      title={
                        s.active
                          ? 'Stop attempting deliveries. Reversible, and the delivery history is kept.'
                          : 'Resume attempting deliveries for this event.'
                      }
                      className="rounded border border-border px-2 py-0.5 text-xs text-foreground hover:bg-border/40 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {busyId === s.id ? '…' : s.active ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </div>
                </td>
              </>
            )}
          />
        )}
      </div>

      {/*
        PF-673, stated on the screen rather than only in a tooltip. Both facts
        are measured off the shipped route, not assumed: deactivation stops
        further attempts, and nothing is destroyed by either verb.
      */}
      <p className="m-0 border-t border-border px-4 py-2 text-xs text-muted" data-testid="subscription-lifecycle-note">
        Deactivating a subscription stops further delivery attempts and is reversible. Nothing is
        deleted: the row and its delivery history are retained, so past attempts stay readable in
        the delivery log. There is no destructive action on this screen.
      </p>

      <footer className="flex items-center justify-between gap-3 border-t border-border px-4 py-2">
        <span className="text-xs text-muted">Page {pageNumber}</span>
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="subscriptions-previous"
            onClick={previous}
            disabled={!hasPrevious || loading}
            className="rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-border/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Previous
          </button>
          <button
            type="button"
            data-testid="subscriptions-next"
            onClick={next}
            disabled={!hasNext || loading}
            className="rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-border/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Next
          </button>
        </div>
      </footer>

      {creating && (
        <CreateSubscriptionDialog
          appName={appName}
          onCancel={() => setCreating(false)}
          onCreate={async (input: { event: ShipEventType; target_url: string }) => {
            const created = await create(input);
            // The form unmounts on success, so it cannot be re-submitted, and the
            // secret crosses no route boundary on its way to the dialog (PF-668).
            setCreating(false);
            setIssued(created);
          }}
        />
      )}

      {issued && (
        <SecretOnceDialog
          title="Subscription created"
          appName={`${appName} · ${issued.event}`}
          clientId={issued.id}
          secret={issued.signing_secret}
          identifierLabel="subscription id"
          secretLabel="signing_secret"
          /* Nothing was replaced — this is a first issue. */
          rotationPolicy="none"
          onDismiss={() => {
            setIssued(null);
            reload();
          }}
        />
      )}
    </div>
  );
}
