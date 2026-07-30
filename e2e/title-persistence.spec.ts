import { test, expect, Page } from './fixtures/isolated-env'

/**
 * Title persistence — transport-agnostic regression tests (W6-9 / lane-6b).
 *
 * W6-9 moved the document title out of a debounced `PATCH /api/documents/:id`
 * and into the Yjs CRDT, where it merges instead of overwriting. That is a
 * transport change: the title is now persisted by the collaboration server's
 * debounced write, not by a REST call from the browser.
 *
 * Eight E2E spec files had encoded the old transport directly — they waited for
 * `method() === 'PATCH'` as their signal that a title had been saved. Those
 * waits time out under the new design even though the title persists correctly,
 * which is how a behaviour-preserving change produced ten red tests.
 *
 * These tests assert the OUTCOME instead: after typing a title, the value is
 * readable from the server and survives a full reload. They pass on either
 * transport, so they stay green if the title ever moves again.
 */

async function login(page: Page) {
  await page.goto('/login')
  await page.locator('#email').fill('dev@ship.local')
  await page.locator('#password').fill('admin123')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).not.toHaveURL('/login', { timeout: 5000 })
}

test.describe('Document title persistence (transport-agnostic)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('title typed in the editor is persisted server-side', async ({ page }) => {
    // Record any title-bearing PATCH, for diagnostics only.
    //
    // Measured: this fires ZERO times when the collaboration socket syncs before
    // the user types, and ONCE when it does not — `useCollaborativeTitle` keeps a
    // REST fallback that fires 1.5s after typing if no session is established
    // yet. That race is precisely why waiting on the PATCH is not a valid signal
    // and why eight spec files became timing-dependent. We assert persistence,
    // which holds either way, and never assert on the count.
    const titlePatches: string[] = []
    page.on('request', req => {
      if (req.method() === 'PATCH' && req.url().includes('/api/documents/')) {
        titlePatches.push(req.url())
      }
    })

    await page.goto('/docs')
    await page.getByRole('button', { name: 'New Document', exact: true }).click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 10000 })
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

    const docId = page.url().split('/').pop()!
    const titleInput = page.getByPlaceholder('Untitled')
    await expect(titleInput).toBeVisible({ timeout: 5000 })
    await titleInput.fill('CRDT Persisted Title')

    // The observable outcome: the API serves the new title. The collaboration
    // server persists on a 2s debounce, so poll rather than sleeping a fixed
    // amount — this is the assertion the old PATCH wait was standing in for.
    await expect(async () => {
      const resp = await page.request.get(`/api/documents/${docId}`)
      expect(resp.ok()).toBeTruthy()
      const body = await resp.json()
      expect(body.title).toBe('CRDT Persisted Title')
    }).toPass({ timeout: 15000 })

    // ...and it survives a reload, which is what the user actually cares about.
    await page.reload()
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })
    await expect(page.getByPlaceholder('Untitled')).toHaveValue('CRDT Persisted Title', {
      timeout: 10000,
    })

    // Diagnostic only — see the comment at the top of this test. The title must
    // persist whether or not the REST fallback happened to fire.
    console.log(`[title-persistence] title-bearing PATCHes observed: ${titlePatches.length}`)
  })

  test('a renamed document shows its new title in the document list', async ({ page }) => {
    await page.goto('/docs')
    await page.getByRole('button', { name: 'New Document', exact: true }).click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 10000 })
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

    const docId = page.url().split('/').pop()!
    await page.getByPlaceholder('Untitled').fill('Listed Document Title')

    await expect(async () => {
      const resp = await page.request.get(`/api/documents/${docId}`)
      expect(resp.ok()).toBeTruthy()
      expect((await resp.json()).title).toBe('Listed Document Title')
    }).toPass({ timeout: 15000 })

    await page.goto('/docs')
    await expect(page.getByText('Listed Document Title').first()).toBeVisible({ timeout: 10000 })
  })
})
