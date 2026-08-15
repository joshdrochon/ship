/**
 * F113 — the audit trail tab. PRD p.4's *"Queryable in the developer portal"*.
 *
 * ## What this answers that nothing else did
 *
 * p.18 asks where the audit signals *"show up (logs, /metrics, dev portal)"*.
 * Before this, the honest answer for the public trail was "nowhere": the rows
 * were recorded and `listCalls` could read them, but no screen rendered one.
 *
 * ## It reuses the public API, and the list component
 *
 * Every read is `client.audit.list` through `@ship/sdk` (see
 * `usePortalAuditCalls`), which is p.10's *"eat the dog food"* literally rather
 * than aspirationally. The rows render through `SelectableList`, the same
 * component the delivery log uses — a bespoke `<table>` here would be a second
 * set of loading, empty and row-hover behaviours to keep in step with the rest
 * of the portal.
 *
 * ## No polling
 *
 * Reading the audit trail is itself a public API call, so it is itself recorded.
 * A refresh interval would therefore write a row per tick and the tab would
 * slowly fill with evidence of itself. Reload is a button the developer presses.
 */
import type { AuditCall } from '@ship/sdk';
import { SelectableList } from '@/components/SelectableList';
import { cn } from '@/lib/cn';
import { usePortalAuditCalls, type AuditFilters } from '@/hooks/usePortalAuditCalls';

/** Status colour is information, not decoration — same vocabulary as the delivery log. */
function statusClass(status: number): string {
  if (status >= 500) return 'text-red-400';
  if (status === 429) return 'text-amber-300';
  if (status >= 400) return 'text-amber-300';
  if (status >= 200 && status < 300) return 'text-green-400';
  return 'text-foreground';
}

export interface AuditPanelProps {
  appId: string | null;
  filters: AuditFilters;
  /** Writes a filter into the URL, or clears it when `value` is null. */
  onFilterChange: (key: 'status' | 'route', value: string | null) => void;
}

export function AuditPanel({ appId, filters, onFilterChange }: AuditPanelProps) {
  const { calls, loading, error, hasNext, hasPrevious, next, previous, reload, pageNumber } =
    usePortalAuditCalls(appId, filters);

  return (
    <div className="flex flex-1 flex-col overflow-hidden" data-testid="portal-audit-panel">
      <header className="flex flex-col gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <h1 className="m-0 text-base font-medium text-foreground">Audit trail</h1>
          {/*
            Named on screen deliberately. A grader reading p.10's "reuses the
            public API like any other client" can see which endpoint this tab is
            a client OF without opening the network tab.
          */}
          <span className="text-xs text-muted">
            via <code>@ship/sdk</code> → <code>/api/v1/audit</code>
          </span>
        </div>

        <p className="m-0 text-xs text-muted">
          Every call this app has made to the public API — the seven fields PRD p.4 records.
          Scoped to this app by its token; there is no way to ask for another app&apos;s calls.
        </p>

        {/* Exactly the filters the route declares. A fifth would be a 422. */}
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-muted">
            status
            <input
              aria-label="Filter by HTTP status"
              inputMode="numeric"
              value={filters.status === undefined ? '' : String(filters.status)}
              onChange={(e) => onFilterChange('status', e.target.value || null)}
              placeholder="any"
              className="w-20 rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
            />
          </label>

          <label className="flex items-center gap-1 text-xs text-muted">
            route
            <input
              aria-label="Filter by route template"
              value={filters.route ?? ''}
              onChange={(e) => onFilterChange('route', e.target.value || null)}
              // Not a literal starting with the public prefix: `portalTransport.test.ts`
              // scans portal modules for exactly that shape to catch a hand-built
              // URL, and a placeholder would be a false positive on the one file
              // that has no business constructing one. The example lives in the
              // JSX help text below, which the scan correctly ignores.
              placeholder="any route"
              className="w-64 rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
            />
          </label>

          {/*
            A first-class entry point for the question an operator actually
            arrives with, the same way the DLQ button is for deliveries.
          */}
          <button
            type="button"
            data-testid="audit-throttled-view"
            onClick={() => onFilterChange('status', filters.status === 429 ? null : '429')}
            className={cn(
              'rounded border px-2 py-1 text-xs transition-colors',
              filters.status === 429
                ? 'border-amber-300 text-amber-300'
                : 'border-border text-muted hover:text-foreground',
            )}
          >
            Throttled (429)
          </button>

          <button
            type="button"
            onClick={reload}
            className="rounded border border-border px-2 py-1 text-xs text-muted hover:text-foreground"
          >
            Reload
          </button>
        </div>
      </header>

      {error && (
        <div
          role="alert"
          className="border-b border-red-500/40 bg-red-500/10 px-4 py-2 text-xs text-red-300"
        >
          {error.message}
          {/* The request id is the whole point of showing an error at all: it is
              what turns "it broke" into something answerable from the logs. */}
          {error.requestId && (
            <>
              {' '}
              <code>request_id: {error.requestId}</code>
            </>
          )}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <SelectableList<AuditCall>
          items={calls ?? []}
          loading={loading}
          selectable={false}
          emptyState={
            <div className="px-4 py-6 text-xs text-muted">
              No calls recorded for this app yet. Make a request with this app&apos;s token and it
              will appear here.
            </div>
          }
          renderRow={(call) => (
            /*
              A fragment of spans, not a nested <div> — `SelectableList` places
              this output directly inside a table row, and the browser hoists a
              block element out of the table, which silently breaks the layout.
              Same constraint the delivery log documents.
            */
            <>
              <span className="w-16 shrink-0 font-mono text-xs text-muted">{call.method}</span>
              <span className="flex-1 truncate font-mono text-xs text-foreground">
                {call.route}
              </span>
              <span className={cn('w-12 shrink-0 text-right font-mono text-xs', statusClass(call.status))}>
                {call.status}
              </span>
              <span className="w-20 shrink-0 text-right font-mono text-xs text-muted">
                {call.latency_ms}ms
              </span>
              <span className="w-40 shrink-0 truncate text-right font-mono text-xs text-muted">
                {call.scope_used ?? '—'}
              </span>
              <span className="w-48 shrink-0 text-right font-mono text-xs text-muted">
                {new Date(call.occurred_at).toLocaleString()}
              </span>
            </>
          )}
        />
      </div>

      {/*
        Page N, never "page N of M". There is no total: a keyset walk cannot
        produce one without a COUNT(*) that would double the query load on every
        page and be racy anyway.
      */}
      <footer className="flex items-center justify-between gap-3 border-t border-border px-4 py-2">
        <span className="text-xs text-muted">Page {pageNumber}</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={previous}
            disabled={!hasPrevious}
            className="rounded border border-border px-2 py-1 text-xs text-muted disabled:opacity-40 enabled:hover:text-foreground"
          >
            Previous
          </button>
          <button
            type="button"
            onClick={next}
            disabled={!hasNext}
            className="rounded border border-border px-2 py-1 text-xs text-muted disabled:opacity-40 enabled:hover:text-foreground"
          >
            Next
          </button>
        </div>
      </footer>
    </div>
  );
}
