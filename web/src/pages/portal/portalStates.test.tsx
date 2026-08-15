/**
 * PF-660 — *"Empty, error, 401 and 429 states are rendered states — the portal
 * never spins or blanks."*
 *
 * S1 shipped all four and tested one. The other three were the states nobody had
 * driven, which is the wrong three to leave: the empty log is the state a
 * developer sees on a good day, and the three untested ones are what the portal
 * does when something is already wrong. A portal that spins during p.12's demo
 * is a worse look than one that says "rate limited, 12s".
 *
 * These four are asserted through `PortalPage` — the rendered screen — rather
 * than against `usePortalDeliveries` in isolation, because three of them are
 * claims about what a person sees:
 *
 *   empty        an explanatory node naming what would produce a row
 *   error        `message` AND `request_id` (PF-502), quotable in a bug report
 *   401          re-mints ONCE, silently, and the user never learns it happened
 *   429          the wait derived from `Retry-After`, and Retry DISABLED until it
 *                elapses rather than letting the user hammer a limited endpoint
 *
 * `@/lib/portalClient` is faked at the module boundary: what is under test is
 * the page's reaction to each SDK outcome, and a real client would be testing
 * L16's route and L17's transport, both of which have their own suites. The
 * fake still returns the SDK's real `Page<WebhookDelivery>`, so a field the page
 * reads that the contract does not carry is a type error at the keyboard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Page, WebhookDelivery } from '@ship/sdk';
import { ShipError } from '@ship/sdk';

const listDeliveries = vi.fn();
const replay = vi.fn();
const invalidatePortalClient = vi.fn();

const fakeClient = {
  webhooks: {
    list: async () => ({ data: [], next_cursor: null }),
    deliveries: {
      list: (...a: unknown[]) => listDeliveries(...a),
      replay: (...a: unknown[]) => replay(...a),
    },
  },
};

vi.mock('@/lib/portalClient', () => ({
  getPortalClient: async () => fakeClient,
  invalidatePortalClient: (...a: unknown[]) => invalidatePortalClient(...a),
  PortalTokenError: class PortalTokenError extends Error {
    constructor(
      message: string,
      readonly status: number
    ) {
      super(message);
    }
  },
}));

/**
 * The app record and the scope registry are session-surface reads (PF-651) and
 * are not what this file is about. Faked to a quiet 404-shaped answer so the
 * page renders its main content without a second round of unrelated fixtures.
 */
vi.mock('@/lib/api', () => ({
  apiGet: async () => ({ ok: false, status: 404, json: async () => ({ success: false }) }),
  apiPost: async () => ({ ok: false, status: 404, json: async () => ({ success: false }) }),
}));

const { PortalPage } = await import('./PortalPage');

const APP_ID = '11111111-1111-4111-8111-111111111111';

function delivery(over: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    subscription_id: '22222222-2222-4222-8222-222222222222',
    event_id: '66666666-6666-4666-8666-666666666666',
    event_type: 'issue.created',
    attempt_number: 1,
    status: 'delivered',
    response_status: 200,
    response_excerpt: 'ok',
    latency_ms: 87,
    idempotency_key: 'idem-1',
    dlq_reason: null,
    attempted_at: '2026-08-15T10:00:00.000Z',
    created_at: '2026-08-15T10:00:00.000Z',
    replay_of_delivery_id: null,
    ...over,
  } as WebhookDelivery;
}

function page(data: WebhookDelivery[], nextCursor: string | null = null): Page<WebhookDelivery> {
  return { data, next_cursor: nextCursor };
}

function renderPortal(search = '') {
  render(
    <MemoryRouter initialEntries={[`/portal/${APP_ID}${search}`]}>
      <Routes>
        <Route path="/portal/:appId" element={<PortalPage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  listDeliveries.mockReset();
  replay.mockReset();
  invalidatePortalClient.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PF-660 — empty', () => {
  it('names what would produce a delivery rather than showing a blank pane', async () => {
    listDeliveries.mockResolvedValue(page([]));
    renderPortal();

    // The empty state has to answer "why is this empty and what do I do?" —
    // "No deliveries yet" on its own is a blank pane with a caption.
    expect(await screen.findByText('No deliveries yet.')).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/Create a subscription and trigger the event/i);
  });

  it('the DLQ view has its OWN empty state, because an empty DLQ is good news', async () => {
    listDeliveries.mockResolvedValue(page([]));
    renderPortal('?status=dead_lettered');

    expect(await screen.findByText('Nothing in the dead-letter queue.')).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/after six failed attempts/i);
  });
});

describe('PF-660 — error carries `request_id`', () => {
  it('renders the message and the id a developer can quote', async () => {
    listDeliveries.mockRejectedValue(
      new ShipError({
        kind: 'server',
        status: 500,
        code: 'server_error',
        message: 'The delivery log is unavailable.',
        requestId: 'req_deadbeef',
      })
    );
    renderPortal();

    expect(await screen.findByText('The delivery log is unavailable.')).toBeInTheDocument();
    // PF-502 — without this the bug report is "the portal broke".
    expect(document.body.textContent).toContain('req_deadbeef');
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('Retry re-reads, and a recovered read replaces the error', async () => {
    listDeliveries
      .mockRejectedValueOnce(
        new ShipError({
          kind: 'server',
          status: 500,
          code: 'server_error',
          message: 'Transient.',
          requestId: 'req_1',
        })
      )
      // Exactly ONE rejection: the auth-retry path is not taken for
      // `kind: 'server'`, so the first read is the only failure and the Retry
      // click is the second read.
      .mockResolvedValue(page([delivery()]));

    renderPortal();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.queryByText('Transient.')).not.toBeInTheDocument());
    expect(screen.getByText('issue.created')).toBeInTheDocument();
  });
});

