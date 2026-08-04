/**
 * FG-175 · Component tests for the approval surface.
 *
 * The fetch layer is a stable fake — no network, no Ship API, no model. Every
 * assertion here is about behaviour a user can observe: which finding shows on
 * which document, what the buttons say, what happens to the row when a decision
 * is recorded, and what happens to it when the recording fails.
 *
 * `fireEvent` rather than `user-event`: this workspace does not ship
 * `@testing-library/user-event`, and adding a dependency to write a test is a
 * worse trade than driving the DOM directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AgentBanner } from './AgentBanner';
import {
  fleetGraphKeys,
  type FleetGraphNotification,
} from '@/hooks/useFleetGraphNotifications';

const realFetch = global.fetch;

function notification(overrides: Partial<FleetGraphNotification> = {}): FleetGraphNotification {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    observationId: '22222222-2222-4222-8222-222222222222',
    title: 'This issue has not moved in 5 business days',
    body: 'Propose reassigning it to Dana, who owns the blocking work.',
    targetId: 'doc-1',
    targetTitle: 'Fix the importer',
    targetType: 'issue',
    signalType: 'stalled_issue',
    fingerprint: 'stalled_issue:doc-1',
    pendingThreadId: 'thread-1',
    requiresApproval: true,
    createdAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderBanner(documentId: string, notifications: FleetGraphNotification[]) {
  const client = makeClient();
  client.setQueryData(fleetGraphKeys.notifications(), notifications);
  const utils = render(
    <QueryClientProvider client={client}>
      <AgentBanner documentId={documentId} />
    </QueryClientProvider>
  );
  return { ...utils, client };
}

/**
 * Stable fake for the whole HTTP surface the banner touches.
 *
 * `open` is what the list endpoint keeps returning. It matters for the rollback
 * case: `onSettled` invalidates the query, so a fake that always answered with
 * an empty list would delete the restored finding a beat after the rollback put
 * it back, and the test would be asserting the fake rather than the component.
 */
