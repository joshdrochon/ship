import { test, expect, Page } from './fixtures/isolated-env'
import { expectDocumentTitleSaved } from './fixtures/test-helpers'

/**
 * Drag Handle E2E Tests
 *
 * These tests verify the complete drag-and-drop functionality for editor blocks.
 * A block can be a paragraph, heading, list item, code block, or document embed.
 */

test.describe('Drag Handle - Block Reordering', () => {
  // Helper to login before each test
  async function login(page: Page) {
    await page.goto('/login')
    await page.getByRole('textbox', { name: /email/i }).fill('dev@ship.local')
    await page.getByRole('textbox', { name: /password/i }).fill('admin123')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page).not.toHaveURL('/login', { timeout: 5000 })
  }

  // Helper to create a new document and get to the editor
  async function createNewDocument(page: Page) {
    await page.goto('/docs')
    await page.getByRole('button', { name: 'New Document', exact: true }).click()
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 10000 })
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })
  }

  // Helper to add multiple paragraphs to the editor
  async function addParagraphs(page: Page, texts: string[]) {
    const editor = page.locator('.ProseMirror')
    await editor.click()

    for (let i = 0; i < texts.length; i++) {
      await page.keyboard.type(texts[i])
      if (i < texts.length - 1) {
        await page.keyboard.press('Enter')
      }
    }

    // Wait for content to be rendered
    await page.waitForTimeout(300)
  }

  // Helper to get paragraph texts in order (excludes collaboration cursor labels and empty paragraphs)
  async function getParagraphTexts(page: Page): Promise<string[]> {
    return await page.evaluate(() => {
      const paragraphs = document.querySelectorAll('.ProseMirror p')
      return Array.from(paragraphs)
        .map(p => {
          // Clone the paragraph and remove collaboration cursor elements
          const clone = p.cloneNode(true) as HTMLElement
          clone.querySelectorAll('.collaboration-cursor__label, .collaboration-cursor__caret').forEach(el => el.remove())
          return clone.textContent || ''
        })
        .filter(text => text.trim() !== '') // Filter out empty paragraphs
    })
  }

  // Helper to perform drag operation using HTML5 drag events
  // Uses dispatchEvent approach because Playwright's dragTo has issues with
  // ProseMirror's pointer event handling
  async function dragBlockToPosition(
    page: Page,
    sourceIndex: number,
    targetIndex: number,
    position: 'before' | 'after' = 'after'
  ) {
    const paragraphs = page.locator('.ProseMirror p')
    const sourceParagraph = paragraphs.nth(sourceIndex)

    // Hover over source to show drag handle
    await sourceParagraph.hover()
    await page.waitForTimeout(200)

    const dragHandleLocator = page.locator('.editor-drag-handle')
    await expect(dragHandleLocator).toBeVisible({ timeout: 10000 })

    // Element handles are needed for dispatchEvent, but they must come from the locators
    // above rather than a fresh `page.$`. `page.$` is a one-shot query that does not wait:
    // it returns whatever is in the DOM at that instant, or null. The drag handle is
    // rendered on hover and removed when the pointer leaves, so between the assertion
    // above and a re-query below it can legitimately disappear -- a check-then-use race
    // that surfaced as `Required elements not found`, which reads like a selector bug
    // rather than a timing one. Measured at 1 failure in 195 attempts.
    //
    // `elementHandle()` waits for the element the locator describes, so the handle that
    // gets dispatched is the one that was just asserted visible.
    //
    // The target keeps `:nth-child` rather than `.nth(targetIndex)`: they differ whenever
    // the document holds a non-paragraph sibling, and the callers here were written
    // against `:nth-child` semantics.
    const dragHandle = await dragHandleLocator.elementHandle({ timeout: 10000 })
    const targetPara = await page
      .locator(`.ProseMirror p:nth-child(${targetIndex + 1})`)
      .elementHandle({ timeout: 10000 })
    const editor = await page.locator('.ProseMirror').elementHandle({ timeout: 10000 })

    if (!dragHandle || !targetPara || !editor) {
      throw new Error('Required elements not found')
    }

    const targetBox = await targetPara.boundingBox()
    if (!targetBox) throw new Error('Target paragraph bounding box not found')

    // Calculate drop coordinates - drop in top/bottom quarter of target element
    // (not above/below it, as that may not hit a valid block position)
    const dropY = position === 'after'
      ? targetBox.y + targetBox.height * 0.75  // bottom quarter triggers "after"
      : targetBox.y + targetBox.height * 0.25  // top quarter triggers "before"
    const dropX = targetBox.x + targetBox.width / 2

    // Dispatch drag events manually to work around ProseMirror's pointer event handling
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer())

    await dragHandle.dispatchEvent('dragstart', { dataTransfer })
    await page.waitForTimeout(50)

    await editor.dispatchEvent('dragenter', { dataTransfer })
    await editor.dispatchEvent('dragover', {
      dataTransfer,
      clientX: dropX,
      clientY: dropY
    })
    await page.waitForTimeout(50)

    await editor.dispatchEvent('drop', {
      dataTransfer,
      clientX: dropX,
      clientY: dropY
    })

    await dragHandle.dispatchEvent('dragend')

    // Wait for DOM update and sync
    await page.waitForTimeout(500)

    // Wait for the save indicator to confirm the change persisted
    await page.waitForSelector('text=/Saved|Cached|Saving|Offline/', { timeout: 10000 }).catch(() => {
      // Saved indicator may not always appear, continue anyway
    })
  }

  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test.describe('Drag Handle Visibility', () => {
    test('drag handle appears on hover over paragraph', async ({ page }) => {
      await createNewDocument(page)
      await addParagraphs(page, ['Test paragraph'])

      const paragraph = page.locator('.ProseMirror p').first()
      const dragHandle = page.locator('.editor-drag-handle')

      // Initially hidden or low opacity
      await expect(dragHandle).toBeAttached()

      // Hover to show
      await paragraph.hover()
      await expect(dragHandle).toHaveCSS('opacity', '1', { timeout: 2000 })
    })

    test('drag handle appears on hover over heading', async ({ page }) => {
      await createNewDocument(page)

      const editor = page.locator('.ProseMirror')
      await editor.click()
      await page.keyboard.type('# Heading')
      await page.waitForTimeout(300)

      const heading = page.locator('.ProseMirror h1')
      await expect(heading).toBeVisible()

      await heading.hover()
      const dragHandle = page.locator('.editor-drag-handle')
      await expect(dragHandle).toHaveCSS('opacity', '1', { timeout: 2000 })
    })

    test('drag handle stays visible when moving cursor to it', async ({ page }) => {
      await createNewDocument(page)
      await addParagraphs(page, ['Test content'])

      const paragraph = page.locator('.ProseMirror p').first()
      await paragraph.hover()

      const dragHandle = page.locator('.editor-drag-handle')
      await expect(dragHandle).toBeVisible({ timeout: 2000 })

      // Move to drag handle - should stay visible
      await dragHandle.hover()
      await page.waitForTimeout(500)
      await expect(dragHandle).toBeVisible()
    })

    test('drag handle hides when mouse leaves editor area', async ({ page }) => {
      await createNewDocument(page)
      await addParagraphs(page, ['Test content'])

      const paragraph = page.locator('.ProseMirror p').first()
      await paragraph.hover()

      const dragHandle = page.locator('.editor-drag-handle')
      await expect(dragHandle).toHaveCSS('opacity', '1', { timeout: 2000 })

      // Move mouse away from editor
      await page.mouse.move(0, 0)
      await page.waitForTimeout(500)

      // Should be hidden (opacity 0 or not visible)
      await expect(dragHandle).toHaveCSS('opacity', '0', { timeout: 2000 })
    })
  })

  test.describe('Block Selection via Click', () => {
    test('clicking drag handle selects the paragraph', async ({ page }) => {
      await createNewDocument(page)
      await addParagraphs(page, ['First paragraph', 'Second paragraph'])

      const firstParagraph = page.locator('.ProseMirror p').first()
      await firstParagraph.hover()

      const dragHandle = page.locator('.editor-drag-handle')
      await expect(dragHandle).toBeVisible({ timeout: 2000 })
      await dragHandle.click()

      // First paragraph should have selection class
      await expect(firstParagraph).toHaveClass(/ProseMirror-selectednode/)
    })

    test('clicking drag handle on second block selects that block', async ({ page }) => {
      await createNewDocument(page)
      await addParagraphs(page, ['First', 'Second', 'Third'])

      const secondParagraph = page.locator('.ProseMirror p').nth(1)
      await secondParagraph.hover()

      const dragHandle = page.locator('.editor-drag-handle')
      await expect(dragHandle).toBeVisible({ timeout: 2000 })
      await dragHandle.click()

      await expect(secondParagraph).toHaveClass(/ProseMirror-selectednode/)
    })
  })

  test.describe('Paragraph Reordering', () => {
    test('can drag first paragraph to end', async ({ page }) => {
      await createNewDocument(page)
      await addParagraphs(page, ['FIRST', 'SECOND', 'THIRD'])

      // Verify initial order
      let texts = await getParagraphTexts(page)
      expect(texts).toEqual(['FIRST', 'SECOND', 'THIRD'])

      // Drag first to after third
      await dragBlockToPosition(page, 0, 2, 'after')

      // Verify new order
      texts = await getParagraphTexts(page)
      expect(texts).toEqual(['SECOND', 'THIRD', 'FIRST'])
    })

    test('can drag last paragraph to beginning', async ({ page }) => {
      await createNewDocument(page)
      await addParagraphs(page, ['FIRST', 'SECOND', 'THIRD'])

      // Wait for content to be stable and Yjs to sync
      await page.waitForTimeout(500)

      // Verify initial order
      let texts = await getParagraphTexts(page)
      expect(texts).toEqual(['FIRST', 'SECOND', 'THIRD'])

      // Drag third to before first with retry for flaky drag operations
      let attempts = 0
      const maxAttempts = 3
      while (attempts < maxAttempts) {
        attempts++
        await dragBlockToPosition(page, 2, 0, 'before')
        texts = await getParagraphTexts(page)
        if (texts[0] === 'THIRD') break
        // Reset and retry - content may not have moved
        if (attempts < maxAttempts) {
          await page.waitForTimeout(500)
        }
      }

      // Verify new order
      expect(texts).toEqual(['THIRD', 'FIRST', 'SECOND'])
    })

    test('can drag middle paragraph down', async ({ page }) => {
      await createNewDocument(page)
      await addParagraphs(page, ['FIRST', 'SECOND', 'THIRD'])

      // Drag second to after third
      await dragBlockToPosition(page, 1, 2, 'after')

      const texts = await getParagraphTexts(page)
      expect(texts).toEqual(['FIRST', 'THIRD', 'SECOND'])
    })

    test('can drag middle paragraph up', async ({ page }) => {
      await createNewDocument(page)
      await addParagraphs(page, ['FIRST', 'SECOND', 'THIRD'])

      // Drag second to before first
      await dragBlockToPosition(page, 1, 0, 'before')

      const texts = await getParagraphTexts(page)
      expect(texts).toEqual(['SECOND', 'FIRST', 'THIRD'])
    })
  })

  test.describe('Content Preservation', () => {
    test('drag preserves full paragraph content', async ({ page }) => {
      await createNewDocument(page)
      const longContent = 'This is a longer paragraph with multiple words and some special chars: @#$%'
      await addParagraphs(page, [longContent, 'Second block'])

      // Drag first to after second
      await dragBlockToPosition(page, 0, 1, 'after')

      // Verify content is preserved
      const texts = await getParagraphTexts(page)
      expect(texts).toContain(longContent)
      expect(texts).toContain('Second block')
    })

    test('drag preserves markdown-style heading', async ({ page }) => {
      await createNewDocument(page)

      const editor = page.locator('.ProseMirror')
      await editor.click()

      // Create heading (auto-converted from markdown) and paragraph
      await page.keyboard.type('## Styled Heading')
      await page.keyboard.press('Enter')
      await page.keyboard.type('Normal paragraph')

      await page.waitForTimeout(300)

      // Verify heading was created
      const heading = page.locator('.ProseMirror h2')
      await expect(heading).toContainText('Styled Heading')

      // Drag heading to after paragraph
      await heading.hover()
      const dragHandle = page.locator('.editor-drag-handle')
      await expect(dragHandle).toBeVisible({ timeout: 2000 })

      const handle = await page.$('.editor-drag-handle')
      const targetPara = await page.$('.ProseMirror p')
      const editorEl = await page.$('.ProseMirror')

      if (!handle || !targetPara || !editorEl) {
        throw new Error('Required elements not found')
      }

      const targetBox = await targetPara.boundingBox()
      if (!targetBox) throw new Error('Target bounding box not found')

      const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
      await handle.dispatchEvent('dragstart', { dataTransfer })
      await page.waitForTimeout(50)

      await editorEl.dispatchEvent('dragenter', { dataTransfer })
      await editorEl.dispatchEvent('dragover', {
        dataTransfer,
        clientX: targetBox.x + targetBox.width / 2,
        clientY: targetBox.y + targetBox.height * 0.75
      })
      await page.waitForTimeout(50)

      await editorEl.dispatchEvent('drop', {
        dataTransfer,
        clientX: targetBox.x + targetBox.width / 2,
        clientY: targetBox.y + targetBox.height * 0.75
      })
      await handle.dispatchEvent('dragend')

      await page.waitForTimeout(300)

      // Verify heading still exists and is still an h2
      const headingAfter = page.locator('.ProseMirror h2')
      await expect(headingAfter).toContainText('Styled Heading')
    })
  })

  test.describe('Heading Reordering', () => {
    test('can drag heading block', async ({ page }) => {
      await createNewDocument(page)

      const editor = page.locator('.ProseMirror')
      await editor.click()

      // Create heading and paragraphs
      await page.keyboard.type('# My Heading')
      await page.keyboard.press('Enter')
      await page.keyboard.type('Paragraph one')
      await page.keyboard.press('Enter')
      await page.keyboard.type('Paragraph two')

      await page.waitForTimeout(300)

      // Verify heading exists
      const heading = page.locator('.ProseMirror h1')
      await expect(heading).toHaveText('My Heading')

      // Hover over heading and drag to end using dispatchEvent approach
      await heading.hover()
      const dragHandleLocator = page.locator('.editor-drag-handle')
      await expect(dragHandleLocator).toBeVisible({ timeout: 10000 })

      const dragHandle = await page.$('.editor-drag-handle')
      const lastParagraph = await page.$('.ProseMirror p:last-child')
      const editorEl = await page.$('.ProseMirror')

      if (!dragHandle || !lastParagraph || !editorEl) {
        throw new Error('Required elements not found')
      }

      const lastBox = await lastParagraph.boundingBox()
      if (!lastBox) throw new Error('Last paragraph bounding box not found')

      const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
      await dragHandle.dispatchEvent('dragstart', { dataTransfer })
      await page.waitForTimeout(50)

      await editorEl.dispatchEvent('dragenter', { dataTransfer })
      await editorEl.dispatchEvent('dragover', {
        dataTransfer,
        clientX: lastBox.x + lastBox.width / 2,
        clientY: lastBox.y + lastBox.height + 10
      })
      await page.waitForTimeout(50)

      await editorEl.dispatchEvent('drop', {
        dataTransfer,
        clientX: lastBox.x + lastBox.width / 2,
        clientY: lastBox.y + lastBox.height + 10
      })
      await dragHandle.dispatchEvent('dragend')

      await page.waitForTimeout(300)

      // Verify heading moved to end
      const editorContent = await editor.innerHTML()
      const headingPosition = editorContent.indexOf('<h1>')
      const lastParaPosition = editorContent.lastIndexOf('<p>')

      // Heading should come after all paragraphs
      expect(headingPosition).toBeGreaterThan(lastParaPosition)
    })
  })

  test.describe('Document Embed Reordering', () => {
    test('can drag document embed block', async ({ page }) => {
      // First create a document to embed
      await page.goto('/docs')
      await page.getByRole('button', { name: 'New Document', exact: true }).click()
      await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 10000 })

      // Give it a title and capture the document ID
      const embeddableDocUrl = page.url()
      const embeddableDocId = embeddableDocUrl.split('/documents/')[1]
      const titleInput = page.getByPlaceholder('Untitled')
      await titleInput.fill('Embeddable Doc')
      // Outcome, not transport: since W6-9 the title is persisted by the
      // collaboration server, not by a REST PATCH from the browser.
      await expectDocumentTitleSaved(page, 'Embeddable Doc', embeddableDocId)

      // Create another document with the embed
      await page.goto('/docs')
      await page.getByRole('button', { name: 'New Document', exact: true }).click()
      await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 10000 })

      const editor = page.locator('.ProseMirror')
      // Wait for the editor to be ready rather than sleeping at it. TipTap and
      // ProseMirror now ship in their own `vendor-editor` chunk and this route is
      // React.lazy, so the editor mounts strictly later than it used to. The fixed
      // 500 ms this replaces was already a guess; code splitting is what made the
      // guess wrong.
      await expect(editor).toBeVisible({ timeout: 15000 })
      await expect(editor).toHaveAttribute('contenteditable', 'true')
      await editor.click()

      // Add content before embed
      await page.keyboard.type('BEFORE EMBED')
      await page.keyboard.press('Enter')

      // Insert the embed through the slash menu — the only path the application
      // actually implements.
      //
      // What was here before: three strategies tried in order. The first dispatched a
      // CustomEvent named `insert-document-embed`, which nothing in web/src or api/src
      // has ever listened for, so it was dead code that always fell through. The third
      // appended a raw <div data-document-embed> straight into `.ProseMirror` via
      // appendChild, which satisfies the selector below without ever entering the
      // ProseMirror document — so the drag assertions that follow would have been
      // operating on a node the editor does not know exists.
      //
      // Rule 2 (p.8) permits fixing a test with justification. The justification is that
      // the test asserted on DOM it had injected itself, and the fallbacks masked which
      // path ran, so a genuine break in embed insertion could not have failed it.
      const documentEmbed = page.locator('[data-document-embed]')

      await page.keyboard.type('/doc', { delay: 50 })

      // The suggestion list renders only after the document query resolves. Wait on the
      // option, not on a fixed interval.
      //
      // Match the description as well as the title. The sidebar document tree also
      // renders a button named "Embeddable Doc" — the document itself — and a bare
      // /Embeddable Doc/ matched it first, navigating away instead of inserting.
      // SlashCommands.tsx:130 gives every document suggestion the description
      // "Embed this document", so the accessible name of the menu item is the title
      // followed by that phrase, and nothing else on the page has both.
      const embedOption = page
        .getByRole('button', { name: /Embeddable Doc\s+Embed this document/i })
        .first()
      await expect(embedOption).toBeVisible({ timeout: 15000 })
      await embedOption.click()

      // The embed must be in the editor before anything is typed after it.
      await expect(documentEmbed.first()).toBeVisible({ timeout: 10000 })

      // Add content after embed
      await page.keyboard.press('Enter')
      await page.keyboard.type('AFTER EMBED')
      await expect(editor).toContainText('AFTER EMBED')

      const embedCount = await documentEmbed.count()

      // Document embed should be inserted - fail if it doesn't work
      expect(embedCount).toBeGreaterThan(0)

      // Get initial content order
      const initialContent = await editor.textContent()
      const beforeFirst = initialContent?.indexOf('BEFORE EMBED') ?? -1
      const embedFirst = initialContent?.indexOf('Embeddable Doc') ?? -1
      const afterFirst = initialContent?.indexOf('AFTER EMBED') ?? -1

      // Verify initial order: BEFORE, EMBED, AFTER
      expect(beforeFirst).toBeLessThan(embedFirst)
      expect(embedFirst).toBeLessThan(afterFirst)

      // Hover over embed to show drag handle
      await documentEmbed.first().hover()

      const dragHandleLocator = page.locator('.editor-drag-handle')
      await expect(dragHandleLocator).toBeVisible({ timeout: 10000 })

      // Use dispatchEvent approach for drag
      const dragHandle = await page.$('.editor-drag-handle')
      const lastParagraph = await page.$('.ProseMirror p:last-child')
      const editorEl = await page.$('.ProseMirror')

      if (!dragHandle || !lastParagraph || !editorEl) {
        throw new Error('Required elements not found')
      }

      const lastBox = await lastParagraph.boundingBox()
      if (!lastBox) throw new Error('Last paragraph bounding box not found')

      const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
      await dragHandle.dispatchEvent('dragstart', { dataTransfer })
      await page.waitForTimeout(50)

      await editorEl.dispatchEvent('dragenter', { dataTransfer })
      await editorEl.dispatchEvent('dragover', {
        dataTransfer,
        clientX: lastBox.x + lastBox.width / 2,
        clientY: lastBox.y + lastBox.height + 10
      })
      await page.waitForTimeout(50)

      await editorEl.dispatchEvent('drop', {
        dataTransfer,
        clientX: lastBox.x + lastBox.width / 2,
        clientY: lastBox.y + lastBox.height + 10
      })
      await dragHandle.dispatchEvent('dragend')

      await page.waitForTimeout(300)

      // Verify new order: BEFORE, AFTER, EMBED
      const finalContent = await editor.textContent()
      const beforeFinal = finalContent?.indexOf('BEFORE EMBED') ?? -1
      const afterFinal = finalContent?.indexOf('AFTER EMBED') ?? -1
      const embedFinal = finalContent?.indexOf('Embeddable Doc') ?? -1

      expect(beforeFinal).toBeLessThan(afterFinal)
      expect(afterFinal).toBeLessThan(embedFinal)
    })
  })

  test.describe('Multiple Drag Operations', () => {
    test('can perform multiple sequential drags', async ({ page }) => {
      await createNewDocument(page)
      await addParagraphs(page, ['ONE', 'TWO', 'THREE', 'FOUR'])

      // First drag: ONE to end -> TWO, THREE, FOUR, ONE
      await dragBlockToPosition(page, 0, 3, 'after')
      let texts = await getParagraphTexts(page)
      expect(texts).toEqual(['TWO', 'THREE', 'FOUR', 'ONE'])

      // Second drag: TWO to end -> THREE, FOUR, ONE, TWO
      await dragBlockToPosition(page, 0, 3, 'after')
      texts = await getParagraphTexts(page)
      expect(texts).toEqual(['THREE', 'FOUR', 'ONE', 'TWO'])

      // Third drag: ONE (now at index 2) to beginning -> ONE, THREE, FOUR, TWO
      await dragBlockToPosition(page, 2, 0, 'before')
      texts = await getParagraphTexts(page)
      expect(texts).toEqual(['ONE', 'THREE', 'FOUR', 'TWO'])
    })
  })

  test.describe('Persistence', () => {
    // Skip: Yjs persistence is a separate concern from drag handle functionality.
    // The drag operation itself works (verified by other tests). This test fails
    // because the app's Yjs sync doesn't persist quickly enough for test timing.
    test('reordered content persists after page reload', async ({ page }) => {
      await createNewDocument(page)
      await addParagraphs(page, ['ALPHA', 'BETA', 'GAMMA'])

      // Get the current URL to navigate back
      const docUrl = page.url()

      // Drag to reorder
      await dragBlockToPosition(page, 0, 2, 'after')

      // Verify reorder happened
      let texts = await getParagraphTexts(page)
      expect(texts).toEqual(['BETA', 'GAMMA', 'ALPHA'])

      // Wait for Yjs sync and network to settle
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(2000)

      // Reload the page
      await page.reload()
      await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

      // Wait for WebSocket reconnection and Yjs sync
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(1000)

      // Verify order is preserved
      texts = await getParagraphTexts(page)
      expect(texts).toEqual(['BETA', 'GAMMA', 'ALPHA'])
    })
  })

  test.describe('Edge Cases', () => {
    test('dragging to same position does nothing', async ({ page }) => {
      await createNewDocument(page)
      await addParagraphs(page, ['FIRST', 'SECOND', 'THIRD'])

      // Drag first paragraph onto itself using dispatchEvent
      const firstParagraphLocator = page.locator('.ProseMirror p').first()
      await firstParagraphLocator.hover()

      const dragHandleLocator = page.locator('.editor-drag-handle')
      await expect(dragHandleLocator).toBeVisible({ timeout: 10000 })

      const dragHandle = await page.$('.editor-drag-handle')
      const firstParagraph = await page.$('.ProseMirror p:first-child')
      const editorEl = await page.$('.ProseMirror')

      if (!dragHandle || !firstParagraph || !editorEl) {
        throw new Error('Required elements not found')
      }

      const firstBox = await firstParagraph.boundingBox()
      if (!firstBox) throw new Error('First paragraph bounding box not found')

      const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
      await dragHandle.dispatchEvent('dragstart', { dataTransfer })
      await page.waitForTimeout(50)

      await editorEl.dispatchEvent('dragenter', { dataTransfer })
      await editorEl.dispatchEvent('dragover', {
        dataTransfer,
        clientX: firstBox.x + firstBox.width / 2,
        clientY: firstBox.y + firstBox.height / 2
      })
      await page.waitForTimeout(50)

      await editorEl.dispatchEvent('drop', {
        dataTransfer,
        clientX: firstBox.x + firstBox.width / 2,
        clientY: firstBox.y + firstBox.height / 2
      })
      await dragHandle.dispatchEvent('dragend')

      await page.waitForTimeout(300)

      // Order should be unchanged
      const texts = await getParagraphTexts(page)
      expect(texts).toEqual(['FIRST', 'SECOND', 'THIRD'])
    })

    test('handles single block document', async ({ page }) => {
      await createNewDocument(page)
      await addParagraphs(page, ['Only block'])

      const paragraph = page.locator('.ProseMirror p').first()
      await paragraph.hover()

      const dragHandle = page.locator('.editor-drag-handle')
      await expect(dragHandle).toBeVisible({ timeout: 2000 })

      // Click should still select
      await dragHandle.click()
      await expect(paragraph).toHaveClass(/ProseMirror-selectednode/)
    })

    test('handles empty paragraphs', async ({ page }) => {
      await createNewDocument(page)

      const editor = page.locator('.ProseMirror')
      await editor.click()

      // Create content with empty paragraph in middle
      await page.keyboard.type('Content')
      await page.keyboard.press('Enter')
      await page.keyboard.press('Enter')  // Empty paragraph
      await page.keyboard.type('More content')

      await page.waitForTimeout(300)

      // Should be able to hover and see drag handle on content paragraphs
      const firstParagraph = page.locator('.ProseMirror p').first()
      await firstParagraph.hover()

      const dragHandle = page.locator('.editor-drag-handle')
      await expect(dragHandle).toBeVisible({ timeout: 2000 })
    })
  })
})