describe('PF-660 — an expired portal token re-mints once, silently', () => {
  it('the user sees data, not an auth banner, and the mint happened exactly once', async () => {
    listDeliveries
      .mockRejectedValueOnce(
        new ShipError({
          kind: 'auth',
          status: 401,
          code: 'unauthorized',
          message: 'The access token has expired.',
        })
      )
      .mockResolvedValue(page([delivery()]));

    renderPortal();

    await screen.findByText('issue.created');
    // A 15-minute PF-652 token expiring under a developer reading a log is the
    // EXPECTED case. Surfacing it would train them to ignore the error area.
    expect(screen.queryByText('The access token has expired.')).not.toBeInTheDocument();
    expect(invalidatePortalClient).toHaveBeenCalledTimes(1);
    expect(invalidatePortalClient).toHaveBeenCalledWith(APP_ID);
    expect(listDeliveries).toHaveBeenCalledTimes(2);
  });

  it('a SECOND auth failure surfaces — one retry, not a loop', async () => {
    listDeliveries.mockRejectedValue(
      new ShipError({
        kind: 'auth',
        status: 401,
        code: 'unauthorized',
        message: 'The access token has expired.',
      })
    );
    renderPortal();

    expect(await screen.findByText('The access token has expired.')).toBeInTheDocument();
    expect(listDeliveries).toHaveBeenCalledTimes(2);
  });
});

describe('PF-660 — 429 shows the wait and disables the control', () => {
  it('renders the seconds from `Retry-After` and disables Retry', async () => {
    listDeliveries.mockRejectedValue(
      new ShipError({
        kind: 'rate_limit',
        status: 429,
        code: 'rate_limited',
        message: 'Rate limit exceeded.',
        requestId: 'req_429',
        retryAfterSeconds: 12,
      })
    );
    renderPortal();

    await screen.findByText('Rate limit exceeded.');
    expect(document.body.textContent).toMatch(/Try again in 12s/);
    // PF-304 — this is the developer's OWN per-app bucket. A Retry button that
    // stayed live would let the portal spend the quota their integration needs.
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
    // And it says whose bucket it is, so the number is not a mystery.
    expect(document.body.textContent).toMatch(/shares this app's bucket/i);
  });

  it('a non-429 failure leaves Retry enabled — the user is not punished for a 500', async () => {
    listDeliveries.mockRejectedValue(
      new ShipError({
        kind: 'server',
        status: 502,
        code: 'server_error',
        message: 'Bad gateway.',
        // A 502 may also carry Retry-After. The UI must not disable on it.
        retryAfterSeconds: 30,
      })
    );
    renderPortal();

    await screen.findByText('Bad gateway.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
    expect(document.body.textContent).not.toMatch(/Try again in 30s/);
  });
});

describe('PF-661 — Replay stays usable, and says why when it is not', () => {
  it('is disabled ONLY on `in_flight`, with the reason on the control', async () => {
    listDeliveries.mockResolvedValue(
      page([
        delivery({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'in_flight',
          response_status: null, latency_ms: null, dlq_reason: null }),
        delivery({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'dead_lettered',
          dlq_reason: 'max_attempts_exhausted', response_status: 500 }),
      ])
    );
    renderPortal();

    const inFlight = await screen.findByTestId('replay-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(inFlight).toBeDisabled();
    expect(inFlight.getAttribute('title')).toMatch(/still in flight/i);

    // PF-476 decided replay is not DLQ-only, so every terminal status is live.
    expect(screen.getByTestId('replay-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).toBeEnabled();
  });

  it('is NOT disabled after a successful click, and reports the preserved key', async () => {
    const dead = delivery({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      status: 'dead_lettered',
      dlq_reason: 'max_attempts_exhausted',
      idempotency_key: 'idem-original',
      response_status: 500,
    });
    listDeliveries.mockResolvedValue(page([dead]));
    replay.mockResolvedValue(
      delivery({
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        status: 'in_flight',
        response_status: null,
        latency_ms: null,
        idempotency_key: 'idem-original',
        replay_of_delivery_id: dead.id,
      })
    );

    renderPortal();
    fireEvent.click(await screen.findByTestId(`replay-${dead.id}`));

    await waitFor(() => expect(replay).toHaveBeenCalledWith(dead.id));
    const notice = await screen.findByTestId('replay-notice');
    expect(notice.textContent).toContain('idem-original');
    // PF-479 — two records, one idempotency key, so a second click is safe by
    // construction. Disabling it would break the legitimate re-replay after a
    // second fix.
    await waitFor(() => expect(screen.getByTestId(`replay-${dead.id}`)).toBeEnabled());
  });
});

describe('PF-671 — the subscriptions tab is a peer view, and the log is still the default', () => {
  it('`/portal/:appId` with no `view` renders the delivery log', async () => {
    listDeliveries.mockResolvedValue(page([delivery()]));
    renderPortal();

    // The demo path (p.12) must not gain a click: the log is what a cold
    // navigation lands on. Matched by ROLE — the tab and the heading carry the
    // same words, and a bare text query is ambiguous between them.
    expect(await screen.findByRole('heading', { name: 'Delivery log' })).toBeInTheDocument();
    expect(screen.queryByTestId('subscriptions-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('portal-tab-deliveries')).toHaveAttribute('aria-selected', 'true');
  });

  it('`?view=subscriptions` renders the subscription list instead', async () => {
    listDeliveries.mockResolvedValue(page([]));
    renderPortal('?view=subscriptions');

    expect(await screen.findByTestId('subscriptions-panel')).toBeInTheDocument();
    expect(screen.getByTestId('portal-tab-subscriptions')).toHaveAttribute('aria-selected', 'true');
  });
});
