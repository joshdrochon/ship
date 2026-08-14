/**
 * PF-656 / PF-657 / PF-660 — the delivery log, read through `@ship/sdk`.
 *
 * Every call in this file is `client.webhooks.deliveries.*` on a `ShipClient`.
 * There is no `fetch` here and there is no URL string — that is what PRD p.10's
 * *"reuses the public API like any other client"* means when it is literally
 * true rather than aspirational, and `portalTransport.test.ts` is the assertion.
 *
 * ── Paging is server-side and only server-side (PF-656, PF-677) ─────────────
 * `next_cursor` and nothing else. No `?offset`, no page numbers, and no
 * client-side sort or filter over the loaded page: sorting 25 loaded rows while
 * the user believes they are sorting thousands is a lie they cannot see. A
 * `next_cursor` of `null` is the end of the collection and disables Next.
 *
 * A back-stack of cursors is kept so Previous can go back exactly one page.
 * That is not the same as an offset — each entry is a cursor the server minted,
 * replayed in the order the server handed them out.
 *
 * ── The four rendered states (PF-660) ───────────────────────────────────────
 * empty · error (with `request_id`) · auth-expired (re-mint once, silently) ·
 * rate-limited (show the wait from `Retry-After`, disable the control). None of
 * them is a spinner that never resolves, and none is a blank pane.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WebhookDelivery, DeliveryStatus } from '@ship/sdk';
import { ShipError } from '@ship/sdk';
import { getPortalClient, invalidatePortalClient, PortalTokenError } from '@/lib/portalClient';

/**
 * The three filters PF-464 puts on L08's strict allowlist, and no fourth.
 *
 * The portal sends no parameter the route does not declare — a typo becomes a
 * `validation_failed` the developer can see, not a silently unfiltered page.
 */
export interface DeliveryFilters {
  status?: DeliveryStatus;
  subscription_id?: string;
  event_type?: string;
}

/** What the UI renders instead of guessing. Exactly one of these is non-null. */
export interface PortalError {
  message: string;
  requestId: string | null;
  /** Seconds to wait, when the failure was a 429. */
  retryAfterSeconds: number | null;
}

export interface UsePortalDeliveriesResult {
  deliveries: WebhookDelivery[] | null;
  loading: boolean;
  error: PortalError | null;
  hasNext: boolean;
  hasPrevious: boolean;
  next: () => void;
  previous: () => void;
  reload: () => void;
  /** How many pages in, 1-based. Shown as "Page N", never as a page count. */
  pageNumber: number;
}

const PAGE_SIZE = 25;

function toPortalError(e: unknown): PortalError {
  if (e instanceof ShipError) {
    return {
      message: e.message,
      requestId: e.requestId ?? null,
      retryAfterSeconds: e.kind === 'rate_limit' ? (e.retryAfterSeconds ?? null) : null,
    };
  }
  if (e instanceof PortalTokenError) {
    return { message: e.message, requestId: null, retryAfterSeconds: null };
  }
  return {
    message: e instanceof Error ? e.message : 'The delivery log could not be loaded.',
    requestId: null,
    retryAfterSeconds: null,
  };
}

export function usePortalDeliveries(
  appId: string | null,
  filters: DeliveryFilters
): UsePortalDeliveriesResult {
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<PortalError | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  /**
   * The cursors already spent, oldest first. `cursorStack[i]` is the cursor that
   * produced page `i + 1`; page 1 was produced by no cursor at all.
   */
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);

  // Filters changing resets to page one. Anything else and Previous walks back
  // through cursors that belong to a different query.
  const filterKey = JSON.stringify(filters);
  const lastFilterKey = useRef(filterKey);
  const lastAppId = useRef(appId);
  if (lastFilterKey.current !== filterKey || lastAppId.current !== appId) {
    lastFilterKey.current = filterKey;
    lastAppId.current = appId;
    if (pageIndex !== 0 || cursorStack.length !== 1) {
      setCursorStack([null]);
      setPageIndex(0);
    }
  }

  useEffect(() => {
    if (!appId) {
      setDeliveries(null);
      setError(null);
      return;
    }

    let cancelled = false;
    const cursor = cursorStack[pageIndex] ?? null;

    async function fetchOnce(client: Awaited<ReturnType<typeof getPortalClient>>) {
      return client.webhooks.deliveries.list({
        limit: PAGE_SIZE,
        cursor,
        ...filters,
      });
    }

    async function run() {
      setLoading(true);
      setError(null);
      try {
        let client = await getPortalClient(appId!);
        let page;
        try {
          page = await fetchOnce(client);
        } catch (e) {
          // PF-660: an expired PF-652 token is a `kind: 'auth'` ShipError. Mint
          // a new one and retry ONCE, silently — the user did nothing wrong and
          // a 15-minute token expiring mid-session is the expected case, not an
          // error worth a banner. A second failure is real and surfaces.
          if (e instanceof ShipError && e.kind === 'auth') {
            invalidatePortalClient(appId!);
            client = await getPortalClient(appId!);
            page = await fetchOnce(client);
          } else {
            throw e;
          }
        }
        if (cancelled) return;
        setDeliveries(page.data);
        setNextCursor(page.next_cursor ?? null);
      } catch (e) {
        if (cancelled) return;
        setError(toPortalError(e));
        setDeliveries(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
    // `filterKey` rather than `filters`, which is a fresh object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, filterKey, pageIndex, cursorStack, nonce]);

  const next = useCallback(() => {
    if (!nextCursor) return;
    setCursorStack((stack) => {
      const trimmed = stack.slice(0, pageIndex + 1);
      return [...trimmed, nextCursor];
    });
    setPageIndex((i) => i + 1);
  }, [nextCursor, pageIndex]);

  const previous = useCallback(() => {
    setPageIndex((i) => Math.max(0, i - 1));
  }, []);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return {
    deliveries,
    loading,
    error,
    // PF-224: a null `next_cursor` is the end. Disabling Next on it is the
    // difference between "there is no more" and "there might be, click to find
    // out and get an empty page".
    hasNext: nextCursor !== null,
    hasPrevious: pageIndex > 0,
    next,
    previous,
    reload,
    pageNumber: pageIndex + 1,
  };
}
