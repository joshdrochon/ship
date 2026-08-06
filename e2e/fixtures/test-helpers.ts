/**
 * Reusable test helpers for flaky-resistant E2E test patterns.
 *
 * These helpers encapsulate retry logic for common interactions that
 * fail under parallel test load due to timing issues.
 */
import { expect, type Page, type Locator, type FileChooser } from '@playwright/test';

/**
 * How long to wait for the OS file chooser after clicking an upload control.
 *
 * Ten seconds is a bound, not a guess. `features-real.spec.ts` has waited 5000 ms for
 * the same event since it was written and passes wherever the chooser opens at all;
 * this is double that. When the chooser works it opens in milliseconds — the value is
 * sized for a loaded runner, not for a broken one.
 */
export const FILE_CHOOSER_TIMEOUT_MS = 10_000;

/**
 * Wait for the file chooser, with a bound and a message.
 *
 * Call it *before* the click that opens the chooser and await the returned promise
 * after, exactly as with `page.waitForEvent('filechooser')` — this is a drop-in for
 * that call:
 *
 *     const chooser = expectFileChooser(page)
 *     await page.getByRole('button', { name: 'Upload' }).click()
 *     await (await chooser).setFiles(path)
 *
 * Why it exists. Twenty-four call sites used the bare `page.waitForEvent('filechooser')`,
 * which has no timeout of its own and therefore inherits the 60 s test timeout from
 * `playwright.config.ts`. On GitLab's runner the chooser does not open for 27 of these
 * tests — a real failure whose cause is still unidentified — and each of those attempts
 * sat for the full 60 s, three times over with CI retries.
 *
 * Measured on job `61094` (commit `0a21232`): `file-attachments.spec.ts` alone took
 * **39.7 of the run's 77.1 minutes**, at 61.2 s per test. The five upload-related specs
 * together were 53 minutes, 69% of the job. The remaining 69 spec files ran ~820 tests
 * in ~24 minutes — about 1.8 s each, which is *faster* per test than GitHub's runner
 * manages. The job was not slow. It was waiting.
 *
 * Bounding the wait does not hide the failure: the test still fails, still retries,
 * still uploads its artifacts. It fails in 10 s instead of 60, and it says which step
 * gave up. `Test timeout of 60000ms exceeded` named no step at all, which is part of
 * why the cause went unidentified for so long.
 */
export function expectFileChooser(
  page: Page,
  timeout: number = FILE_CHOOSER_TIMEOUT_MS,
): Promise<FileChooser> {
  return page.waitForEvent('filechooser', { timeout }).catch((cause) => {
    throw new Error(
      `the file chooser never opened within ${timeout} ms. The control was clicked but ` +
        'no `filechooser` event arrived, so the upload never started. This is the ' +
        'GitLab-runner failure recorded in .gitlab-ci.yml — it does not reproduce on ' +
        'GitHub and its cause is not identified.',
      { cause },
    );
  });
}

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

/**
 * Wait until the server actually holds the editor content this test just produced.
 *
 * WHY THIS EXISTS. Editor content is a Yjs CRDT synced over the collaboration
 * socket, and the collaboration server writes it to Postgres on a debounce:
 *
 *   api/src/collaboration/index.ts:184   PERSIST_DEBOUNCE_MS = 2000
 *   api/src/collaboration/index.ts:195   PERSIST_MAX_WAIT_MS  = 3000
 *
 * Several tests bet against those numbers directly — `waitForTimeout(2000)` and
 * then `page.reload()`. That wait can never be long enough. It is measured from
 * the test's clock, which starts before the last Yjs update has reached the
 * server, while the server's 2000 ms starts when the update arrives and is
 * followed by a database write. The test reloads at or before the moment the
 * data lands, so it passes on timing luck and fails more often under load.
 *
 * That is the whole image- and mention-persistence flake cluster: four of the
 * eight flaky tests in the run that prompted this, all of them "mutate, sleep,
 * reload, assert it survived".
 *
 * Waiting on the outcome removes the bet. `GET /api/documents/:id` serves the
 * persisted content, so when the predicate passes, the reload is safe by
 * construction rather than by arithmetic. Same reasoning as
 * `expectDocumentTitleSaved` above, applied to the body instead of the title.
 *
 * Deliberately NOT solved by lowering the debounce under test. The debounce is
 * behaviour under test — a 2 s coalescing window is what production runs, and a
 * suite that only passes with a faster one is not testing the shipped system.
 *
 * @param page - Playwright page, used for its baseURL-aware request context
 * @param predicate - Given the document's persisted content JSON, is it saved yet?
 * @param docId - Document id; defaults to the one in the page's current URL
 */
