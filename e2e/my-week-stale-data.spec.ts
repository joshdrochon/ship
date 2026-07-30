import { test, expect, Page } from './fixtures/isolated-env'

/**
 * RISK MITIGATED
 * --------------
 * /my-week must never serve a cached response after the user has edited their weekly
 * plan or retro. Plan/retro content is written by the Yjs collaboration server, not by a
 * client-side mutation, so nothing on the client invalidates the query cache. When
 * `useMyWeekQuery` carried a 5-minute `staleTime`, navigating back from the document
 * editor re-rendered the dashboard from the cache and the plan looked empty even though
 * the edit had been saved. `useMyWeekQuery` now sets `staleTime: 0`; if that is ever
 * reverted, or if a caching layer is put back in front of the my-week query, these two
 * tests fail.
 *
 * The assertion is deliberately split in two:
 *
 *   1. Poll the API until the edit is on the server. This establishes the precondition
 *      and is NOT the thing under test.
 *   2. Navigate back and assert the UI shows it. Since step 1 proved the server has the
 *      data, a failure here can only mean the client served a stale cache — which is
 *      exactly the regression.
 *
 * WHY THIS SPEC OWNS PRIVATE WEEK NUMBERS
 * ---------------------------------------
 * The Playwright database is worker-scoped (e2e/fixtures/isolated-env.ts), seeded once
 * and then shared by every spec that lands on the same worker, with no reset between
 * tests. Several other specs create a weekly plan or retro for Dev User in the *current*
 * week — manager-reviews-visual.spec.ts:84, request-changes-ui.spec.ts:84 and
 * accountability-week.spec.ts:87 all do. When one of them ran first on the same worker,
 * MyWeekPage rendered the existing document as a <Link> instead of a create <button> and
 * this spec's `getByRole('button', …)` click timed out. Which specs share a worker
 * changes from run to run, so the failure looked like flake. Owning week numbers no
 * other spec touches removes the shared-state dependency entirely.
 */

// Far outside the -6/+2 week window the heatmap grid and every other spec work in.
const PLAN_WEEK = 901
const RETRO_WEEK = 902

const PLAN_TEXT = 'Ship the new dashboard feature'
const RETRO_TEXT = 'Completed the API refactoring'

/**
 * Wait until the my-week API itself reports the edited item.
 *
 * FAILURE MODE THIS TOLERATES: the editor reaches the database over a WebSocket, and the
 * API rate-limits WebSocket handshakes to 30 per minute per IP
 * (api/src/collaboration/index.ts:23). Every test on a worker shares one API process and
 * one source IP, so a busy worker can get this editor's socket refused with a 429. The
 * product recovers on its own — y-websocket retries with backoff and syncs once the
 * window drains — so the test has to allow for that window rather than assume the first
 * connection succeeds. The old code allowed three seconds.
 *
 * NOTE ON THE OLD WAIT: this replaces `expect(getByText('Saved')).toBeVisible()` followed
 * by a fixed 3s sleep. That wait proved nothing. Editor.tsx sets `syncStatus` to 'synced'
 * — which renders as "Saved" — from the y-websocket `status`/`sync` handlers when the
 * socket opens (Editor.tsx:389, :444), and never moves it back while the user types. So
 * "Saved" is already on screen before the first keystroke and the expectation resolved
 * immediately. The only real wait was the 3s sleep, against a collaboration server that
 * debounces its write 2s after the last update (api/src/collaboration/index.ts:185) and
 * then runs three queries — about a second of slack on an idle machine and none on a
 * loaded one.
 */
