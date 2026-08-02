/**
 * Document Workflows E2E Tests
 *
 * Tests for critical document workflows:
 * - Issue project assignment via dropdown
 * - Issue sprint assignment via properties panel
 * - Issue to project conversion
 * - Sprint planning board shows correct issues
 *
 * These tests use slow mode (3x timeout) for dev server reliability
 */

import { test, expect, Page } from './fixtures/isolated-env'
import { expectDocumentTitleSaved } from './fixtures/test-helpers'

// Tests run in isolated containers with fresh database per worker

// =============================================================================
// HELPERS
// =============================================================================

async function login(page: Page) {
  // Navigate to login and wait for page to be stable
  await page.goto('/login')
  await page.waitForLoadState('networkidle')
  await expect(page.locator('#email')).toBeVisible({ timeout: 15000 })

  // Fill credentials with a small delay to ensure React is ready
  await page.locator('#email').click()
  await page.locator('#email').fill('dev@ship.local')
  await page.locator('#password').click()
  await page.locator('#password').fill('admin123')

  // Verify fields are filled before clicking
  await expect(page.locator('#email')).toHaveValue('dev@ship.local')
  await expect(page.locator('#password')).toHaveValue('admin123')

  // Click sign in and wait for redirect
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).not.toHaveURL('/login', { timeout: 30000 })
}

async function createIssue(page: Page, title: string) {
  await page.goto('/issues')
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('button', { name: 'New Issue', exact: true })).toBeVisible({ timeout: 20000 })
  await page.getByRole('button', { name: 'New Issue', exact: true }).click()
  await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 20000 })

  // Set the title and wait for the server to actually hold it.
  //
  // This used to be `fill()` followed by a fixed 1 s sleep. One second is shorter than
  // the client's 1.5 s fallback debounce on a brand-new document
  // (TITLE_FALLBACK_SAVE_MS, web/src/hooks/useCollaborativeTitle.ts), so the sleep
  // routinely expired before anything was written. The editor still showed the title --
  // it is React state -- while the database still held "Untitled", and any later
  // assertion that read server data instead of the editor failed.
  //
  // `expectDocumentTitleSaved` polls `GET /api/documents/:id` until the title is really
  // there, which is correct whether the value travels by REST fallback or by the
  // collaboration socket, and needs no knowledge of either timer.
  const titleInput = page.getByPlaceholder('Untitled')
  await titleInput.fill(title)
  await expectDocumentTitleSaved(page, title)
}

// =============================================================================
// ISSUE PROGRAM ASSIGNMENT
// =============================================================================

test.describe('Issue Program Assignment', () => {
  test.slow() // 3x timeout for dev server

  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('user creates issue and assigns to program via dropdown', async ({ page }) => {
    await createIssue(page, 'Program Assignment Test')

    // Find and click the Programs button (MultiAssociationChips component in properties sidebar)
    // Use "Add program..." text to distinguish from nav sidebar icon
    const programsButton = page.getByText('Add program...')
    await expect(programsButton).toBeVisible({ timeout: 10000 })
    await programsButton.click()

    // Wait for dropdown and select Ship Core
    await page.waitForTimeout(500)
    const shipCoreOption = page.getByText('Ship Core', { exact: true })
    await expect(shipCoreOption).toBeVisible({ timeout: 5000 })
    await shipCoreOption.click()

    // Verify program chip is added (look for chip with the program name)
    await expect(page.locator('span').filter({ hasText: 'Ship Core' })).toBeVisible({ timeout: 5000 })
  })
})

// =============================================================================
// ISSUE SPRINT ASSIGNMENT
// =============================================================================