export async function expectContentPersisted(
  page: Page,
  predicate: (content: unknown) => boolean,
  docId?: string,
): Promise<void> {
  const id = docId ?? documentIdFromUrl(page.url());
  await expect(async () => {
    const resp = await page.request.get(`/api/documents/${id}`);
    expect(resp.ok(), `GET /api/documents/${id} should succeed`).toBeTruthy();
    const body = await resp.json();
    expect(
      predicate(body.content),
      `document ${id} content has not reached the expected state yet`,
    ).toBeTruthy();
  }).toPass({ timeout: 20000 });
}

/**
 * Count nodes of a given TipTap type anywhere in a document's content tree.
 *
 * Used with `expectContentPersisted` to assert "the server has N images" without
 * every caller re-implementing the walk. Returns 0 for null/undefined content,
 * which is the shape a freshly created document has before its first save.
 */
export function countNodesOfType(content: unknown, type: string): number {
  if (!content || typeof content !== 'object') return 0;
  const node = content as { type?: string; content?: unknown[] };
  let n = node.type === type ? 1 : 0;
  if (Array.isArray(node.content)) {
    for (const child of node.content) n += countNodesOfType(child, type);
  }
  return n;
}

/**
 * Wait until the server's persisted content contains `text`.
 *
 * The text-shaped sibling of `expectContentPersisted`, and the one most call sites
 * want: the great majority of "sleep, then reload, then assert the text survived"
 * tests are asserting exactly this. See that function's header for why the sleep
 * they replace can never be long enough.
 */
export async function expectTextPersisted(
  page: Page,
  text: string,
  docId?: string,
): Promise<void> {
  await expectContentPersisted(page, (c) => textOfContent(c).includes(text), docId);
}

/**
 * Flatten a TipTap content tree to its text, the way the editor renders it.
 *
 * Node text is joined with newlines rather than concatenated, so `Parent item 1`
 * and `Parent item 2` in separate blocks cannot accidentally satisfy a search for
 * `Parent item 12`.
 */
export function textOfContent(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const node = content as { type?: string; text?: string; content?: unknown[] };
  if (typeof node.text === 'string') return node.text;
  if (!Array.isArray(node.content)) return '';
  return node.content.map(textOfContent).join('\n');
}

/**
 * Pick an item from the slash menu by name, and wait until it is actually there.
 *
 * WHY THIS EXISTS. `waitForSlashMenu` asserts that the menu *container* is visible
 * — `[data-testid="slash-menu"]` — and nothing about its contents. Tests then press
 * Enter to take whatever is highlighted. When the container has rendered but the
 * filtered items have not, Enter selects nothing, the file chooser never opens, and
 * the test sits in `page.waitForEvent('filechooser')` until the 60 s test timeout.
 *
 * That single mechanism was six of the ten flaky tests in one run — every image
 * upload in `data-integrity.spec.ts` and `images.spec.ts`. All of them reported the
 * same thing:
 *
 *   Test timeout of 60000ms exceeded.
 *   Error: page.waitForEvent: Test timeout of 60000ms exceeded.
 *   waiting for event "filechooser"
 *
 * `performance.spec.ts` already worked around it with a hand-rolled retry loop
 * (`getByRole('button', { name: /Image.*Upload/i })`, three attempts, retyping the
 * command in between). That workaround was correct and undiscoverable — it lived
 * inside one test and nothing pointed the other specs at it. This is that fix,
 * promoted to where every caller can reach it.
 *
 * Clicking rather than pressing Enter is deliberate: `selectItem(index)` is bound to
 * the button's onClick (`SlashCommands.tsx:126`), so a click exercises the same code
 * path with no dependence on which item the keyboard cursor happens to be on.
 *
 * @param page - The Playwright page
 * @param name - Accessible-name pattern for the item, e.g. /Image.*Upload/i
 */
export async function chooseSlashMenuItem(page: Page, name: RegExp): Promise<void> {
  await waitForSlashMenu(page);

  // `.first()` rather than requiring a unique match. A menu button's accessible
  // name is its title AND its description joined (`SlashCommands.tsx:137-140`), so
  // `/Table/i` legitimately matches both "Table" and "Table of Contents" and a
  // strict locator would throw. Taking the first is not a weakening: pressing
  // Enter — what every one of these call sites did before — selects
  // `selectedIndex`, which starts at 0. This is the same choice, made after
  // waiting for the item to exist instead of before.
  const item = page.getByTestId('slash-menu').getByRole('button', { name }).first();
  await expect(
    item,
    `slash menu item ${name} never rendered — the menu container being visible does not mean its items are`,
  ).toBeVisible({ timeout: 15000 });
  await item.click();
}
