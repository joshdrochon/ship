import { useEffect } from 'react';

/**
 * Page titles (WCAG 2.4.2 Page Titled, Level A).
 *
 * W7-8: eight of the seventeen pages announced themselves as "Ship | Ship" -- every
 * document editor included, which is the worst case, because that is where a user has
 * many similar pages open at once and the title is the only thing telling them apart.
 * `/login` and `/admin` never touched the title at all and kept index.html's default.
 *
 * No automated rule catches this: axe's `document-title` only asserts a title exists
 * and is non-empty, and "Ship | Ship" is both.
 *
 * One writer, one format. Pages inside the app shell get their title from
 * `useFocusOnNavigate`, which owns the route table; pages rendered outside the shell
 * (login, setup, invite, the super-admin screens, public feedback) call `usePageTitle`
 * directly because no shared layout runs for them.
 */
export const APP_NAME = 'Ship';

/** Sets `document.title` to `"<title> | Ship"`, or plain "Ship" when there is no title. */
export function usePageTitle(title: string | null | undefined) {
  useEffect(() => {
    const trimmed = title?.trim();
    document.title = trimmed ? `${trimmed} | ${APP_NAME}` : APP_NAME;
  }, [title]);
}

/** Human-readable name for each document type, used when a document has no title yet. */
const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  wiki: 'document',
  issue: 'issue',
  project: 'project',
  program: 'program',
  sprint: 'week',
  person: 'person',
  weekly_plan: 'weekly plan',
  weekly_retro: 'retro',
  standup: 'standup',
};

/**
 * Title for a document editor page.
 *
 * The document's own title is the identifying answer, so it wins whenever there is one.
 * New documents are all literally called "Untitled" (see docs/document-model-conventions.md),
 * which is no more distinguishing than "Ship | Ship" was -- so fall back to the type,
 * giving "Untitled issue" rather than a second unusable title.
 */
export function documentPageTitle(
  title: string | null | undefined,
  documentType: string | null | undefined
): string {
  const trimmed = title?.trim();
  if (trimmed && trimmed !== 'Untitled') return trimmed;
  const label = documentType ? DOCUMENT_TYPE_LABELS[documentType] : undefined;
  return label ? `Untitled ${label}` : 'Untitled';
}
