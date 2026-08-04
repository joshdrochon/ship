/**
 * FG-160 · The client half of the FleetGraph notification contract.
 *
 * One query — the caller's open findings — and four mutations that resolve
 * them. Everything the two UI surfaces need lives here so that neither
 * `AgentBanner` nor the rail indicator has to know the wire shape.
 *
 * ── Why one list query rather than a per-document fetch ─────────────────────
 * `GET /api/fleetgraph/notifications` already returns only this user's open
 * findings, filtered by document visibility server-side, and the realistic
 * cardinality is a handful of rows. Fetching the whole list once lets the rail
 * badge (FG-170), the list view (FG-171) and every mounted banner (FG-156)
 * read the same cache entry, so resolving a finding in the banner makes it
 * disappear from the rail in the same tick without a second round trip.
 *
 * ── Why `:id` is the notification id everywhere below ───────────────────────
 * The approve-path routes key on the notification, not the observation
 * (api/src/routes/fleetgraph/index.ts). The notification row already carries
 * `observationId` and `pendingThreadId`, so the UI never has to hold a second
 * id.
 *
 * ── Optimistic resolution and rollback (FG-159) ─────────────────────────────
 * Accept / Dismiss / Snooze all remove the row from the list immediately: the
 * human has answered, and leaving the banner on screen while a POST completes
 * reads as the click not having registered, which produces double-clicks on a
 * decision that is not idempotent for the user's mental model. On failure the
 * snapshot is restored, so the finding comes back rather than being silently
 * lost — the one outcome worse than a slow banner.
 */
import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiPost } from '@/lib/api';

const API_URL = import.meta.env.VITE_API_URL ?? '';

/** Snooze horizons, in BUSINESS days (PRESEARCH.md Q23). Server enforces 1|3|5. */
export const SNOOZE_HORIZONS = [1, 3, 5] as const;
export type SnoozeDays = (typeof SNOOZE_HORIZONS)[number];
export const DEFAULT_SNOOZE_DAYS: SnoozeDays = 3;

export interface FleetGraphNotification {
  id: string;
  observationId: string;
  title: string;
  body: string | null;
  targetId: string | null;
  targetTitle: string | null;
  targetType: string | null;
  signalType: string;
  fingerprint: string;
  pendingThreadId: string | null;
  requiresApproval: boolean;
  createdAt: string;
}

export interface FleetGraphResolution {
  id: string;
  observationId: string;
  resolution: 'accepted' | 'dismissed' | 'snoozed';
  snoozeUntil: string | null;
  threadId: string | null;
  resumed: boolean;
}

export const fleetGraphKeys = {
  all: ['fleetgraph'] as const,
  notifications: () => ['fleetgraph', 'notifications'] as const,
};

/**
 * Signal types whose target is a SET rather than a single document (FG-161).
 *
 * Q22's one deliberate exception to "the finding surfaces in the document it is
 * about": a load imbalance is not about any one issue, so it is delivered
 * against the sprint (week) the decision would be made on. The server already
 * sets `targetId` to that sprint, so the banner needs no special routing — this
 * constant exists so the banner can SAY that the finding is about the week's
 * whole allocation rather than the document the reader happens to be in.
 */
export const SET_SCOPED_SIGNALS = new Set(['load_imbalance']);

export function isSetScoped(n: Pick<FleetGraphNotification, 'signalType'>): boolean {
  return SET_SCOPED_SIGNALS.has(n.signalType);
}

/**
 * Raw fetch rather than `apiGet`, for the same reason `PlanQualityBanner` uses
 * one: `apiGet` treats any non-JSON or non-200 response as a dead session and
 * redirects to /login. This request now fires on EVERY document page, so a
 * frontend deployed against an API that predates `/api/fleetgraph` would get a
 * 404 HTML page and log the user out on every navigation. Named failure mode:
 * endpoint missing or unreachable → this resolves to no findings, the banner
 * and the rail indicator render nothing, and nothing else degrades.
 *
 * A real 401 is still handled — it just surfaces as "no findings" here and as a
 * redirect from whichever first-class query the page also runs.
 */
async function fetchNotifications(): Promise<FleetGraphNotification[]> {
  const res = await fetch(`${API_URL}/api/fleetgraph/notifications`, {
    credentials: 'include',
  });
  if (!res.ok) return [];
  if (!res.headers.get('content-type')?.includes('application/json')) return [];
  const data = (await res.json()) as { notifications?: FleetGraphNotification[] };
  return data.notifications ?? [];
}

