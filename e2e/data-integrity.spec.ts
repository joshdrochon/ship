import { test, expect, Page } from './fixtures/isolated-env'
import {
  expectDocumentTitleSaved,
  waitForSlashMenu,
  chooseSlashMenuItem,
  expectContentPersisted,
  expectTextPersisted,
  countNodesOfType,
} from './fixtures/test-helpers'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

/**
 * Data Integrity Tests
 *
 * Tests that verify data is correctly saved, persisted, and retrieved:
 * - Complete document saves
 * - Image persistence
 * - Mention preservation
 * - Undo/redo accuracy
 * - Copy/paste structure
 * - Database consistency
 */

// Helper to create a new document
async function createNewDocument(page: Page) {
  await page.goto('/docs')
  await page.waitForLoadState('networkidle')

  const currentUrl = page.url()
  // Button uses aria-label, not title attribute
  const newDocButton = page.getByRole('button', { name: /new document/i })
  await expect(newDocButton.first()).toBeVisible({ timeout: 5000 })
  await newDocButton.first().click()

  await page.waitForFunction(
    (oldUrl) => window.location.href !== oldUrl && /\/documents\/[a-f0-9-]+/.test(window.location.href),
    currentUrl,
    { timeout: 10000 }
  )

  await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })
  await expect(page.locator('textarea[placeholder="Untitled"]')).toBeVisible({ timeout: 3000 })
}

// Helper to login
async function login(page: Page, email: string = 'dev@ship.local', password: string = 'admin123') {
  await page.context().clearCookies()
  await page.goto('/login')
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).not.toHaveURL('/login', { timeout: 5000 })
}

// Create test image
function createTestImageFile(): string {
  const pngBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
    'base64'
  )
  const tmpPath = path.join(os.tmpdir(), `test-image-${Date.now()}.png`)
  fs.writeFileSync(tmpPath, pngBuffer)
  return tmpPath
}

