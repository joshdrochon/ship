import { Component, type ErrorInfo, type ReactNode } from 'react';

interface RouteErrorBoundaryProps {
  children: ReactNode;
  /** Shown in the fallback so a bug report can name the route. */
  label?: string;
}

interface RouteErrorBoundaryState {
  error: Error | null;
}

/**
 * Top-level boundary for routes that render outside the app shell.
 *
 * W6-1: the only boundaries were inside `AppLayout` and the document editor, both
 * of which sit under the `/` route. Everything routed outside it — `/login`,
 * `/setup`, `/invite/:token`, `/admin`, `/admin/workspaces/:id` and the public
 * `/feedback/:programId` — had none, so a render error unmounted the tree to a
 * blank white page: measured at 6 of 6 routes blank, with 0 recovery affordances
 * offered (docs/audit/evidence/w6-1/).
 *
 * This differs from `ErrorBoundary` (used inside the app for panel-level errors)
 * in the two ways that matter for an unauthenticated visitor:
 *
 *  - It does not offer "Try Again", which re-renders the same broken tree. At the
 *    route level the useful actions are a full reload and a way out to sign-in.
 *  - It renders standalone, centred, with its own background, because there is no
 *    app chrome around it to sit inside.
 *
 * It deliberately shows no stack trace: `/feedback/:programId` is public and
 * unauthenticated, so the fallback is read by people outside the organisation.
 * The detail goes to the console for whoever is looking at the browser log.
 */
export class RouteErrorBoundary extends Component<RouteErrorBoundaryProps, RouteErrorBoundaryState> {
  constructor(props: RouteErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): RouteErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(`[RouteErrorBoundary${this.props.label ? ` ${this.props.label}` : ''}] Uncaught error:`, error);
    console.error('[RouteErrorBoundary] Component stack:', errorInfo.componentStack);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div
        role="alert"
        data-testid="route-error-boundary"
        className="flex min-h-screen items-center justify-center bg-background p-8"
      >
        <div className="flex max-w-md flex-col items-center gap-4 text-center">
          <h1 className="m-0 text-lg font-medium text-foreground">This page failed to load</h1>
          <p className="m-0 text-sm text-muted">
            Something went wrong while displaying this page. Nothing you have saved is
            affected. Reloading usually clears it — if it does not, contact your
            workspace administrator.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={this.handleReload}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-border/50"
            >
              Reload the page
            </button>
            {/* A plain link, not a router navigation: the router is inside the
                subtree that just threw, so navigating within it can rethrow. */}
            <a
              href="/login"
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-border/50"
            >
              Go to sign-in
            </a>
          </div>
        </div>
      </div>
    );
  }
}
