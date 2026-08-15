/**
 * PF-672 — create a webhook subscription. PRD p.4's *"managing subscriptions"*,
 * write half, and p.8's Subscribe stage: *"Subscription persisted; signing
 * secret returned once."*
 *
 * ── The event type is a SELECT, generated from the registry ─────────────────
 * `SHIP_EVENT_TYPES` comes from `@ship/sdk`, and an `api/` test asserts that
 * array is string-equal to the server's `EVENT_TYPES` (PF-391), so a ninth event
 * type fails by name rather than by a consumer's 422. A free-text field here
 * would make an unregistered type reachable from the UI and turn a typo into a
 * subscription that silently never fires; the server rejects it either way
 * (PF-397), but the point is that the UI cannot ASK for one.
 *
 * That the list is the SDK's rather than a fetch is also what keeps PF-653 true:
 * the portal reads the same constant a stranger installing the package reads.
 *
 * ── `target_url` is validated by the SERVER, rendered on the field ──────────
 * Same rule the register form follows (PF-664). PF-425's check is "absolute
 * https, not pointed into private address space", and it has exceptions this
 * form has no business duplicating — a client-side copy is a copy that drifts,
 * and the first thing it breaks is the one URL a developer legitimately needs.
 * So this dialog submits and renders `details.fields[]` under the field each
 * message names.
 *
 * ── The signing secret goes through PF-666's component ──────────────────────
 * Same masking, same copy-without-render, same acknowledgement, same absence
 * from the DOM until Reveal. It is the same class of value as a `client_secret`
 * — shown once, hashed at rest, unrecoverable — and a second shown-once
 * implementation would be a second place to leak it. The caller holds it in
 * component state; it never reaches TanStack query state, which `queryClient.ts`
 * persists to IndexedDB (PF-667).
 */
import { useCallback, useState } from 'react';
import { SHIP_EVENT_TYPES, ShipError, type ShipEventType } from '@ship/sdk';

export interface CreateSubscriptionDialogProps {
  /** Named on screen so a create cannot be misread as belonging to another app. */
  appName: string;
  onCancel: () => void;
  /**
   * Performs the create. Injected rather than called directly so this component
   * stays a form: the SDK call, the token mint and the auth retry all live in
   * `usePortalSubscriptions`.
   */
  onCreate: (input: { event: ShipEventType; target_url: string }) => Promise<void>;
}

/** `ApiError.details.fields[]`, L07's PF-198 shape. */
interface FieldIssue {
  field: string;
  message: string;
}

function fieldIssues(e: unknown): FieldIssue[] {
  if (!(e instanceof ShipError)) return [];
  const details = e.details as { fields?: FieldIssue[] } | undefined;
  return Array.isArray(details?.fields) ? details.fields : [];
}

export function CreateSubscriptionDialog({
  appName,
  onCancel,
  onCreate,
}: CreateSubscriptionDialogProps) {
  const [event, setEvent] = useState<ShipEventType>(SHIP_EVENT_TYPES[0]);
  const [targetUrl, setTargetUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setSubmitting(true);
    setIssues([]);
    setFailure(null);
    setRequestId(null);
    try {
      await onCreate({ event, target_url: targetUrl.trim() });
    } catch (e) {
      setIssues(fieldIssues(e));
      if (e instanceof ShipError) {
        setFailure(e.message);
        // PF-660 / PF-502 — quotable in a bug report, rather than a shrug.
        setRequestId(e.requestId ?? null);
      } else {
        setFailure(e instanceof Error ? e.message : 'The subscription could not be created.');
      }
    } finally {
      setSubmitting(false);
    }
  }, [event, targetUrl, onCreate]);

  const errorsFor = (field: string) =>
    issues.filter((i) => i.field === field).map((i) => i.message);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-subscription-title"
      data-testid="create-subscription-dialog"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-lg border border-border bg-background p-5 shadow-xl">
        <h2 id="create-subscription-title" className="m-0 text-base font-medium text-foreground">
          New webhook subscription
        </h2>
        <p className="mt-1 mb-4 text-sm text-muted">
          <span className="font-medium text-foreground">{appName}</span> will send a signed request
          to your target URL every time this event happens. The signing secret is returned once, on
          the next screen.
        </p>

        <label
          htmlFor="subscription-event"
          className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted"
        >
          Event
        </label>
        {/*
          A `<select>` over the registry, not an input. An unregistered event type
          is unreachable from this screen — see the header.
        */}
        <select
          id="subscription-event"
          data-testid="subscription-event"
          value={event}
          onChange={(e) => setEvent(e.target.value as ShipEventType)}
          className="mb-1 w-full rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
        >
          {SHIP_EVENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {errorsFor('event').map((m) => (
          <p key={m} className="m-0 mb-2 text-xs text-red-400" data-testid="field-error-event">
            {m}
          </p>
        ))}

        <label
          htmlFor="subscription-target-url"
          className="mt-3 mb-1 block text-xs font-medium uppercase tracking-wide text-muted"
        >
          Target URL
        </label>
        <input
          id="subscription-target-url"
          data-testid="subscription-target-url"
          value={targetUrl}
          onChange={(e) => setTargetUrl(e.target.value)}
          placeholder="https://your-service.example/hooks/ship"
          className="mb-1 w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs text-foreground"
        />
        <p className="m-0 mb-1 text-xs text-muted">
          Absolute <code>https</code>, and not an address inside our own network.
        </p>
        {errorsFor('target_url').map((m) => (
          <p key={m} className="m-0 mb-2 text-xs text-red-400" data-testid="field-error-target-url">
            {m}
          </p>
        ))}

        {failure && (
          <div className="mt-3" role="alert" data-testid="create-subscription-failure">
            <p className="m-0 text-sm text-red-400">{failure}</p>
            {requestId && (
              <p className="m-0 mt-1 font-mono text-xs text-muted">request_id: {requestId}</p>
            )}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-testid="create-subscription-cancel"
            onClick={onCancel}
            className="rounded border border-border px-3 py-1 text-sm text-muted hover:bg-border/40 hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="create-subscription-submit"
            disabled={submitting || targetUrl.trim() === ''}
            onClick={() => void submit()}
            className="rounded border border-accent bg-accent/10 px-3 py-1 text-sm text-accent hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Creating…' : 'Create subscription'}
          </button>
        </div>
      </div>
    </div>
  );
}
