/**
 * The cursor-paging engine, once, for any `/api/v1` collection.
 *
 * ## Why this exists
 *
 * `usePortalDeliveries` grew the whole walk inline — the cursor back-stack, the
 * reset-on-filter-change, the retry-once-on-expired-token, the four rendered
 * states. F113 needed exactly the same behaviour for the audit trail, and a
 * second copy is how the two drift: the day one of them learns that a `null`
 * `next_cursor` means "end of collection" and the other does not, a developer
 * gets a Next button that returns an empty page.
 *
 * So the walk lives here and takes a fetcher.
 *
 * **`usePortalDeliveries` has NOT been migrated onto it.** It is covered by
 * `portalStates.test.tsx` and belongs to another slice; rewriting it to prove a
 * point about duplication would risk a tested demo path (p.12's script runs
 * through it) for no user-visible gain. New code uses this; that hook should be
 * moved when someone is already editing it. Saying so is more useful than
 * leaving the reader to wonder why there are two.
 *
 * ## What it does NOT do
 *
 * No client-side sort, filter or slice over the loaded page. Sorting 25 loaded
 * rows while the user believes they are sorting thousands is a lie they cannot
 * see. Paging is server-side and only server-side: `next_cursor` and nothing
 * else, no `?offset`, no page numbers, no total count.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ShipError } from '@ship/sdk';
import { getPortalClient, invalidatePortalClient } from '@/lib/portalClient';
import { toPortalError, type PortalError } from '@/lib/portalError';

/** One page as `/api/v1` returns it. `next_cursor` is present and null at the end. */
export interface CursorPage<T> {
  data: T[];
  next_cursor?: string | null;
}

type PortalClient = Awaited<ReturnType<typeof getPortalClient>>;

export interface UseCursorPageOptions<T> {
  /** The app whose token the read is made with. `null` disables the hook. */
  appId: string | null;
  /**
   * Serialised filters. A CHANGE resets the walk to page one — without that,
   * Previous walks back through cursors minted for a different query, which the
   * server rejects and the user reads as a broken button.
   */
  filterKey: string;
  /** Rows per request. */
  limit: number;
  /** The SDK call. Never a `fetch` — see `portalTransport.test.ts`. */
  fetchPage: (client: PortalClient, cursor: string | null) => Promise<CursorPage<T>>;
  /** Shown when the read fails for a reason the error carries no message for. */
  errorMessage: string;
}

export interface UseCursorPageResult<T> {
  items: T[] | null;
  loading: boolean;
  error: PortalError | null;
  hasNext: boolean;
  hasPrevious: boolean;
  next: () => void;
  previous: () => void;
  reload: () => void;
  /** 1-based. Shown as "Page N", never as a page COUNT — there is no total. */
  pageNumber: number;
}

export function useCursorPage<T>(options: UseCursorPageOptions<T>): UseCursorPageResult<T> {
  const { appId, filterKey, limit, fetchPage, errorMessage } = options;

  const [items, setItems] = useState<T[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<PortalError | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  /**
   * Cursors already spent, oldest first. `cursorStack[i]` produced page `i + 1`;
   * page 1 was produced by no cursor at all.
   *
   * This is NOT an offset in disguise: every entry is a cursor the SERVER
   * minted, replayed in the order it handed them out.
   */
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);

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

  // `fetchPage` is a fresh closure every render; the effect keys off `filterKey`
  // instead, which is what actually determines the request.
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  useEffect(() => {
    if (!appId) {
      setItems(null);
      setError(null);
      return;
    }

    let cancelled = false;
    const cursor = cursorStack[pageIndex] ?? null;

    async function run(): Promise<void> {
      setLoading(true);
      setError(null);
      try {
        let client = await getPortalClient(appId!);
        let page: CursorPage<T>;
        try {
          page = await fetchRef.current(client, cursor);
        } catch (e) {
          // An expired PF-652 portal token is a `kind: 'auth'` ShipError. Mint a
          // new one and retry ONCE, silently: a 15-minute token expiring
          // mid-session is the expected case, not something the user did wrong.
          // A second failure is real and surfaces.
          if (e instanceof ShipError && e.kind === 'auth') {
            invalidatePortalClient(appId!);
            client = await getPortalClient(appId!);
            page = await fetchRef.current(client, cursor);
          } else {
            throw e;
          }
        }
        if (cancelled) return;
        setItems(page.data);
        setNextCursor(page.next_cursor ?? null);
      } catch (e) {
        if (cancelled) return;
        setError(toPortalError(e, errorMessage));
        setItems(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, filterKey, pageIndex, cursorStack, nonce, limit]);

  const next = useCallback(() => {
    if (!nextCursor) return;
    setCursorStack((stack) => [...stack.slice(0, pageIndex + 1), nextCursor]);
    setPageIndex((i) => i + 1);
  }, [nextCursor, pageIndex]);

  const previous = useCallback(() => setPageIndex((i) => Math.max(0, i - 1)), []);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return {
    items,
    loading,
    error,
    // PF-224: a null `next_cursor` is the end of the collection. Disabling Next
    // on it is the difference between "there is no more" and "there might be —
    // click and find out it was empty".
    hasNext: nextCursor !== null,
    hasPrevious: pageIndex > 0,
    next,
    previous,
    reload,
    pageNumber: pageIndex + 1,
  };
}