test.describe('Data Integrity - Document Persistence', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('document saves completely with all formatting', async ({ page }) => {
    await createNewDocument(page)

    const editor = page.locator('.ProseMirror')
    const titleInput = page.locator('textarea[placeholder="Untitled"]')

    // Set title
    await titleInput.click()
    await titleInput.fill('Complete Document Test')

    // Wait for the title to actually reach the server. This used to wait for a
    // PATCH and swallow the timeout, which since W6-9 (title moved into the
    // CRDT) meant it silently waited 5s and continued regardless.
    await expectDocumentTitleSaved(page, 'Complete Document Test')

    // Add content using markdown shortcuts (more reliable than keyboard shortcuts)
    await editor.click()
    await page.waitForTimeout(200)

    // Heading using markdown shortcut (## at start of line)
    // Retry if markdown conversion doesn't trigger — under load, keystrokes may be buffered
    await expect(async () => {
      // Clear editor content and try again
      await editor.click()
      await page.keyboard.press('ControlOrMeta+a')
      await page.keyboard.press('Delete')
      await page.waitForTimeout(200)
      await page.keyboard.type('## My Test Heading', { delay: 20 })
      await page.keyboard.press('Enter')
      await expect(editor.locator('h2')).toContainText('My Test Heading', { timeout: 5000 })
    }).toPass({ timeout: 15000, intervals: [1000, 2000, 3000] })

    // Ensure editor still has focus after markdown conversion
    await editor.click()
    await expect(editor).toBeFocused({ timeout: 3000 })

    // Plain paragraph content - focus on data integrity, not formatting shortcuts
    await page.keyboard.type('This is regular paragraph text with unique identifier XYZ123 to verify persistence.')

    // Verify content appears in editor BEFORE waiting for sync
    await expect(editor).toContainText('My Test Heading', { timeout: 5000 })
    await expect(editor).toContainText('XYZ123', { timeout: 5000 })

    // Click outside editor to trigger blur/save, then wait for sync
    await titleInput.click()
    await page.waitForTimeout(500)

    // Wait for sync status to show "Saved" (ensures WebSocket sync is complete)
    await expect(page.getByTestId('sync-status').getByText(/Saved|Cached/)).toBeVisible({ timeout: 10000 })

    // Extra buffer for Yjs to fully propagate to server
    await page.waitForTimeout(2000)

    // Get document URL
    const docUrl = page.url()

    // Hard reload
    await page.goto(docUrl)
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

    // Wait for content to load from server
    await page.waitForTimeout(1000)

    // Verify all content is preserved after reload
    await expect(titleInput).toHaveValue('Complete Document Test')
    await expect(editor).toContainText('My Test Heading')
    await expect(editor).toContainText('XYZ123')
    await expect(editor).toContainText('regular paragraph text')

    // Verify heading formatting is preserved
    await expect(editor.locator('h2')).toContainText('My Test Heading')
  })

  test('document with complex nested structure persists', async ({ page }) => {
    await createNewDocument(page)

    const editor = page.locator('.ProseMirror')
    await editor.click()

    // Create nested list
    await page.keyboard.type('- Parent item 1')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Tab')
    await page.keyboard.type('Nested item 1.1')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Nested item 1.2')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Tab')
    await page.keyboard.type('Double nested 1.2.1')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.type('Parent item 2')

    // Was `waitForTimeout(2000)` — exactly PERSIST_DEBOUNCE_MS, measured from the
    // wrong clock. `Parent item 2` is the last thing typed, so the server holding
    // it means the whole nested structure has landed.
    await expectTextPersisted(page, 'Parent item 2')

    // Reload
    await page.reload()
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

    // Verify nested structure
    await expect(editor).toContainText('Parent item 1')
    await expect(editor).toContainText('Nested item 1.1')
    await expect(editor).toContainText('Nested item 1.2')
    await expect(editor).toContainText('Double nested 1.2.1')
    await expect(editor).toContainText('Parent item 2')
  })

  test('empty document saves correctly', async ({ page }) => {
    await createNewDocument(page)

    const titleInput = page.locator('textarea[placeholder="Untitled"]')

    // Just set title, leave content empty
    await titleInput.click()
    await titleInput.fill('Empty Document')
    await titleInput.blur()

    // W6-9: wait for the durable write rather than a fixed sleep sitting exactly
    // on the 2s debounce boundary.
    await expectDocumentTitleSaved(page, 'Empty Document')

    // Reload
    await page.reload()
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

    // Title should be saved
    await expect(titleInput).toHaveValue('Empty Document')

    // Editor should be empty
    const editorText = await page.locator('.ProseMirror').textContent()
    expect(editorText?.trim()).toBe('')
  })

})

