/**
 * Reusable test helpers for flaky-resistant E2E test patterns.
 *
 * These helpers encapsulate retry logic for common interactions that
 * fail under parallel test load due to timing issues.
 */
import { expect, type Page, type Locator } from '@playwright/test';

/**
 * Trigger the TipTap mention autocomplete popup by typing '@' in the editor.
 *
 * Under parallel load, the '@' keystroke may not trigger the mention popup
 * on the first attempt — the editor may not be focused, the mention extension
 * may not be initialized, or the keystroke may be swallowed. This helper
 * retries by re-clicking the editor, clearing content, and retyping '@'
 * until the popup appears.
 *
 * @param page - The Playwright page (or second page in multi-context tests)
 * @param editor - Locator for the .ProseMirror editor element
 * @returns Locator for the mention popup listbox (already confirmed visible)
 *
 * @example
 * const editor = page.locator('.ProseMirror')
 * await triggerMentionPopup(page, editor)
 * await page.keyboard.type('Document Name')
 * const option = page.locator('[role="option"]').filter({ hasText: 'Document Name' })
 * await option.click()
 */
export async function triggerMentionPopup(page: Page, editor: Locator): Promise<Locator> {
  const mentionPopup = page.locator('[role="listbox"]');
  await expect(async () => {
    await editor.click();
    await expect(editor).toBeFocused({ timeout: 3000 });
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(300);
    await page.keyboard.type('@');
    await expect(mentionPopup).toBeVisible({ timeout: 5000 });
  }).toPass({ timeout: 30000, intervals: [1000, 2000, 3000, 4000, 5000] });
  return mentionPopup;
}

/**
 * Hover over an element and verify an assertion, with retry.
 *
 * Under parallel load, Playwright's hover() may not trigger the expected
 * React state update (e.g., onMouseEnter setting focus or revealing a checkbox).
 * This can happen when the DOM shifts due to late-loading data, or when the
 * hover event fires on a stale element reference. This helper retries the
 * hover + assertion until it succeeds.
 *
 * @param target - The element to hover over
 * @param assertion - An async function containing the expect assertion to verify after hover
 *
 * @example
 * // Verify focus ring appears on hover
 * await hoverWithRetry(rows.nth(2), async () => {
 *   await expect(rows.nth(2)).toHaveAttribute('data-focused', 'true', { timeout: 3000 })
 * })
 *
 * // Verify checkbox becomes visible on hover
 * await hoverWithRetry(firstRow, async () => {
 *   await expect(checkboxContainer).toHaveCSS('opacity', '1', { timeout: 3000 })
 * })
 */
export async function hoverWithRetry(
  target: Locator,
  assertion: () => Promise<void>,
): Promise<void> {
  await expect(async () => {
    await target.hover();
    await assertion();
  }).toPass({ timeout: 10000, intervals: [500, 1000, 2000] });
}

/**
 * Wait for a data table to be fully loaded and stable before interacting.
 *
 * Under parallel load, tables may render incrementally — the first few rows
 * appear, then more data arrives causing re-renders that shift row positions.
 * Interacting with rows during this unstable period causes hover/click to
 * target the wrong element. This helper waits for both the first row to
 * render AND network activity to settle.
 *
 * @param page - The Playwright page
 * @param tableSelector - CSS selector for the table body rows (default: 'table tbody tr')
 *
 * @example
 * await waitForTableData(page)
 * // Table is now stable — safe to hover, click, or count rows
 * const rows = page.locator('tbody tr')
 * await hoverWithRetry(rows.first(), async () => { ... })
 */
export async function waitForTableData(
  page: Page,
  tableSelector = 'table tbody tr',
): Promise<void> {
  await expect(page.locator(tableSelector).first()).toBeVisible({ timeout: 15000 });
  await page.waitForLoadState('networkidle');
}

/**
 * Wait for the editor's slash-command menu to be on screen.
 *
 * Replaces `await page.waitForTimeout(500)` after typing a `/` command. The menu renders
 * asynchronously; 500 ms is enough on a developer laptop and not enough on a CI runner,
 * where the same suite takes five times as long. When the menu was late, the `Enter` that
 * follows reached nothing — so no file chooser opened and the test sat until its 60 s
 * timeout. That single pattern accounted for most of one CI run's failures, concentrated
 * in the specs that upload files.
 *
 * `data-testid="slash-menu"` exists on the container for this; nothing else about it is
 * stable, since it carries only utility classes.
 */
export async function waitForSlashMenu(page: Page): Promise<void> {
  await expect(page.getByTestId('slash-menu')).toBeVisible({ timeout: 15000 });
}

/**
 * Extract the document UUID from a `/documents/:id` URL.
 */
export function documentIdFromUrl(url: string): string {
  const id = url.split('/documents/')[1]?.split(/[?#/]/)[0];
  if (!id) throw new Error(`Not a document URL: ${url}`);
  return id;
}

/**
 * Wait until the server actually holds `title` for this document.
 *
 * WHY THIS EXISTS (lane-6b). Tests used to wait for
 * `PATCH /api/documents/:id` as their signal that a title had saved. W6-9 moved
 * the title into the Yjs CRDT, so it is now persisted by the collaboration
 * server's debounced write instead. The REST PATCH still fires, but only as a
 * fallback when the collaboration socket has not synced within 1.5s of typing
 * (see web/src/hooks/useCollaborativeTitle.ts) — which makes waiting for it a
 * race, not a reliable signal.
 *
 * Asserting on the outcome instead is correct under either transport: the title
 * is saved when the API serves it back. Rule 2 (brief p.8) permits fixing a test
 * with justification; the justification is that the transport changed by design
 * while the behaviour did not.
 *
 * @param page - The Playwright page, used for its baseURL-aware request context
 * @param title - The title the document should end up with
 * @param docId - Document id; defaults to the one in the page's current URL
 */
export async function expectDocumentTitleSaved(
  page: Page,
  title: string,
  docId?: string,
): Promise<void> {
  const id = docId ?? documentIdFromUrl(page.url());
  await expect(async () => {
    const resp = await page.request.get(`/api/documents/${id}`);
    expect(resp.ok(), `GET /api/documents/${id} should succeed`).toBeTruthy();
    expect((await resp.json()).title).toBe(title);
  }).toPass({ timeout: 15000 });
}

/**
 * Fill the document title field and wait until the server has stored it.
 *
 * Replaces the older "fill, then wait for a PATCH" pattern. See
 * `expectDocumentTitleSaved` for why that pattern no longer holds.
 */
export async function setDocumentTitle(page: Page, title: string): Promise<void> {
  const titleInput = page.getByPlaceholder('Untitled');
  await expect(titleInput).toBeVisible({ timeout: 5000 });
  await titleInput.fill(title);
  await expectDocumentTitleSaved(page, title);
}