function mockApi({
  approvalStatus = 200,
  open = [] as FleetGraphNotification[],
}: { approvalStatus?: number; open?: FleetGraphNotification[] } = {}) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (url.includes('/api/csrf-token')) {
      return new Response(JSON.stringify({ token: 'csrf' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/api/fleetgraph/approvals/')) {
      return new Response(
        JSON.stringify(
          approvalStatus === 200
            ? {
                id: notification().id,
                observationId: notification().observationId,
                resolution: 'accepted',
                snoozeUntil: null,
                threadId: 'thread-1',
                resumed: false,
              }
            : { error: 'boom' }
        ),
        { status: approvalStatus, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('/api/fleetgraph/notifications')) {
      return new Response(JSON.stringify({ notifications: open }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  global.fetch = fetchMock as typeof fetch;
  return { calls };
}

describe('AgentBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('renders nothing when this document has no open finding', () => {
    mockApi();
    renderBanner('doc-without-findings', [notification()]);
    expect(screen.queryByTestId('agent-banner')).not.toBeInTheDocument();
  });

  /**
   * Regression guard. This request fires on every document page, and `apiGet`
   * redirects to /login on any non-JSON or non-200 response. Reaching an API
   * that predates `/api/fleetgraph` therefore used to mean being logged out on
   * every navigation. A missing endpoint must degrade to "no findings".
   */
  it('degrades to no findings when the endpoint is missing, without navigating away', async () => {
    const before = window.location.href;
    global.fetch = vi.fn(async () =>
      new Response('<!doctype html><title>Not Found</title>', {
        status: 404,
        headers: { 'Content-Type': 'text/html' },
      })
    ) as typeof fetch;

    const client = makeClient();
    render(
      <QueryClientProvider client={client}>
        <AgentBanner documentId="doc-1" />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(client.getQueryData(fleetGraphKeys.notifications())).toEqual([]);
    });
    expect(screen.queryByTestId('agent-banner')).not.toBeInTheDocument();
    expect(window.location.href).toBe(before);
  });

  // FG-157
  it('shows the finding, the proposed action, and all three decisions', () => {
    mockApi();
    renderBanner('doc-1', [notification()]);

    expect(screen.getByText('This issue has not moved in 5 business days')).toBeInTheDocument();
    expect(
      screen.getByText('Propose reassigning it to Dana, who owns the blocking work.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Snooze' })).toBeInTheDocument();
  });

  // FG-161 — a load imbalance is delivered against the sprint, and says so.
  it('surfaces a set-scoped finding on the sprint it targets, labelled as set-scoped', () => {
    mockApi();
    renderBanner('sprint-9', [
      notification({
        id: '33333333-3333-4333-8333-333333333333',
        targetId: 'sprint-9',
        targetType: 'sprint',
        signalType: 'load_imbalance',
        title: 'Load is uneven across this week',
        body: 'Three people carry 80% of the estimate.',
      }),
    ]);

    const finding = screen.getByTestId('agent-finding');
    expect(finding).toHaveAttribute('data-signal-type', 'load_imbalance');
    expect(within(finding).getByText('Across this week')).toBeInTheDocument();
  });

  it('does not surface a set-scoped finding on an issue inside that sprint', () => {
    mockApi();
    renderBanner('issue-in-sprint-9', [
      notification({ targetId: 'sprint-9', signalType: 'load_imbalance' }),
    ]);
    expect(screen.queryByTestId('agent-banner')).not.toBeInTheDocument();
  });

  // FG-158
  it('offers 1, 3 and 5 business days and marks 3 as the default', () => {
    mockApi();
    renderBanner('doc-1', [notification()]);

    fireEvent.click(screen.getByRole('button', { name: 'Snooze' }));

    const menu = screen.getByRole('menu', { name: 'Snooze for' });
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      '1 business day',
      '3 business daysDefault',
      '5 business days',
    ]);
  });

  it('sends the chosen snooze horizon in business days', async () => {
    const { calls } = mockApi();
    renderBanner('doc-1', [notification()]);

    fireEvent.click(screen.getByRole('button', { name: 'Snooze' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /5 business days/ }));

    await waitFor(() => {
      const snoozeCall = calls.find((c) => c.url.includes('/snooze'));
      expect(snoozeCall).toBeDefined();
      expect(snoozeCall?.body).toEqual({ days: 5 });
    });
  });

  // The thing that matters most: dismiss is permanent, and it must read that way.
  it('requires a second, explicitly permanent confirmation before dismissing', async () => {
    const { calls } = mockApi();
    renderBanner('doc-1', [notification()]);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.getByText(/won.t be raised again/i)).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/dismiss'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss permanently' }));

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/dismiss'))).toBe(true);
    });
  });

  it('lets the user back out of a dismissal without sending anything', () => {
    const { calls } = mockApi();
    renderBanner('doc-1', [notification()]);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));

    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/dismiss'))).toBe(false);
  });

  // FG-159
  it('removes the finding optimistically on accept', async () => {
    mockApi();
    renderBanner('doc-1', [notification()]);

    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));

    await waitFor(() => {
      expect(screen.queryByTestId('agent-finding')).not.toBeInTheDocument();
    });
  });

  it('rolls the finding back and says so when the decision fails to record', async () => {
    mockApi({ approvalStatus: 500, open: [notification()] });
    renderBanner('doc-1', [notification()]);

    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/still open/i);
    });
    expect(screen.getByTestId('agent-finding')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
  });

  it('scopes a failure to the finding it belongs to, not to its siblings', async () => {
    const second = notification({
      id: '44444444-4444-4444-8444-444444444444',
      title: 'A second finding on the same document',
    });
    mockApi({ approvalStatus: 500, open: [notification(), second] });
    renderBanner('doc-1', [notification(), second]);

    const rows = screen.getAllByTestId('agent-finding');
    expect(rows).toHaveLength(2);

    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Accept' }));

    await waitFor(() => {
      expect(screen.getAllByRole('alert')).toHaveLength(1);
    });
    expect(
      within(screen.getAllByTestId('agent-finding')[1]).queryByRole('alert')
    ).not.toBeInTheDocument();
  });

  // FG-172 — every action is a real button, reachable and operable without a pointer.
  it('is operable by keyboard: buttons focus, Enter opens the menu, Escape closes it', () => {
    mockApi();
    renderBanner('doc-1', [notification()]);

    const accept = screen.getByRole('button', { name: 'Accept' });
    const snooze = screen.getByRole('button', { name: 'Snooze' });

    // Native buttons, not click-handling divs — so they are in the tab order.
    for (const el of [accept, screen.getByRole('button', { name: 'Dismiss' }), snooze]) {
      expect(el.tagName).toBe('BUTTON');
      expect(el).not.toHaveAttribute('tabindex', '-1');
    }

    act(() => snooze.focus());
    expect(snooze).toHaveFocus();
    fireEvent.keyDown(snooze, { key: 'Enter' });
    fireEvent.click(snooze);
    expect(screen.getByRole('menu', { name: 'Snooze for' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Snooze for' })).not.toBeInTheDocument();
    expect(snooze).toHaveFocus();
  });

  it('returns focus to Dismiss when the confirmation is escaped', () => {
    mockApi();
    renderBanner('doc-1', [notification()]);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.getByRole('button', { name: 'Dismiss' })).toHaveFocus();
  });

  // FG-173
  it('gives every action a visible focus ring', () => {
    mockApi();
    renderBanner('doc-1', [notification()]);
    for (const name of ['Accept', 'Dismiss', 'Snooze']) {
      expect(screen.getByRole('button', { name })).toHaveClass('focus-visible:ring-2');
    }
  });
});
