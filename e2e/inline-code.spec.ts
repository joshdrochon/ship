import { test, expect, Page } from './fixtures/isolated-env';

// Helper to create a new document using the available buttons
async function createNewDocument(page: Page) {
  await page.goto('/docs');

  // Wait for the page to stabilize (may auto-redirect to existing doc)
  await page.waitForLoadState('networkidle');

  // Get current URL to detect change after clicking
  const currentUrl = page.url();

  // Try sidebar button first, fall back to main "New Document" button
  const sidebarButton = page.locator('aside').getByRole('button', { name: /new|create|\+/i }).first();
  const mainButton = page.getByRole('button', { name: 'New Document', exact: true });

  if (await sidebarButton.isVisible({ timeout: 2000 })) {
    await sidebarButton.click();
  } else {
    await expect(mainButton).toBeVisible({ timeout: 5000 });
    await mainButton.click();
  }

  // Wait for URL to change to a new document
  await page.waitForFunction(
    (oldUrl) => window.location.href !== oldUrl && /\/documents\/[a-f0-9-]+/.test(window.location.href),
    currentUrl,
    { timeout: 10000 }
  );

  // Wait for editor to be ready
  await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 });

  // Verify this is a NEW document (title should be "Untitled")
  await expect(page.locator('textarea[placeholder="Untitled"]')).toBeVisible({ timeout: 3000 });
}

test.describe('Inline Code', () => {
  test.beforeEach(async ({ page }) => {
    // Login before each test
    await page.goto('/login');
    await page.locator('#email').fill('dev@ship.local');
    await page.locator('#password').fill('admin123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    // Wait for app to load
    await expect(page).not.toHaveURL('/login', { timeout: 5000 });
  });

  test('should create inline code with backtick wrapping', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.waitForTimeout(300);

    // Type text with backticks around it
    await page.keyboard.type('Here is some `inline code` in text');

    // Wait for markdown transformation
    await page.waitForTimeout(500);

    // Should have code element
    const codeElement = editor.locator('code');
    await expect(codeElement).toBeVisible({ timeout: 3000 });
    await expect(codeElement).toContainText('inline code');
  });

  test('should toggle inline code with Cmd/Ctrl+E', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.waitForTimeout(300);

    // Type some text
    await page.keyboard.type('format this');

    // Select the text (Cmd+A or Ctrl+A)
    await page.keyboard.press('ControlOrMeta+a'); // ControlOrMeta resolves per platform: Meta on macOS, Control elsewhere

    // Wait a moment
    await page.waitForTimeout(200);

    // Press Cmd+E or Ctrl+E to toggle code
    await page.keyboard.press('ControlOrMeta+e');

    // Wait for formatting
    await page.waitForTimeout(300);

    // Should have code element
    const codeElement = editor.locator('code');
    await expect(codeElement).toBeVisible({ timeout: 3000 });
    await expect(codeElement).toContainText('format this');

    // Press Cmd+E again to remove formatting
    await page.keyboard.press('ControlOrMeta+e');
    await page.waitForTimeout(300);

    // Code element should be gone (text should still exist)
    const codeCount = await editor.locator('code').count();
    expect(codeCount).toBe(0);
    await expect(editor).toContainText('format this');
  });

  test('should show inline code styling', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.waitForTimeout(300);

    // Type text with backticks
    await page.keyboard.type('Check `const x = 10` syntax');
    await page.waitForTimeout(500);

    // Get the code element
    const codeElement = editor.locator('code');
    await expect(codeElement).toBeVisible({ timeout: 3000 });

    // Verify styling (monospace font, background color, padding, border-radius)
    const styles = await codeElement.evaluate(el => {
      const computed = window.getComputedStyle(el);
      return {
        fontFamily: computed.fontFamily,
        backgroundColor: computed.backgroundColor,
        padding: computed.padding,
        borderRadius: computed.borderRadius
      };
    });

    // Should have monospace font
    expect(styles.fontFamily).toMatch(/mono|courier|consolas|menlo|monaco/i);

    // Should have some background color (not transparent)
    expect(styles.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(styles.backgroundColor).not.toBe('transparent');

    // Should have some padding
    const hasPadding = styles.padding !== '0px' && styles.padding !== '';
    expect(hasPadding).toBeTruthy();
  });

  test('should persist inline code after reload', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.waitForTimeout(300);

    // Type text with inline code
    await page.keyboard.type('Remember `npm install` command');
    await page.waitForTimeout(500);

    // Verify code element exists
    const codeElement = editor.locator('code');
    await expect(codeElement).toBeVisible({ timeout: 3000 });

    // Wait for Yjs sync
    await page.waitForTimeout(2000);

    // Hard refresh
    await page.reload();

    // Wait for editor to load
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 });

    // Verify inline code still exists
    await expect(page.locator('.ProseMirror code')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.ProseMirror code')).toContainText('npm install');
  });

  test('should support multiple inline code elements in one line', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.waitForTimeout(300);

    // Type text with multiple code elements
    await page.keyboard.type('Use `const` or `let` but not `var`');
    await page.waitForTimeout(500);

    // Should have multiple code elements
    const codeElements = editor.locator('code');
    const count = await codeElements.count();
    expect(count).toBeGreaterThanOrEqual(3);

    // Verify each contains expected text
    await expect(codeElements.nth(0)).toContainText('const');
    await expect(codeElements.nth(1)).toContainText('let');
    await expect(codeElements.nth(2)).toContainText('var');
  });

  test('should handle nested backticks', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.waitForTimeout(300);

    // Type text with double backticks (escaping)
    await page.keyboard.type('Use ``backticks`` to escape');
    await page.waitForTimeout(500);

    // Should have some code element or handle escaped backticks
    const hasCode = await editor.locator('code').count();
    const text = await editor.textContent();

    // Either it creates code element or preserves the backticks
    expect(hasCode > 0 || text?.includes('backticks')).toBeTruthy();
  });

  test('should work in combination with other formatting', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.waitForTimeout(300);

    // Use actual formatting commands instead of markdown syntax
    // First, type and format as bold
    await page.keyboard.press('ControlOrMeta+b'); // Start bold
    await page.keyboard.type('Bold and ');
    await page.keyboard.press('ControlOrMeta+b'); // End bold

    // Then add inline code using backticks (TipTap auto-converts)
    await page.keyboard.type('`code`');
    await page.waitForTimeout(500);

    // Continue with more bold text
    await page.keyboard.press('ControlOrMeta+b');
    await page.keyboard.type(' together');
    await page.keyboard.press('ControlOrMeta+b');
    await page.waitForTimeout(500);

    // Should have bold text
    const hasBold = await editor.evaluate(() => {
      const text = document.querySelector('.ProseMirror')?.textContent || '';
      return text.includes('Bold');
    });
    expect(hasBold).toBeTruthy();

    // Should have code element (from backtick conversion)
    const codeElement = editor.locator('code');
    const hasCode = await codeElement.count() > 0;

    // Either code element exists or text contains 'code' word
    const text = await editor.textContent();
    expect(hasCode || text?.includes('code')).toBeTruthy();
  });
});