/**
 * The caller's open findings, newest first (server ordering is preserved).
 *
 * `retry: false` because a failed fetch here must not spam a background
 * endpoint, and a missing banner is a silent, harmless degradation — the same
 * posture `PlanQualityBanner` takes when `/api/ai/status` is down.
 */
export function useFleetGraphNotifications() {
  return useQuery<FleetGraphNotification[]>({
    queryKey: fleetGraphKeys.notifications(),
    queryFn: fetchNotifications,
    retry: false,
    staleTime: 60_000,
  });
}

/**
 * The findings whose target is this document.
 *
 * Set-scoped findings (FG-161) arrive here too, because the server points their
 * `targetId` at the sprint — so opening the week shows the load imbalance and
 * opening one of its issues does not.
 */
export function useFleetGraphNotificationsForTarget(targetId: string | undefined) {
  const query = useFleetGraphNotifications();
  const notifications = useMemo(() => {
    if (!targetId) return [];
    return (query.data ?? []).filter((n) => n.targetId === targetId);
  }, [query.data, targetId]);
  return { ...query, notifications };
}

type ResolveAction = 'accept' | 'dismiss' | 'snooze' | 'acknowledge';

interface ResolveVariables {
  id: string;
  action: ResolveAction;
  /** Snooze only. Server defaults to 3 when omitted. */
  days?: SnoozeDays;
}

function endpointFor({ id, action }: ResolveVariables): string {
  if (action === 'acknowledge') return `/api/fleetgraph/notifications/${id}/acknowledge`;
  return `/api/fleetgraph/approvals/${id}/${action}`;
}

/**
 * Resolve a finding. Optimistic, with rollback (FG-159).
 *
 * The body is `{}` for accept / dismiss / acknowledge and `{ days }` for
 * snooze. Every one of those schemas is `.strict()` server-side, so adding a
 * convenience field here would 400 rather than be ignored.
 */
export function useResolveFleetGraphNotification() {
  const queryClient = useQueryClient();

  return useMutation<
    FleetGraphResolution | { id: string; state: string },
    Error,
    ResolveVariables,
    { previous?: FleetGraphNotification[] }
  >({
    mutationFn: async (variables) => {
      const body = variables.action === 'snooze' ? { days: variables.days ?? DEFAULT_SNOOZE_DAYS } : {};
      const res = await apiPost(endpointFor(variables), body);
      if (!res.ok) {
        throw new Error(`Failed to ${variables.action} finding`);
      }
      return res.json();
    },
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: fleetGraphKeys.notifications() });
      const previous = queryClient.getQueryData<FleetGraphNotification[]>(
        fleetGraphKeys.notifications()
      );
      if (previous) {
        queryClient.setQueryData<FleetGraphNotification[]>(
          fleetGraphKeys.notifications(),
          previous.filter((n) => n.id !== variables.id)
        );
      }
      return { previous };
    },
    onError: (_err, _variables, context) => {
      // Put the finding back. A decision that failed to record must reappear —
      // dropping it would make the agent look like it forgot, and for dismiss
      // the user would believe something permanent had happened that did not.
      if (context?.previous) {
        queryClient.setQueryData(fleetGraphKeys.notifications(), context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: fleetGraphKeys.notifications() });
    },
  });
}

/** Convenience wrapper: the four actions as callbacks, plus pending/error state. */
export function useFleetGraphActions() {
  const mutation = useResolveFleetGraphNotification();
  const { mutateAsync } = mutation;

  const accept = useCallback((id: string) => mutateAsync({ id, action: 'accept' }), [mutateAsync]);
  const dismiss = useCallback((id: string) => mutateAsync({ id, action: 'dismiss' }), [mutateAsync]);
  const snooze = useCallback(
    (id: string, days: SnoozeDays = DEFAULT_SNOOZE_DAYS) => mutateAsync({ id, action: 'snooze', days }),
    [mutateAsync]
  );
  const acknowledge = useCallback(
    (id: string) => mutateAsync({ id, action: 'acknowledge' }),
    [mutateAsync]
  );

  return {
    accept,
    dismiss,
    snooze,
    acknowledge,
    isPending: mutation.isPending,
    error: mutation.error,
    reset: mutation.reset,
    /**
     * Which notification the pending/failed decision belongs to.
     *
     * A document can carry more than one finding, and the banner shares a
     * single mutation across its rows (see AgentBanner). Without this, one
     * row's failure would print an error on all of them.
     */
    activeId: mutation.variables?.id ?? null,
  };
}
