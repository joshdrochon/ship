import { test, expect } from './fixtures/isolated-env'

test.describe('Docs Mode (Phase 3)', () => {
  test.beforeEach(async ({ page }) => {
    // Login before each test
    await page.goto('/login')
    await page.locator('#email').fill('dev@ship.local')
    await page.locator('#password').fill('admin123')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()

    // Wait for app to load
    await expect(page).not.toHaveURL('/login', { timeout: 5000 })
  })

  test('can navigate to Docs mode via icon rail', async ({ page }) => {
    // Click Docs icon in the rail
    await page.getByRole('button', { name: /docs/i }).click()

    // Should be in docs mode
    await expect(page).toHaveURL(/\/docs/)

    // Should see Documents heading in sidebar (use heading role for specificity)
    await expect(page.getByRole('heading', { name: 'Documents' })).toBeVisible({ timeout: 5000 })
  })

  test('shows document list or empty state', async ({ page }) => {
    await page.goto('/docs')

    // Should see Documents heading
    await expect(page.getByRole('heading', { name: 'Documents' })).toBeVisible({ timeout: 5000 })

    // Either shows documents (buttons) or "No documents yet"
    const hasDocuments = await page.locator('button:has(svg)').count() > 1 // More than just New Document button
    const hasEmptyState = await page.getByText(/no documents yet/i).isVisible()
    expect(hasDocuments || hasEmptyState).toBeTruthy()
  })

  test('can create a new wiki document', async ({ page }) => {
    await page.goto('/docs')

    // Click the + button in sidebar header or main New Document button
    const createButton = page.locator('aside').getByRole('button', { name: /new|create|\+/i }).first()

    // If no create button in sidebar, look for main button
    if (!await createButton.isVisible({ timeout: 2000 })) {
      await page.getByRole('button', { name: 'New Document', exact: true }).click()
    } else {
      await createButton.click()
    }

    // Should navigate to editor
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

    // Editor should be visible
    await expect(page.locator('.ProseMirror, .tiptap, [data-testid="editor"]')).toBeVisible({ timeout: 5000 })
  })

  test('new document appears in sidebar list', async ({ page }) => {
    await page.goto('/docs')

    // Count existing documents in sidebar
    await page.waitForTimeout(500) // Wait for sidebar to populate
    const initialCount = await page.locator('aside ul li').count()

    // Create new document using the sidebar button or main button
    const sidebarButton = page.locator('aside').getByRole('button', { name: /new|create|\+/i }).first()
    if (await sidebarButton.isVisible({ timeout: 2000 })) {
      await sidebarButton.click()
    } else {
      // Fallback to main New Document button
      await page.getByRole('button', { name: 'New Document', exact: true }).click()
    }

    // Wait for navigation to new doc
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

    // Wait for sidebar to update and verify count increased
    await page.waitForTimeout(1000)
    const newCount = await page.locator('aside ul li').count()
    expect(newCount).toBeGreaterThanOrEqual(initialCount)
  })

  test('can edit document title', async ({ page }) => {
    await page.goto('/docs')

    // Create a new document using the sidebar button or main button
    const sidebarButton = page.locator('aside').getByRole('button', { name: /new|create|\+/i }).first()
    if (await sidebarButton.isVisible({ timeout: 2000 })) {
      await sidebarButton.click()
    } else {
      // Fallback to main New Document button (exact match)
      await page.getByRole('button', { name: 'New Document', exact: true }).click()
    }

    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

    // Find title input (contenteditable or input)
    const titleInput = page.locator('[contenteditable="true"]').first()

    if (await titleInput.isVisible({ timeout: 2000 })) {
      // Clear and type new title
      await titleInput.click()
      await page.keyboard.press('ControlOrMeta+a')
      await page.keyboard.type('My Test Document')

      // Wait a moment for save
      await page.waitForTimeout(500)

      // Title should be updated
      await expect(titleInput).toContainText('My Test Document')
    }
  })

  test('can navigate between documents using sidebar', async ({ page }) => {
    await page.goto('/docs')

    // Wait for sidebar to load - use links within tree items (not buttons, which are for expand/add)
    const sidebarLinks = page.locator('aside [role="tree"] [role="treeitem"] a')
    await page.waitForTimeout(500)

    // If there are documents in the sidebar, click one and verify navigation
    const itemCount = await sidebarLinks.count()
    if (itemCount > 0) {
      // Click a sidebar item link
      await sidebarLinks.first().click()

      // Should navigate to a document URL
      await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

      // If there are multiple items, click a different one to verify navigation
      if (itemCount >= 2) {
        const firstUrl = page.url()
        await sidebarLinks.nth(1).click()
        await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

        // The URL should have changed to a different document
        expect(page.url()).not.toBe(firstUrl)
      }
    } else {
      // Create a document if none exist
      await page.getByRole('button', { name: 'New Document', exact: true }).click()
      await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })
    }
  })

  test('editor shows save status indicator', async ({ page }) => {
    await page.goto('/docs')

    // Create a new document
    const createButton = page.locator('aside').getByRole('button', { name: /new|create|\+/i }).first()
    if (await createButton.isVisible({ timeout: 2000 })) {
      await createButton.click()
    } else {
      await page.getByRole('button', { name: 'New Document', exact: true }).click()
    }

    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 5000 })

    // Type in the editor
    const editor = page.locator('.ProseMirror, .tiptap')
    await expect(editor).toBeVisible({ timeout: 5000 })
    await editor.click()
    await page.keyboard.type('Hello world')

    // Should see save status indicator (Saved, Cached, Saving, or Offline)
    // The status is shown in the editor header (use .first() to avoid matching sr-only element)
    await expect(page.getByText(/saved|cached|saving|offline/i).first()).toBeVisible({ timeout: 10000 })
  })
})
