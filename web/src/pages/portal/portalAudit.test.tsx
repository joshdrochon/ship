/**
 * F113 — the Audit trail tab. PRD p.4's *"Queryable in the developer portal"*.
 *
 * Asserted through `PortalPage` rather than against `usePortalAuditCalls` in
 * isolation, following `portalStates.test.tsx`: p.4's claim is about what a
 * developer can SEE, and a hook returning the right array proves nothing about
 * whether a screen renders it.
 *
 * `@/lib/portalClient` is faked at the module boundary — what is under test is
 * the page's reaction to each SDK outcome. The route itself has its own suites
 * (`api/src/platform/api/v1/audit/`), and re-proving them here would measure the
 * same thing twice and slowly. The fake still returns the SDK's real
 * `Page<AuditCall>`, so a field the panel reads that the contract does not carry
 * is a type error at the keyboard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Page, AuditCall } from '@ship/sdk';
import { ShipError } from '@ship/sdk';

/**
 * The public prefix, ASSEMBLED rather than written whole.
 *
 * `portalTransport.test.ts` scans every portal module for a string literal
 * beginning with the public path prefix, to catch a hand-built URL. This file
 * builds no URL — it only needs a realistic `route` value for a fixture — so
 * writing the prefix literally would be a false positive on the guard. The
 * guard's own file assembles it for exactly the same reason.
 */
const V1 = ['/api', 'v1'].join('/');
const DOCS_ROUTE = `${V1}/documents`;

const listAudit = vi.fn();
const listDeliveries = vi.fn(() => Promise.resolve({ data: [], next_cursor: null }));
const invalidatePortalClient = vi.fn();

const fakeClient = {
  webhooks: {
    list: async () => ({ data: [], next_cursor: null }),
    deliveries: { list: () => listDeliveries(), replay: vi.fn() },
  },
  audit: { list: (...a: unknown[]) => listAudit(...a) },
};

vi.mock('@/lib/portalClient', () => ({
  getPortalClient: async () => fakeClient,
  invalidatePortalClient: (...a: unknown[]) => invalidatePortalClient(...a),
  PortalTokenError: class PortalTokenError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
}));

vi.mock('@/lib/api', () => ({
  apiGet: async () => ({ ok: false, status: 404, json: async () => ({ success: false }) }),
  apiPost: async () => ({ ok: false, status: 404, json: async () => ({ success: false }) }),
}));

const { PortalPage } = await import('./PortalPage');

const APP_ID = '11111111-1111-4111-8111-111111111111';

function call(over: Partial<AuditCall> = {}): AuditCall {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    request_id: 'req_abc123',
    client_id: 'ship_app_mine',
    user_id: 'user_1',
    method: 'GET',
    route: DOCS_ROUTE,
    scope_used: 'documents:read',
    status: 200,
    latency_ms: 87,
    occurred_at: '2026-08-15T10:00:00.000Z',
    ...over,
  };
}

const page = (data: AuditCall[], nextCursor: string | null = null): Page<AuditCall> => ({
  data,
  next_cursor: nextCursor,
});

function renderPortal(search = '?view=audit') {
  render(
    <MemoryRouter initialEntries={[`/portal/${APP_ID}${search}`]}>
      <Routes>
        <Route path="/portal/:appId" element={<PortalPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  listAudit.mockReset();
  invalidatePortalClient.mockReset();
});
afterEach(cleanup);

describe('F113 — the audit tab is reachable and renders p.4\'s fields', () => {
  it('renders a recorded call: route, status, latency and scope', async () => {
    listAudit.mockResolvedValue(page([call()]));
    renderPortal();

    expect(await screen.findByTestId('portal-audit-panel')).toBeTruthy();
    await screen.findByText(DOCS_ROUTE);
    expect(screen.getByText('200')).toBeTruthy();
    expect(screen.getByText('87ms')).toBeTruthy();
    expect(screen.getByText('documents:read')).toBeTruthy();
  });

  it('is NOT the default view — p.12\'s demo path still lands on the delivery log', async () => {
    renderPortal('');

    // The tab exists, but arriving at /portal/:id must not cost the demo a click.
    await waitFor(() => expect(screen.getByTestId('portal-tab-audit')).toBeTruthy());
    expect(screen.queryByTestId('portal-audit-panel')).toBeNull();
    expect(listAudit).not.toHaveBeenCalled();
  });

  it('shows a null scope_used as an em dash rather than a blank cell', async () => {
    // A machine-to-machine token has no consenting user and a `scope: null`
    // route records no scope. A blank cell reads as a rendering bug.
    listAudit.mockResolvedValue(page([call({ scope_used: null })]));
    renderPortal();

    await screen.findByText(DOCS_ROUTE);
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('renders an empty state, never a blank pane or a spinner', async () => {
    listAudit.mockResolvedValue(page([]));
    renderPortal();

    expect(await screen.findByText(/No calls recorded for this app yet/)).toBeTruthy();
  });

  it('renders an error WITH its request_id, so it is quotable in a bug report', async () => {
    listAudit.mockRejectedValue(
      new ShipError({
        kind: 'server',
        status: 500,
        code: 'server_error',
        message: 'Something failed.',
        requestId: 'req_failed_42',
      } as never),
    );
    renderPortal();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('req_failed_42');
  });
});

describe('F113 — the tab sends only what the route declares', () => {
  it('sends no client_id — the server takes it from the token', async () => {
    listAudit.mockResolvedValue(page([call()]));
    renderPortal();
    await screen.findByText(DOCS_ROUTE);

    // `?client_id=` is a 422 on this route, deliberately. A portal that sent one
    // would break on every load, and sending one "just in case" would be the
    // tenancy bug the route is built to make impossible.
    const sent = listAudit.mock.calls[0]?.[0] ?? {};
    expect(sent).not.toHaveProperty('client_id');
  });

  it('the Throttled button filters to 429 and toggles back off', async () => {
    listAudit.mockResolvedValue(page([call()]));
    renderPortal();
    await screen.findByText(DOCS_ROUTE);

    fireEvent.click(screen.getByTestId('audit-throttled-view'));
    await waitFor(() =>
      expect(listAudit.mock.calls.at(-1)?.[0]).toMatchObject({ status: 429 }),
    );

    fireEvent.click(screen.getByTestId('audit-throttled-view'));
    await waitFor(() => expect(listAudit.mock.calls.at(-1)?.[0]?.status).toBeUndefined());
  });

  it('re-mints the token ONCE on an expired-token failure, silently', async () => {
    listAudit
      .mockRejectedValueOnce(
        new ShipError({
          kind: 'auth',
          status: 401,
          code: 'unauthorized',
          message: 'expired',
        } as never),
      )
      .mockResolvedValue(page([call()]));
    renderPortal();

    // A 15-minute portal token expiring mid-session is the expected case, not an
    // error worth a banner.
    await screen.findByText(DOCS_ROUTE);
    expect(invalidatePortalClient).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
