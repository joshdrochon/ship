/**
 * PF-671 / PF-672 / PF-673 — the selected app's webhook subscriptions, read and
 * written through `@ship/sdk` on that app's own bearer token.
 *
 * PRD p.4 asks the portal to cover *"managing subscriptions"*. p.3 puts them on
 * `/api/v1/webhooks` behind `webhooks:manage`, and that is the whole surface this
 * hook uses: `client.webhooks.list`, `.create`, `.update`, `.delete`. There is no
 * `fetch` here and no URL string — `portalTransport.test.ts` fails the build if
 * either appears, which is what makes p.10's *"reuses the public API like any
 * other client"* a property of the code rather than a claim about it.
 *
 * ── Paging is the delivery log's, for the same reason (PF-671) ──────────────
 * `next_cursor` only. An app may hold arbitrarily many subscriptions — the route
 * declares `list: 'cursor'` precisely because it is not a fixed-cardinality
 * registry — so a client-side "load everything and sort" would be a lie about
 * the collection the moment an app has more than one page of them.
 *
 * ── The write half is deliberately NOT optimistic ───────────────────────────
 * Every mutation re-reads the page it changed. A subscription's `active` flag is
 * a matcher input (PF-426): the dispatcher reads it to decide whether an event
 * produces a delivery at all, so a UI that showed `active: false` optimistically
 * while the server still had `true` would be showing a developer the opposite of
 * what their integration is doing. One extra round trip is the right price.
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  WebhookSubscription,
  WebhookSubscriptionWithSecret,
  ShipEventType,
} from '@ship/sdk';
import { ShipError } from '@ship/sdk';
import { getPortalClient, invalidatePortalClient } from '@/lib/portalClient';
import { toPortalError, type PortalError } from '@/lib/portalError';

export interface UsePortalSubscriptionsResult {
  subscriptions: WebhookSubscription[] | null;
  loading: boolean;
  error: PortalError | null;
  hasNext: boolean;
  hasPrevious: boolean;
  next: () => void;
  previous: () => void;
  reload: () => void;
  pageNumber: number;
  /**
   * Returns the created subscription INCLUDING its `signing_secret` — the only
   * time that value is ever emitted (p.8: *"signing secret returned once"*).
   * The caller holds it in component state and hands it to `SecretOnceDialog`;
   * it must never reach TanStack query state, which `queryClient.ts` persists to
   * IndexedDB (PF-667).
   */
  create: (input: {
    event: ShipEventType;
    target_url: string;
  }) => Promise<WebhookSubscriptionWithSecret>;
  /** `PATCH /webhooks/:id` — the reversible one, in both directions. */
  setActive: (id: string, active: boolean) => Promise<WebhookSubscription>;
  /** `DELETE /webhooks/:id` — which this API implements as a deactivation. */
  deactivate: (id: string) => Promise<WebhookSubscription>;
}

const PAGE_SIZE = 25;

/**
 * Runs one SDK call, re-minting the portal token once on `kind: 'auth'`.
 *
 * PF-660's third state. A PF-652 token lives 15 minutes and a developer reading
 * a delivery log will outlive one; that is the expected case, not an error worth
 * a banner. The retry happens once and only once — a second `auth` failure is a
 * real one and is allowed to surface.
 */
async function withAuthRetry<T>(
  appId: string,
  call: (client: Awaited<ReturnType<typeof getPortalClient>>) => Promise<T>
): Promise<T> {
  const client = await getPortalClient(appId);
  try {
    return await call(client);
  } catch (e) {
    if (e instanceof ShipError && e.kind === 'auth') {
      invalidatePortalClient(appId);
      return await call(await getPortalClient(appId));
    }
    throw e;
  }
}

export function usePortalSubscriptions(appId: string | null): UsePortalSubscriptionsResult {
  const [subscriptions, setSubscriptions] = useState<WebhookSubscription[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<PortalError | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  /** `cursorStack[i]` produced page `i + 1`; page 1 was produced by no cursor. */
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!appId) {
      setSubscriptions(null);
      setError(null);
      return;
    }

    let cancelled = false;
    const cursor = cursorStack[pageIndex] ?? null;

    async function run() {
      setLoading(true);
      setError(null);
      try {
        const page = await withAuthRetry(appId!, (client) =>
          // `cursor` is spread in only when present: `ListOptions.cursor` is
          // `string | undefined`, and sending an explicit `null` would be a
          // parameter the strict allowlist (PF-226) has no slot for.
          client.webhooks.list({
            limit: PAGE_SIZE,
            ...(cursor !== null ? { cursor } : {}),
          })
        );
        if (cancelled) return;
        setSubscriptions(page.data);
        setNextCursor(page.next_cursor ?? null);
      } catch (e) {
        if (cancelled) return;
        setError(toPortalError(e, 'The subscription list could not be loaded.'));
        setSubscriptions(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [appId, pageIndex, cursorStack, nonce]);

  const next = useCallback(() => {
    if (!nextCursor) return;
    setCursorStack((stack) => [...stack.slice(0, pageIndex + 1), nextCursor]);
    setPageIndex((i) => i + 1);
  }, [nextCursor, pageIndex]);

  const previous = useCallback(() => {
    setPageIndex((i) => Math.max(0, i - 1));
  }, []);

  const create = useCallback(
    async (input: { event: ShipEventType; target_url: string }) => {
      if (!appId) throw new Error('No app is selected.');
      const created = await withAuthRetry(appId, (client) => client.webhooks.create(input));
      reload();
      return created;
    },
    [appId, reload]
  );

  const setActive = useCallback(
    async (id: string, active: boolean) => {
      if (!appId) throw new Error('No app is selected.');
      const row = await withAuthRetry(appId, (client) => client.webhooks.update(id, { active }));
      reload();
      return row;
    },
    [appId, reload]
  );

  const deactivate = useCallback(
    async (id: string) => {
      if (!appId) throw new Error('No app is selected.');
      const row = await withAuthRetry(appId, (client) => client.webhooks.delete(id));
      reload();
      return row;
    },
    [appId, reload]
  );

  return {
    subscriptions,
    loading,
    error,
    hasNext: nextCursor !== null,
    hasPrevious: pageIndex > 0,
    next,
    previous,
    reload,
    pageNumber: pageIndex + 1,
    create,
    setActive,
    deactivate,
  };
}