// FIXME: Filechooser event not firing - slash command image upload interaction broken
// Same issue as images.spec.ts - see that file for context
test.describe('Data Integrity - Images', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('images persist after page reload', async ({ page }) => {
    await createNewDocument(page)

    const editor = page.locator('.ProseMirror')
    await editor.click()

    // Upload image
    await page.keyboard.type('/image')

    const tmpPath = createTestImageFile()
    const fileChooserPromise = page.waitForEvent('filechooser')
    // Was `waitForSlashMenu` + blind Enter. The menu container renders before its
    // items do, so Enter selected nothing and the chooser never opened — a 60 s
    // test timeout, and six of ten flaky tests in one run.
    await chooseSlashMenuItem(page, /Image/i)

    const fileChooser = await fileChooserPromise
    await fileChooser.setFiles(tmpPath)

    // Wait for upload
    await expect(editor.locator('img')).toBeVisible({ timeout: 5000 })
    await page.waitForFunction(
      () => {
        const img = document.querySelector('.ProseMirror img')
        if (!img) return false
        const src = img.getAttribute('src') || ''
        return src.startsWith('http') || src.includes('/api/files')
      },
      { timeout: 15000 }
    )

    // Get image src
    const img = editor.locator('img').first()
    const originalSrc = await img.getAttribute('src')

    // Was `waitForTimeout(2000)`, which is exactly PERSIST_DEBOUNCE_MS and therefore
    // never long enough — the server's 2 s starts when the update arrives, not when
    // this test started counting. Wait for the image to be in the persisted content.
    await expectContentPersisted(page, (c) => countNodesOfType(c, 'image') >= 1)

    // Reload page
    await page.reload()
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

    // Image should still be there
    await expect(page.locator('.ProseMirror img')).toBeVisible({ timeout: 5000 })

    // Src should be the same
    const reloadedImg = page.locator('.ProseMirror img').first()
    const reloadedSrc = await reloadedImg.getAttribute('src')
    expect(reloadedSrc).toBe(originalSrc)

    fs.unlinkSync(tmpPath)
  })

  test('multiple images persist in correct order', async ({ page }) => {
    await createNewDocument(page)

    const editor = page.locator('.ProseMirror')
    await editor.click()

    // Upload first image
    await page.keyboard.type('Image 1:')
    await page.keyboard.press('Enter')
    await page.keyboard.type('/image')
    const tmpPath1 = createTestImageFile()
    let fileChooserPromise = page.waitForEvent('filechooser')
    await chooseSlashMenuItem(page, /Image/i)
    let fileChooser = await fileChooserPromise
    await fileChooser.setFiles(tmpPath1)

    await page.waitForTimeout(2000)

    // Upload second image
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Image 2:')
    await page.keyboard.press('Enter')
    await page.keyboard.type('/image')
    const tmpPath2 = createTestImageFile()
    fileChooserPromise = page.waitForEvent('filechooser')
    await chooseSlashMenuItem(page, /Image/i)
    fileChooser = await fileChooserPromise
    await fileChooser.setFiles(tmpPath2)

    // Was `waitForTimeout(3000)` — exactly PERSIST_MAX_WAIT_MS, so the same
    // zero-margin race as the single-image test above.
    await expectContentPersisted(page, (c) => countNodesOfType(c, 'image') >= 2)

    // `expect(locator).toHaveCount()` polls; `(await locator.all()).length` does not.
    // `.all()` is a snapshot taken the instant it runs, so on a busy runner it read
    // one image, asserted 1 !== 2, and failed a suite that was working correctly.
    await expect(editor.locator('img')).toHaveCount(2)

    // Indexed locators, not `.all()`. `.all()` materialises an array once; every
    // element in it is a handle to a DOM node that TipTap can replace on its next
    // render, and the array itself never re-resolves. `.nth(i)` re-queries at use.
    const src1 = await editor.locator('img').nth(0).getAttribute('src')
    const src2 = await editor.locator('img').nth(1).getAttribute('src')

    // Reload
    await page.reload()
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

    // Verify order preserved. Same reason as above, and it matters more here:
    // after a reload the editor hydrates asynchronously, so the images are
    // reliably absent for a moment even when they persisted correctly.
    await expect(page.locator('.ProseMirror img')).toHaveCount(2)

    // `toHaveAttribute` polls; reading through a materialised array does not. The
    // previous version passed `toHaveCount(2)` and then threw
    // `Cannot read properties of undefined` four lines later, because TipTap
    // re-rendered between the count and the `.all()` and the array came back short.
    const reloaded = page.locator('.ProseMirror img')
    await expect(reloaded.nth(0)).toHaveAttribute('src', src1 ?? '')
    await expect(reloaded.nth(1)).toHaveAttribute('src', src2 ?? '')

    fs.unlinkSync(tmpPath1)
    fs.unlinkSync(tmpPath2)
  })
})