async function waitForServerToHaveItem(
  page: Page,
  weekNumber: number,
  field: 'plan' | 'retro',
  text: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/dashboard/my-week?week_number=${weekNumber}`)
        if (!res.ok()) return ''
        const body = await res.json()
        // Joined rather than compared element-by-element: the plan/retro template already
        // contains a list, so the caret lands inside an existing item and the typed
        // "1. " stays literal instead of starting a new one. The item that matters is
        // the one containing the typed text.
        return ((body[field]?.items ?? []) as { text: string }[]).map(item => item.text).join('\n')
      },
      {
        message: `my-week API never reported the edited ${field} for week ${weekNumber}. The collaboration server did not persist the typed content to the documents.content column.`,
        timeout: 45_000,
        intervals: [500, 500, 1000, 1000, 2000],
      }
    )
    .toContain(text)
}

test.describe('My Week - stale data after editing plan/retro', () => {
  // The editor's WebSocket may have to wait out a rate-limit window (see above) before it
  // can sync, which can cost most of a minute on a saturated worker.
  test.slow()

  test.beforeEach(async ({ page }) => {
    await page.goto('/login')
    await page.locator('#email').fill('dev@ship.local')
    await page.locator('#password').fill('admin123')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page).not.toHaveURL('/login', { timeout: 5000 })
  })

  test('plan edits are visible on /my-week after navigating back', async ({ page }) => {
    // 1. Open the week this spec owns
    await page.goto(`/my-week?week_number=${PLAN_WEEK}`)
    await expect(page.getByRole('heading', { name: `Week ${PLAN_WEEK}`, exact: true })).toBeVisible({
      timeout: 10000,
    })

    // 2. Create the plan. No other spec writes a plan for this week, so this is always
    //    the create button and never a link to an already-existing document.
    await page.getByRole('button', { name: /create plan for this week/i }).click()

    // 3. Should navigate to the document editor
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 10000 })

    // 4. Wait for the TipTap editor to be ready
    const editor = page.locator('.tiptap')
    await expect(editor).toBeVisible({ timeout: 10000 })

    // 5. Type a list item. The "1. " prefix makes an orderedList, which is what
    //    extractPlanItems (api/src/routes/dashboard.ts:279) reads back as plan items.
    await editor.click()
    await page.keyboard.type(`1. ${PLAN_TEXT}`)

    // 6. Precondition, not the assertion: the edit has reached the server.
    await waitForServerToHaveItem(page, PLAN_WEEK, 'plan', PLAN_TEXT)

    // 7. Client-side navigation back to the dashboard. This is a history pop, so React
    //    Router handles it without a reload and the QueryClient survives — which is what
    //    makes a stale cache observable at all.
    await page.goBack()
    await expect(page.getByRole('heading', { name: `Week ${PLAN_WEEK}`, exact: true })).toBeVisible({
      timeout: 10000,
    })

    // 8. THE ASSERTION. The server has the item (step 6), so if the dashboard does not
    //    show it, the my-week query served a cached response.
    await expect(page.getByText(PLAN_TEXT)).toBeVisible({ timeout: 10000 })
  })

  test('retro edits are visible on /my-week after navigating back', async ({ page }) => {
    // 1. Open the week this spec owns — a different one from the plan test, so the two
    //    tests cannot interfere with each other either
    await page.goto(`/my-week?week_number=${RETRO_WEEK}`)
    await expect(page.getByRole('heading', { name: `Week ${RETRO_WEEK}`, exact: true })).toBeVisible(
      { timeout: 10000 }
    )

    // 2. Create the retro
    await page.getByRole('button', { name: /create retro for this week/i }).click()

    // 3. Should navigate to the document editor
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 10000 })

    // 4. Wait for the TipTap editor to be ready
    const editor = page.locator('.tiptap')
    await expect(editor).toBeVisible({ timeout: 10000 })

    // 5. Type a list item
    await editor.click()
    await page.keyboard.type(`1. ${RETRO_TEXT}`)

    // 6. Precondition, not the assertion: the edit has reached the server.
    await waitForServerToHaveItem(page, RETRO_WEEK, 'retro', RETRO_TEXT)

    // 7. Client-side navigation back to the dashboard
    await page.goBack()
    await expect(page.getByRole('heading', { name: `Week ${RETRO_WEEK}`, exact: true })).toBeVisible(
      { timeout: 10000 }
    )

    // 8. THE ASSERTION — see the plan test
    await expect(page.getByText(RETRO_TEXT)).toBeVisible({ timeout: 10000 })
  })
})
