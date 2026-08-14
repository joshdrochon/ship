/**
 * PF-658 / PF-661 — the properties panel (panel 4 of 4) for the selected
 * delivery, rendered into `<aside id="properties-portal">` via `createPortal`,
 * exactly as `Editor` does.
 *
 * ── The field list, and why it is longer than p.4's ─────────────────────────
 * p.4 names `attempt_number`, `response_status`, `latency_ms` and
 * `response_excerpt`. This panel shows those four plus `status`, `dlq_reason`,
 * `idempotency_key` and `replay_of_delivery_id`, which L16 added in PF-458
 * precisely so an operator can tell *"this subscriber has been down for six
 * minutes"* from *"this subscriber returned 410 and is never coming back"*
 * (PF-474). A panel that omits `dlq_reason` throws that distinction away and
 * makes the DLQ a list of identical-looking failures.
 *
 * ── Two rendering rules that are correctness, not polish ────────────────────
 * `response_status: null` renders as **"no response"** and never as blank or as
 * `0`. Null means the request never got an answer — a timeout, a DNS failure, a
 * refused connection — which is a different diagnosis from a `500`, and blank
 * reads as "unknown" while `0` reads as a status code that does not exist.
 *
 * `replay_of_delivery_id` renders as a control that selects the ancestor row,
 * so the history PF-477 deliberately preserves is walkable rather than merely
 * stored.
 */
import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WebhookDelivery } from '@ship/sdk';
import { RevealPanel } from './RevealPanel';

export interface DeliveryDetailPanelProps {
  delivery: WebhookDelivery | null;
  /** Selects another row — used by the `replay_of_delivery_id` link. */
  onSelectDelivery: (id: string) => void;
  /** PF-661. Rendered here as well as on the row, per p.4's Replay row. */
  onReplay: (delivery: WebhookDelivery) => void;
  replaying: boolean;
  replayError: string | null;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
      <span className="break-all text-sm text-foreground">{children}</span>
    </div>
  );
}

export function DeliveryDetailPanel({
  delivery,
  onSelectDelivery,
  onReplay,
  replaying,
  replayError,
}: DeliveryDetailPanelProps) {
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    setTarget(document.getElementById('properties-portal'));
  }, []);

  if (!target) return null;

  const body = delivery ? (
    <div className="flex w-64 flex-col gap-3 overflow-auto border-l border-border p-3">
      <h2 className="m-0 text-sm font-medium text-foreground">Delivery</h2>

      <Field label="status">{delivery.status}</Field>
      <Field label="event type">{delivery.event_type}</Field>
      <Field label="attempt number">{delivery.attempt_number}</Field>
      <Field label="response status">
        {/* null is "the request never got an answer", not 0 and not blank. */}
        {delivery.response_status === null ? 'no response' : delivery.response_status}
      </Field>
      <Field label="latency">
        {delivery.latency_ms === null ? 'not measured' : `${delivery.latency_ms} ms`}
      </Field>
      <Field label="dlq reason">{delivery.dlq_reason ?? 'not dead-lettered'}</Field>
      <Field label="idempotency key">
        <span className="font-mono text-xs">{delivery.idempotency_key}</span>
      </Field>
      <Field label="subscription">
        <span className="font-mono text-xs">{delivery.subscription_id}</span>
      </Field>
      <Field label="attempted at">{delivery.attempted_at ?? 'not yet attempted'}</Field>

      <Field label="replay of">
        {delivery.replay_of_delivery_id ? (
          <button
            type="button"
            onClick={() => onSelectDelivery(delivery.replay_of_delivery_id!)}
            className="font-mono text-xs text-accent underline hover:text-accent-hover"
          >
            {delivery.replay_of_delivery_id}
          </button>
        ) : (
          'original delivery'
        )}
      </Field>

      {/* PF-659 — a third party's response body, collapsed until asked for. */}
      <RevealPanel
        label="response excerpt"
        value={delivery.response_excerpt}
        emptyText="no body captured"
      />
      <RevealPanel
        label="signature header"
        value={delivery.signature_header}
        emptyText="not recorded"
      />

      <div className="mt-2 flex flex-col gap-1 border-t border-border pt-3">
        <button
          type="button"
          data-testid="replay-delivery-detail"
          disabled={delivery.status === 'in_flight' || replaying}
          onClick={() => onReplay(delivery)}
          className="rounded border border-border px-2 py-1 text-sm text-foreground hover:bg-border/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {replaying ? 'Replaying…' : 'Replay'}
        </button>
        {delivery.status === 'in_flight' && (
          <span className="text-xs text-muted">
            In flight — wait for this attempt to finish before replaying it.
          </span>
        )}
        {replayError && (
          <span className="text-xs text-red-400" role="alert">
            {replayError}
          </span>
        )}
      </div>
    </div>
  ) : (
    <div className="flex w-64 flex-col gap-2 border-l border-border p-3">
      <h2 className="m-0 text-sm font-medium text-foreground">Delivery</h2>
      <p className="m-0 text-sm text-muted">
        Select a delivery to see its attempt number, response status, latency and dead-letter
        reason.
      </p>
    </div>
  );

  return createPortal(body, target);
}