test.describe('Data Integrity - Mentions', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('mentions survive document reload', async ({ page }) => {
    await createNewDocument(page)

    const editor = page.locator('.ProseMirror')
    await editor.click()

    // Insert mention
    await page.keyboard.type('Mentioned person: ')
    await page.keyboard.type('@')

    await expect(page.locator('[role="listbox"]')).toBeVisible({ timeout: 5000 })

    // Select first result
    const firstOption = page.locator('[role="option"]').first()
    if (await firstOption.isVisible()) {
      const mentionText = await firstOption.textContent()
      await firstOption.click()

      // Wait for mention to be inserted
      await expect(editor.locator('.mention')).toBeVisible({ timeout: 3000 })

      // Was `waitForTimeout(2000)` — exactly PERSIST_DEBOUNCE_MS, measured from the
      // wrong clock.
      await expectContentPersisted(page, (c) => countNodesOfType(c, 'mention') >= 1)

      // Reload
      await page.reload()
      await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

      // Mention should still be there
      await expect(page.locator('.ProseMirror .mention')).toBeVisible({ timeout: 5000 })
      await expect(editor).toContainText('Mentioned person:')
    }
  })

  test('multiple mentions persist correctly', async ({ page }) => {
    await createNewDocument(page)

    const editor = page.locator('.ProseMirror')
    await editor.click()

    // Insert first mention
    await page.keyboard.type('First: ')
    await page.keyboard.type('@')
    await expect(page.locator('[role="listbox"]')).toBeVisible({ timeout: 5000 })

    // The listbox becomes visible before its options render. The original code
    // snapshotted with `.all()` and guarded the click with `if (length > 0)`, so an
    // empty snapshot skipped the click silently and the test went on to measure a
    // mention it never inserted — a pass that proved nothing, and a flake when the
    // later assertions noticed. Indexed locators re-query, and the click is now
    // unconditional so a missing option fails loudly.
    const firstOptions = page.locator('[role="option"]')
    await expect(firstOptions.nth(0)).toBeVisible({ timeout: 5000 })
    await firstOptions.nth(0).click()
    await expect(editor.locator('.mention')).toHaveCount(1, { timeout: 5000 })

    // Insert second mention
    await page.keyboard.type(' Second: ')
    await page.keyboard.type('@')
    await expect(page.locator('[role="listbox"]')).toBeVisible({ timeout: 5000 })
    // Same treatment. The second mention prefers a different person when the list
    // offers one, but either way a click must happen — the old three-branch guard
    // could fall through to no click at all.
    const secondOptions = page.locator('[role="option"]')
    await expect(secondOptions.nth(0)).toBeVisible({ timeout: 5000 })
    const wanted = (await secondOptions.count()) > 1 ? 1 : 0
    await secondOptions.nth(wanted).click()
    await expect(editor.locator('.mention')).toHaveCount(2, { timeout: 5000 })

    // Was `waitForTimeout(2000)` — same zero-margin race as the image tests.
    // The count is read from the DOM first so the persisted state can be asserted
    // against the number this test actually produced, rather than a guess.
    const mentionCount = await editor.locator('.mention').count()
    await expectContentPersisted(
      page,
      (c) => countNodesOfType(c, 'mention') >= mentionCount,
    )

    // Reload
    await page.reload()
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

    // Same number of mentions should exist
    const reloadedMentionCount = await page.locator('.ProseMirror .mention').count()
    expect(reloadedMentionCount).toBe(mentionCount)
  })
})

test.describe('Data Integrity - Undo/Redo', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('undo/redo preserves formatting', async ({ page }) => {
    await createNewDocument(page)

    const editor = page.locator('.ProseMirror')
    await editor.click()

    // Type formatted text using markdown syntax (keyboard shortcuts unreliable cross-platform)
    await page.keyboard.type('Regular text ')
    await page.waitForTimeout(500)

    await page.keyboard.type('**bold text** ')
    await page.waitForTimeout(500)

    await page.keyboard.type('more regular')
    await page.waitForTimeout(500)

    // Verify content
    await expect(editor).toContainText('Regular text')
    await expect(editor).toContainText('bold text')
    await expect(editor).toContainText('more regular')

    // Verify bold formatting was applied
    const hasBold = await editor.locator('strong').count()
    if (hasBold > 0) {
      await expect(editor.locator('strong')).toContainText('bold text')
    }

    // Undo last part - undo until 'more regular' is gone
    // Use ControlOrMeta+z for Mac, Control+z for others
    const undoKey = process.platform === 'darwin' ? 'ControlOrMeta+z' : 'Control+z'
    const redoKey = process.platform === 'darwin' ? 'ControlOrMeta+Shift+z' : 'Control+Shift+z'

    for (let i = 0; i < 10; i++) {
      await page.keyboard.press(undoKey)
      await page.waitForTimeout(200)
      const content = await editor.textContent()
      if (!content?.includes('more regular')) break
    }
    await expect(editor).not.toContainText('more regular')

    // Redo until 'more regular' is back
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press(redoKey)
      await page.waitForTimeout(200)
      const content = await editor.textContent()
      if (content?.includes('more regular')) break
    }
    await expect(editor).toContainText('more regular')
  })

  test('undo/redo works across multiple operations', async ({ page }) => {
    await createNewDocument(page)

    const editor = page.locator('.ProseMirror')
    await editor.click()

    // Do multiple operations with longer pauses to create separate undo entries
    // TipTap batches keystrokes aggressively, so we need significant pauses
    await page.keyboard.type('Line 1')
    await page.waitForTimeout(1000)

    await page.keyboard.press('Enter')
    await page.keyboard.type('Line 2')
    await page.waitForTimeout(1000)

    await page.keyboard.press('Enter')
    await page.keyboard.type('Line 3')
    await page.waitForTimeout(1000)

    // Verify initial state
    await expect(editor).toContainText('Line 1')
    await expect(editor).toContainText('Line 2')
    await expect(editor).toContainText('Line 3')

    // Undo until Line 3 is gone (may need many undos due to batching)
    // Use ControlOrMeta+z for Mac, Control+z for others
    const undoKey = process.platform === 'darwin' ? 'ControlOrMeta+z' : 'Control+z'
    const redoKey = process.platform === 'darwin' ? 'ControlOrMeta+Shift+z' : 'Control+Shift+z'

    for (let i = 0; i < 15; i++) {
      await page.keyboard.press(undoKey)
      await page.waitForTimeout(200)
      const content = await editor.textContent()
      if (!content?.includes('Line 3')) break
    }

    const afterUndo = await editor.textContent()
    expect(afterUndo).toContain('Line 1')
    expect(afterUndo).not.toContain('Line 3')

    // Redo until Line 3 is back
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press(redoKey)
      await page.waitForTimeout(200)
      const content = await editor.textContent()
      if (content?.includes('Line 3')) break
    }

    await expect(editor).toContainText('Line 1')
    await expect(editor).toContainText('Line 3')
  })
})

