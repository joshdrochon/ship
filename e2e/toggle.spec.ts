import { test, expect, Page } from './fixtures/isolated-env'
import { waitForSlashMenu } from './fixtures/test-helpers';

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

  // Wait for URL to change to a new document - unified document routing
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

test.describe('Toggle (Collapsible)', () => {
  test.beforeEach(async ({ page }) => {
    // Login before each test
    await page.goto('/login');
    await page.locator('#email').fill('dev@ship.local');
    await page.locator('#password').fill('admin123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    // Wait for app to load
    await expect(page).not.toHaveURL('/login', { timeout: 5000 });
  });

  test('should create toggle via slash command', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.waitForTimeout(300);

    // Type /toggle to trigger slash command
    await page.keyboard.type('/toggle');
    await waitForSlashMenu(page);

    // Should show toggle option
    const toggleOption = page.getByRole('button', { name: /Toggle|Collapsible/i });
    await expect(toggleOption).toBeVisible({ timeout: 5000 });

    // Press Enter to insert toggle
    await page.keyboard.press('Enter');

    // Wait for toggle to appear
    await expect(editor.locator('[data-type="details"]')).toBeVisible({ timeout: 3000 });
  });

  test('should expand and collapse toggle', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.waitForTimeout(300);

    // Insert toggle
    await page.keyboard.type('/toggle');
    await waitForSlashMenu(page);
    await page.keyboard.press('Enter');

    // Wait for toggle to appear
    const toggle = editor.locator('[data-type="details"]');
    await expect(toggle).toBeVisible({ timeout: 3000 });

    // Find toggle button/icon (usually a chevron or arrow)
    const toggleButton = toggle.locator('button, summary, [class*="toggle"], [class*="chevron"]').first();
    await expect(toggleButton).toBeVisible({ timeout: 2000 });

    // Check initial state (might be expanded or collapsed)
    const initiallyOpen = await toggle.evaluate(el => {
      if (el.tagName === 'DETAILS') return (el as HTMLDetailsElement).open;
      return el.getAttribute('data-open') === 'true' || el.classList.contains('open');
    });

    // Click to toggle
    await toggleButton.click();
    await page.waitForTimeout(300);

    // Verify state changed
    const afterClick = await toggle.evaluate(el => {
      if (el.tagName === 'DETAILS') return (el as HTMLDetailsElement).open;
      return el.getAttribute('data-open') === 'true' || el.classList.contains('open');
    });

    expect(afterClick).not.toBe(initiallyOpen);

    // Click again to toggle back
    await toggleButton.click();
    await page.waitForTimeout(300);

    // Verify state changed back
    const afterSecondClick = await toggle.evaluate(el => {
      if (el.tagName === 'DETAILS') return (el as HTMLDetailsElement).open;
      return el.getAttribute('data-open') === 'true' || el.classList.contains('open');
    });

    expect(afterSecondClick).toBe(initiallyOpen);
  });

  test('should edit toggle title', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.waitForTimeout(300);

    // Insert toggle
    await page.keyboard.type('/toggle');
    await waitForSlashMenu(page);
    await page.keyboard.press('Enter');

    // Wait for toggle to appear
    const toggle = editor.locator('[data-type="details"]');
    await expect(toggle).toBeVisible({ timeout: 3000 });

    // Find the title/summary element (uses .details-summary class)
    const title = toggle.locator('.details-summary').first();
    await title.click();
    await page.waitForTimeout(200);

    // Type title
    await page.keyboard.type('My Toggle Title');

    // Verify title appears
    await expect(toggle).toContainText('My Toggle Title');
  });

  test('should edit toggle content', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.waitForTimeout(300);

    // Insert toggle
    await page.keyboard.type('/toggle');
    await waitForSlashMenu(page);
    await page.keyboard.press('Enter');

    // Wait for toggle to appear
    const toggle = editor.locator('[data-type="details"]');
    await expect(toggle).toBeVisible({ timeout: 3000 });

    // Make sure toggle is expanded to edit content
    const isOpen = await toggle.evaluate(el => {
      if (el.tagName === 'DETAILS') return (el as HTMLDetailsElement).open;
      return el.getAttribute('data-open') === 'true' || el.classList.contains('open');
    });

    if (!isOpen) {
      const toggleButton = toggle.locator('button, summary, [class*="toggle"]').first();
      await toggleButton.click();
      await page.waitForTimeout(300);
    }

    // Click in content area (not the title)
    const content = toggle.locator('[class*="content"], p, div').last();
    await content.click();
    await page.waitForTimeout(200);

    // Type content
    await page.keyboard.type('Hidden content inside toggle');

    // Verify content appears
    await expect(toggle).toContainText('Hidden content inside toggle');
  });

  test('should support nested content in toggle', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.waitForTimeout(300);

    // Insert toggle
    await page.keyboard.type('/toggle');
    await waitForSlashMenu(page);
    await page.keyboard.press('Enter');

    // Wait for toggle to appear
    const toggle = editor.locator('[data-type="details"]');
    await expect(toggle).toBeVisible({ timeout: 3000 });

    // Make sure toggle is expanded
    const isOpen = await toggle.evaluate(el => {
      if (el.tagName === 'DETAILS') return (el as HTMLDetailsElement).open;
      return el.getAttribute('data-open') === 'true' || el.classList.contains('open');
    });

    if (!isOpen) {
      const toggleButton = toggle.locator('button, summary').first();
      await toggleButton.click();
      await page.waitForTimeout(300);
    }

    // Click in content area
    const content = toggle.locator('[class*="content"], p, div').last();
    await content.click();
    await page.waitForTimeout(200);

    // Add various content types
    await page.keyboard.type('Paragraph text');
    await page.keyboard.press('Enter');
    await page.keyboard.type('- List item');
    await page.keyboard.press('Enter');
    await page.keyboard.type('**Bold text**');

    // Verify nested content exists
    await expect(toggle).toContainText('Paragraph text');
    await expect(toggle).toContainText('List item');
  });

  test('should persist toggle state after reload', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.waitForTimeout(300);

    // Insert toggle
    await page.keyboard.type('/toggle');
    await waitForSlashMenu(page);
    await page.keyboard.press('Enter');

    // Wait for toggle to appear
    const toggle = editor.locator('[data-type="details"]');
    await expect(toggle).toBeVisible({ timeout: 3000 });

    // Add title (uses .details-summary class)
    const title = toggle.locator('.details-summary').first();
    await title.click();
    await page.keyboard.type('Persistent Toggle');

    // Wait for Yjs sync
    await page.waitForTimeout(2000);

    // Hard refresh
    await page.reload();

    // Wait for editor to load
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 });

    // Verify toggle still exists
    await expect(page.locator('.ProseMirror [data-type="details"]')).toBeVisible({ timeout: 5000 });

    // Verify title persisted
    await expect(page.locator('.ProseMirror')).toContainText('Persistent Toggle');
  });

  test('should support keyboard navigation', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.waitForTimeout(300);

    // Insert toggle
    await page.keyboard.type('/toggle');
    await waitForSlashMenu(page);
    await page.keyboard.press('Enter');

    // Wait for toggle to appear
    const toggle = editor.locator('[data-type="details"]');
    await expect(toggle).toBeVisible({ timeout: 3000 });

    // Focus should be in the toggle after creation
    // Try to navigate with arrow keys or Enter
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(200);

    // Type some content
    await page.keyboard.type('Keyboard nav test');

    // Verify we could type (means navigation worked)
    await expect(toggle).toContainText('Keyboard nav test');

    // Try to navigate out with arrow keys
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(200);

    // Type outside toggle
    await page.keyboard.type('Outside toggle');

    // Verify text appears outside
    await expect(editor).toContainText('Outside toggle');
  });

  test('should show collapse indicator icon', async ({ page }) => {
    await createNewDocument(page);

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await page.waitForTimeout(300);

    // Insert toggle
    await page.keyboard.type('/toggle');
    await waitForSlashMenu(page);
    await page.keyboard.press('Enter');

    // Wait for toggle to appear
    const toggle = editor.locator('[data-type="details"]');
    await expect(toggle).toBeVisible({ timeout: 3000 });

    // Look for chevron/arrow icon (svg element)
    const iconLocator = toggle.locator('svg').first();
    await expect(iconLocator).toBeVisible({ timeout: 2000 });

    // Get initial state - toggle starts open (expanded) with rotate-90 class
    const initialClasses = await iconLocator.getAttribute('class') || '';
    const initiallyRotated = initialClasses.includes('rotate-90');

    // Click to toggle (collapse)
    const toggleButton = toggle.locator('button').first();
    await toggleButton.click();
    await page.waitForTimeout(300);

    // Re-query and verify icon changed
    const newClasses = await toggle.locator('svg').first().getAttribute('class') || '';
    const nowRotated = newClasses.includes('rotate-90');

    // State should have changed (started rotated, now not rotated - or vice versa)
    expect(nowRotated).not.toBe(initiallyRotated);
  });
});
