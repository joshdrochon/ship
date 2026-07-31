/**
 * Skip link for keyboard/screen reader users - Section 508 compliance (WCAG 2.4.1).
 *
 * W7-9: this markup used to exist once, inline in the app shell (`pages/App.tsx`), so
 * only routes rendered inside that shell had it. `/login` and `/admin` are top-level
 * routes with their own chrome and had none. Extracted rather than copied a third time
 * so there stays exactly one skip link in the codebase to keep correct.
 *
 * Pairs with `<main id="main-content" tabIndex={-1}>`: the target has to be focusable
 * for the link to move focus rather than only scroll, which is also what
 * `useFocusOnNavigate` focuses on every route change.
 */
export function SkipLink({ targetId = 'main-content' }: { targetId?: string }) {
  return (
    <a
      href={`#${targetId}`}
      className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:px-4 focus:py-2 focus:bg-accent focus:text-white focus:rounded-md focus:outline-none focus:ring-2 focus:ring-accent-foreground"
    >
      Skip to main content
    </a>
  );
}