test.describe('Data Integrity - Copy/Paste', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('copy/paste preserves structure', async ({ page }) => {
    await createNewDocument(page)

    const editor = page.locator('.ProseMirror')
    await editor.click()

    // Platform-aware shortcuts (Meta for Mac, Control for others)
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

    // Create structured content using markdown shortcuts
    await page.keyboard.type('# Heading')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300) // Wait for markdown conversion

    await page.keyboard.type('- List item 1')
    await page.keyboard.press('Enter')
    await page.keyboard.type('List item 2')
    await page.waitForTimeout(300)

    // Verify content was created before copying
    await expect(editor.locator('h1')).toBeVisible({ timeout: 3000 })
    await expect(editor.locator('li').first()).toBeVisible({ timeout: 3000 })

    // Select all and copy
    await page.keyboard.press(`${modifier}+a`)
    await page.keyboard.press(`${modifier}+c`)
    await page.waitForTimeout(200)

    // Click at end to deselect and position cursor
    await editor.click()
    await page.keyboard.press(`${modifier}+End`)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')

    // Paste
    await page.keyboard.press(`${modifier}+v`)

    await page.waitForTimeout(1000)

    // Should have duplicate structure - check for at least the pasted content
    const headings = await editor.locator('h1').count()
    expect(headings).toBeGreaterThanOrEqual(1)

    const listItems = await editor.locator('li').count()
    expect(listItems).toBeGreaterThanOrEqual(2)

    // Verify content exists twice by checking text
    const text = await editor.textContent()
    expect(text).toContain('Heading')
    expect(text).toContain('List item 1')
  })

  test('paste from external source preserves basic formatting', async ({ page }) => {
    await createNewDocument(page)

    const editor = page.locator('.ProseMirror')
    await editor.click()

    // Simulate pasting HTML content
    await page.evaluate(() => {
      const html = '<p><strong>Bold</strong> and <em>italic</em> text</p><ul><li>Item 1</li><li>Item 2</li></ul>'
      const clipboardData = new DataTransfer()
      clipboardData.setData('text/html', html)
      const pasteEvent = new ClipboardEvent('paste', { clipboardData })
      document.querySelector('.ProseMirror')?.dispatchEvent(pasteEvent)
    })

    await page.waitForTimeout(500)

    // Verify formatting preserved
    await expect(editor).toContainText('Bold and italic text')
    await expect(editor.locator('strong')).toContainText('Bold')
    await expect(editor.locator('em')).toContainText('italic')
    await expect(editor.locator('li').first()).toContainText('Item 1')
  })
})
