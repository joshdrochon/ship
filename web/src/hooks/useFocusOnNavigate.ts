import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { usePageTitle } from './usePageTitle';

/**
 * Focus management hook for accessibility (WCAG 2.4.3)
 * Moves focus to main content on navigation and updates page title
 *
 * @param documentTitle Title of the document currently open in the editor, when the route
 *   is a document editor. Document editors are the one case the path cannot answer --
 *   every one of them is `/documents/:id` -- so the page supplies it. See W7-8 in
 *   hooks/usePageTitle.ts.
 */
export function useFocusOnNavigate(documentTitle?: string | null) {
  const location = useLocation();

  useEffect(() => {
    // Focus the main content area on route change
    const mainContent = document.getElementById('main-content');
    if (mainContent) {
      // Small delay to ensure DOM is updated
      requestAnimationFrame(() => {
        mainContent.focus();
      });
    }
  }, [location.pathname]);

  // Update page title based on route (for screen reader announcements). The document's
  // own title wins when there is one; the route table is the fallback, including while
  // the document is still loading.
  usePageTitle(documentTitle?.trim() || getPageTitle(location.pathname));
}

/**
 * Title for an in-shell route.
 *
 * W7-8: this used to end with `return 'Ship'`, and `${'Ship'} | Ship` is where
 * "Ship | Ship" came from. Eight pages hit that branch -- `/my-week`, `/dashboard`,
 * `/projects` and all five document editors, because `/documents/:id` was never listed
 * at all. Every route the router declares is now answered by name, and the final
 * fallback is a title that at least says which app you are in rather than saying it twice.
 */
function getPageTitle(pathname: string): string {
  if (pathname === '/' || pathname === '/docs') return 'Documents';
  if (pathname.startsWith('/docs/')) return 'Document';
  // Canonical document editor route. The page overrides this with the document's own
  // title as soon as the fetch resolves; until then this is what a user reading the tab
  // sees, so it names the thing being loaded rather than the app.
  if (pathname.startsWith('/documents/')) return 'Document';
  if (pathname === '/my-week') return 'My Week';
  if (pathname === '/dashboard') return 'Dashboard';
  if (pathname === '/issues') return 'Issues';
  if (pathname.startsWith('/issues/')) return 'Issue';
  if (pathname === '/projects') return 'Projects';
  if (pathname.startsWith('/projects/')) return 'Project';
  if (pathname === '/programs') return 'Programs';
  if (pathname.startsWith('/programs/')) return 'Program';
  if (pathname.startsWith('/sprints/')) return 'Week';
  if (pathname === '/team' || pathname === '/team/allocation') return 'Team Allocation';
  if (pathname === '/team/directory') return 'Team Directory';
  if (pathname === '/team/status') return 'Status Overview';
  if (pathname === '/team/reviews') return 'Reviews';
  if (pathname === '/team/org-chart') return 'Org Chart';
  if (pathname.startsWith('/team/')) return 'Person';
  if (pathname.startsWith('/feedback/')) return 'Feedback';
  if (pathname === '/settings/conversions') return 'Converted Documents';
  if (pathname === '/settings') return 'Settings';
  // L22 PF-654. Both portal routes answer here rather than falling through: an
  // app is SELECTED on `/portal/:appId`, it is not a different page, and the
  // app's name is not known at title time without a second read whose only
  // purpose would be the tab. `/portal` and `/portal/:appId` announcing the same
  // title is correct; announcing "Workspace" for both was the defect.
  if (pathname === '/portal' || pathname.startsWith('/portal/')) return 'Developer Portal';
  return 'Workspace';
}
