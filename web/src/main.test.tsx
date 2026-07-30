import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Regression test for W6-1 — "six top-level routes have no error boundary. A
 * render error on any of these unmounts to a blank white page with no recovery
 * path" (audit-report.md Category 6; measured 6 of 6 blank, 0 recovery paths in
 * docs/audit/evidence/w6-1/w6-1-before.json).
 *
 * It imports the real route tree from main.tsx rather than a copy, so it fails if
 * the boundaries are removed from the app — a test against a duplicated <Routes>
 * would keep passing. main.tsx only calls createRoot when a #root element exists,
 * which is what makes importing it here safe.
 *
 * Every page component is mocked to throw, and the providers are mocked to plain
 * pass-throughs so no network or storage is involved.
 */

const boom = (name: string) => () => {
  throw new Error(`W6-1 test: ${name} render error`);
};

vi.mock('@/pages/PublicFeedback', () => ({ PublicFeedbackPage: boom('PublicFeedbackPage') }));
vi.mock('@/pages/Login', () => ({ LoginPage: boom('LoginPage') }));
vi.mock('@/pages/Setup', () => ({ SetupPage: boom('SetupPage') }));
vi.mock('@/pages/InviteAccept', () => ({ InviteAcceptPage: boom('InviteAcceptPage') }));
vi.mock('@/pages/AdminDashboard', () => ({ AdminDashboardPage: boom('AdminDashboardPage') }));
vi.mock('@/pages/AdminWorkspaceDetail', () => ({ AdminWorkspaceDetailPage: boom('AdminWorkspaceDetailPage') }));

// Providers and guards: pass-throughs with a signed-in super admin, so the guards
// let each route render instead of redirecting past the throw.
const passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
vi.mock('@/hooks/useAuth', () => ({
  AuthProvider: passthrough,
  useAuth: () => ({
    user: { id: 'u1', name: 'Dev User', email: 'dev@ship.local' },
    loading: false,
    isSuperAdmin: true,
  }),
}));
vi.mock('@/hooks/useRealtimeEvents', () => ({ RealtimeEventsProvider: passthrough }));
vi.mock('@/contexts/WorkspaceContext', () => ({ WorkspaceProvider: passthrough }));
vi.mock('@/components/ProtectedRoute', () => ({ ProtectedRoute: passthrough }));

/** The six routes W6-1 lists, with a plausible param value for each. */
const UNPROTECTED_ROUTES = [
  '/feedback/00000000-0000-0000-0000-000000000000',
  '/login',
  '/setup',
  '/invite/test-token',
  '/admin',
  '/admin/workspaces/00000000-0000-0000-0000-000000000000',
];

describe('top-level route error boundaries (W6-1 regression)', () => {
  beforeEach(() => {
    // React logs the caught error; that is expected here and would drown the run.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(UNPROTECTED_ROUTES)('shows a recoverable fallback instead of a blank page at %s', async (path) => {
    const { App } = await import('./main');
    const { container } = render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    );

    // The symptom being regressed against: nothing rendered at all.
    expect(container.textContent?.trim()).not.toBe('');

    // Routes are React.lazy since the code-splitting work, so the component that
    // throws is not loaded on the first paint — the tree shows the Suspense
    // fallback first and only reaches the error boundary once the chunk resolves.
    // findBy* waits for that; getBy* asserted against the loading state and saw
    // the spinner instead of the boundary.
    const fallback = await screen.findByTestId('route-error-boundary');
    expect(fallback).toBeInTheDocument();
    // Screen readers must be told, not just sighted users.
    expect(fallback).toHaveAttribute('role', 'alert');

    // And there must be a way out — the audit measured 0 recovery affordances.
    expect(await screen.findByRole('button', { name: /reload/i })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /sign-in/i })).toHaveAttribute('href', '/login');
  });

  it('does not swallow errors from routes that have their own boundary', async () => {
    // Sanity check that the boundary is on the route element and not so high up
    // that it replaces the whole document for an in-app panel error: a route with
    // no error still renders its own content.
    const { App } = await import('./main');
    render(
      <MemoryRouter initialEntries={['/not-a-real-route']}>
        <App />
      </MemoryRouter>
    );
    // Let any lazy chunk settle before asserting absence, so this cannot pass
    // merely because nothing has rendered yet.
    await waitFor(() => expect(screen.queryByTestId('route-error-boundary')).not.toBeInTheDocument());
  });
});