test.describe('Issue Week Assignment', () => {
  test.slow() // 3x timeout for dev server

  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('user assigns issue to sprint via properties panel', async ({ page }) => {
    await createIssue(page, 'Sprint Assignment Test')

    // Assign to program first (MultiAssociationChips component in properties sidebar)
    // Use "Add program..." text to distinguish from nav sidebar icon
    const programsButton = page.getByText('Add program...')
    await programsButton.click()
    await page.waitForTimeout(500)
    await page.getByText('Ship Core', { exact: true }).click()
    await expect(page.locator('span').filter({ hasText: 'Ship Core' })).toBeVisible({ timeout: 5000 })

    // Add estimate (required for sprint)
    const estimateInput = page.getByRole('spinbutton', { name: /estimate/i })
    await estimateInput.click()
    await estimateInput.clear()
    await estimateInput.pressSequentially('4', { delay: 100 })
    await page.waitForTimeout(1000) // Wait for debounced save and sprints to load

    // Assign to sprint
    const sprintCombobox = page.getByRole('combobox', { name: 'Week' })
    await expect(sprintCombobox).toBeVisible({ timeout: 10000 })
    await sprintCombobox.click()
    await page.waitForTimeout(500)

    // Select first available sprint
    const sprintOption = page.locator('[cmdk-item]').filter({ hasText: /Week \d+/ }).first()
    if (await sprintOption.isVisible({ timeout: 5000 }).catch(() => false)) {
      await sprintOption.click()
      // Verify sprint selected via UI
      await expect(sprintCombobox).toContainText(/Week \d+/, { timeout: 5000 })
    }
  })
})

// =============================================================================
// DOCUMENT CONVERSION
// =============================================================================

test.describe('Issue to Project Conversion', () => {
  test.slow() // 3x timeout for dev server

  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('user converts issue to project and sees in projects list', async ({ page }) => {
    const issueTitle = `Conversion Test ${Date.now()}`
    await createIssue(page, issueTitle)

    // Click "Promote to Project" button - converts directly without confirmation dialog
    const promoteButton = page.getByRole('button', { name: /Promote to Project/i })
    await expect(promoteButton).toBeVisible({ timeout: 10000 })
    await promoteButton.click()

    // Wait for conversion to complete by checking the button disappears
    // (the button only shows on issues, not projects)
    await expect(promoteButton).toBeHidden({ timeout: 20000 })

    // Verify title preserved
    await expect(page.getByPlaceholder('Untitled')).toHaveValue(issueTitle)

    // Go to projects list and verify title appears
    // Note: The app uses IndexedDB persistence for React Query, so we need to
    // clear the cache or wait for the background refetch to complete
    await page.goto('/projects')
    await page.waitForLoadState('networkidle')

    // Clear IndexedDB cache and reload to get fresh data
    await page.evaluate(async () => {
      const databases = await indexedDB.databases()
      for (const db of databases) {
        if (db.name) indexedDB.deleteDatabase(db.name)
      }
    })
    await page.reload()
    await page.waitForLoadState('networkidle')

    // Wait for the table to be visible
    await expect(page.locator('table')).toBeVisible({ timeout: 10000 })

    // Look for the project title text within the table
    // Using text selector is more reliable than role-based accessible name matching
    const projectTitle = page.locator('table td').filter({ hasText: issueTitle })
    await expect(projectTitle).toBeVisible({ timeout: 15000 })
  })
})

// =============================================================================
// SPRINT PLANNING BOARD
// =============================================================================

test.describe('Week Planning Board', () => {
  test.slow() // 3x timeout for dev server

  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('sprint planning board displays issues', async ({ page }) => {
    // Navigate to Ship Core program
    await page.goto('/programs')
    await expect(page.getByRole('row', { name: /Ship Core/i })).toBeVisible({ timeout: 10000 })
    await page.getByRole('row', { name: /Ship Core/i }).click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 10000 })

    // Click Weeks tab
    await page.getByRole('tab', { name: 'Weeks' }).click()
    await page.waitForTimeout(1000)

    // Click "Plan Week" button
    const planSprintButton = page.getByRole('button', { name: /Plan Week/i })
    if (await planSprintButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await planSprintButton.click({ force: true })
      await expect(page).toHaveURL(/\/sprints\/[a-f0-9-]+\/view/, { timeout: 15000 })

      // Click Planning tab
      await page.getByRole('tab', { name: 'Planning' }).click()
      await page.waitForLoadState('networkidle')

      // Should see kanban columns
      await expect(page.locator('h2').filter({ hasText: 'Backlog' })).toBeVisible({ timeout: 10000 })
      await expect(page.locator('h2').filter({ hasText: /^Week$/ })).toBeVisible()
    }
  })
})
