import { test, expect, Page } from './fixtures/isolated-env';
import { documentIdFromUrl } from './fixtures/test-helpers';

/**
 * Auto-Save Race Condition Tests
 *
 * Tests that verify the auto-save mechanism prevents stale server responses
 * from overwriting local state during active typing.
 *
 * Key scenario: User types "Hello", pauses, server saves "Hello", user continues
 * typing "Hello World", stale server response should NOT overwrite to "Hello".
 */

// Helper to login
async function login(page: Page, email: string = 'dev@ship.local', password: string = 'admin123') {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL('/login', { timeout: 5000 });
}

// Helper to create a new document and wait for editor
async function createNewDocument(page: Page) {
  await page.goto('/docs');
  await page.waitForLoadState('networkidle');

  const currentUrl = page.url();
  // Button uses aria-label, not title attribute
  const newDocButton = page.getByRole('button', { name: /new document/i });
  await expect(newDocButton.first()).toBeVisible({ timeout: 5000 });
  await newDocButton.first().click();

  await page.waitForFunction(
    (oldUrl) => window.location.href !== oldUrl && /\/documents\/[a-f0-9-]+/.test(window.location.href),
    currentUrl,
    { timeout: 10000 }
  );

  await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('textarea[placeholder="Untitled"]')).toBeVisible({ timeout: 3000 });
}

// Helper to create a new issue
async function createNewIssue(page: Page) {
  await page.goto('/issues');
  await page.waitForLoadState('networkidle');

  // Use the sidebar button with aria-label (there's also a text button "New Issue" in main content)
  const newIssueButton = page.getByRole('button', { name: 'New issue', exact: true });
  await expect(newIssueButton).toBeVisible({ timeout: 5000 });
  await newIssueButton.click();

  await page.waitForURL(/\/documents\/[a-f0-9-]+/, { timeout: 10000 });
  await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('textarea[placeholder="Untitled"]')).toBeVisible({ timeout: 3000 });
}

test.describe('Auto-Save Race Conditions - Title Field', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('type-pause-type: stale response does not overwrite local title', async ({ page }) => {
    await createNewDocument(page);

    const titleInput = page.locator('textarea[placeholder="Untitled"]');

    // Type first part of title
    await titleInput.click();
    await titleInput.fill('Hello');

    // Wait for debounce/throttle to trigger save (500ms + network time)
    // This simulates the "pause to think" scenario
    await page.waitForTimeout(800);

    // Continue typing while server response may be in-flight
    await titleInput.fill('Hello World');

    // Wait for any stale responses to arrive
    await page.waitForTimeout(1500);

    // Title should be "Hello World", NOT reverted to "Hello"
    await expect(titleInput).toHaveValue('Hello World');

    // Reload to verify "Hello World" was actually saved
    await page.reload();
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('textarea[placeholder="Untitled"]')).toHaveValue('Hello World');
  });

  test('rapid typing with throttle: intermediate saves do not overwrite', async ({ page }) => {
    await createNewDocument(page);

    const titleInput = page.locator('textarea[placeholder="Untitled"]');
    // Use focus() instead of click() and wait for focus to be established
    await titleInput.focus();
    await expect(titleInput).toBeFocused({ timeout: 2000 });

    // Type character by character with small delays (simulates real typing)
    const fullTitle = 'This is a long title that takes time to type';
    for (const char of fullTitle) {
      await page.keyboard.type(char);
      await page.waitForTimeout(50); // 50ms between characters
    }

    // Wait for final save to complete
    await page.waitForTimeout(1500);

    // Title should be the full string, not truncated by intermediate saves
    await expect(titleInput).toHaveValue(fullTitle);

    // Reload to verify full title was saved
    await page.reload();
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('textarea[placeholder="Untitled"]')).toHaveValue(fullTitle);
  });

  test('multiple pause-resume cycles preserve all changes', async ({ page }) => {
    await createNewDocument(page);

    const titleInput = page.locator('textarea[placeholder="Untitled"]');
    await titleInput.click();

    // First segment
    await titleInput.fill('Part 1');
    await page.waitForTimeout(800); // Trigger save

    // Second segment
    await titleInput.fill('Part 1 and Part 2');
    await page.waitForTimeout(800); // Trigger save

    // Third segment
    await titleInput.fill('Part 1 and Part 2 and Part 3');
    await page.waitForTimeout(1500); // Wait for all saves

    // Should have complete title
    await expect(titleInput).toHaveValue('Part 1 and Part 2 and Part 3');

    // Reload to verify
    await page.reload();
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('textarea[placeholder="Untitled"]')).toHaveValue('Part 1 and Part 2 and Part 3');
  });

  test('issue title: stale response does not overwrite', async ({ page }) => {
    await createNewIssue(page);

    const titleInput = page.locator('textarea[placeholder="Untitled"]');

    // Type first part
    await titleInput.click();
    await titleInput.fill('Bug:');

    // Pause (trigger save)
    await page.waitForTimeout(800);

    // Continue typing
    await titleInput.fill('Bug: login fails');

    // Wait for responses
    await page.waitForTimeout(1500);

    // Should have full title
    await expect(titleInput).toHaveValue('Bug: login fails');

    // Reload to verify
    await page.reload();
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('textarea[placeholder="Untitled"]')).toHaveValue('Bug: login fails');
  });
});

test.describe('Auto-Save Race Conditions - Throttle Behavior', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  // W6-9 changed what "periodically" means here, so this test now asserts the
  // guarantee that actually protects the user's work rather than a PATCH count.
  //
  // Before: the title was saved by a throttled `PATCH /api/documents/:id`, so
  // counting PATCH bodies containing a title was a reasonable proxy for "work is
  // being flushed while you type". This test required at least 3 of them.
  //
  // Now: the title is a Y.Text replicated to the collaboration server on every
  // keystroke over the WebSocket, and the server writes it to the column on a
  // 2s trailing debounce. Counting PATCHes measures nothing — there are none in
  // the steady state. Worse, the debounce resets on each keystroke, so during
  // *continuous* typing there is legitimately no column write until you pause.
  //
  // The user-visible guarantee is that a typing session is not lost and is not
  // truncated: work done before a pause is durable, and the complete value
  // survives a reload. That is what is asserted, in two bursts so that an
  // implementation which only ever saved at the very end would still fail.
  test('throttle: intermediate and final title edits are both persisted', async ({ page }) => {
    await createNewDocument(page);
    const docId = documentIdFromUrl(page.url());

    const titleInput = page.locator('textarea[placeholder="Untitled"]');
    await titleInput.click();

    const serverTitle = async (): Promise<string> => {
      const resp = await page.request.get(`/api/documents/${docId}`);
      expect(resp.ok(), `GET /api/documents/${docId} should succeed`).toBeTruthy();
      return (await resp.json()).title ?? '';
    };

    // Burst 1 — type, then pause long enough for the trailing save to fire.
    const firstBurst = 'aaaaaaaaaa';
    for (const ch of firstBurst) {
      await page.keyboard.type(ch);
      await page.waitForTimeout(100);
    }
    await expect(async () => {
      expect(await serverTitle()).toBe(firstBurst);
    }).toPass({ timeout: 15000 });

    // Burst 2 — continue typing. The intermediate state above was already
    // durable, which is the property the old throttle assertion stood for.
    const secondBurst = 'bbbbbbbbbb';
    for (const ch of secondBurst) {
      await page.keyboard.type(ch);
      await page.waitForTimeout(100);
    }

    const expected = firstBurst + secondBurst;
    await expect(async () => {
      expect(await serverTitle()).toBe(expected);
    }).toPass({ timeout: 15000 });

    // And the complete, untruncated value survives a reload.
    await page.reload();
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('textarea[placeholder="Untitled"]')).toHaveValue(expected, {
      timeout: 10000,
    });
  });
});

test.describe('Auto-Save Race Conditions - Error Recovery', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('failed save is retried silently', async ({ page, context }) => {
    await createNewDocument(page);

    const titleInput = page.locator('textarea[placeholder="Untitled"]');
    await titleInput.click();

    // Set up route to fail first request, succeed on retry
    let requestCount = 0;
    await context.route('**/api/documents/**', async (route) => {
      const request = route.request();
      if (request.method() === 'PATCH') {
        requestCount++;
        if (requestCount === 1) {
          // First request fails
          await route.abort('failed');
        } else {
          // Subsequent requests succeed
          await route.continue();
        }
      } else {
        await route.continue();
      }
    });

    // Type title
    await titleInput.fill('Retryable Title');
    await page.waitForTimeout(2000); // Wait for retry

    // Remove route interception
    await context.unrouteAll();

    // Wait a bit more and reload
    await page.waitForTimeout(1000);

    // Verify it was eventually saved (via retry)
    await page.reload();
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 });
    // Should have the title (either from retry or subsequent save)
    const finalTitle = await page.locator('textarea[placeholder="Untitled"]').inputValue();
    expect(finalTitle).toContain('Retryable');
  });
});

test.describe('Auto-Save Race Conditions - Slow Network', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('slow response does not overwrite faster local changes', async ({ page, context }) => {
    await createNewDocument(page);

    // Slow down PATCH responses significantly
    await context.route('**/api/documents/**', async (route) => {
      const request = route.request();
      if (request.method() === 'PATCH') {
        // Delay response by 2 seconds
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      await route.continue();
    });

    const titleInput = page.locator('textarea[placeholder="Untitled"]');
    await titleInput.click();

    // Type "Slow" - this will trigger a save that takes 2s to respond
    await titleInput.fill('Slow');
    await page.waitForTimeout(600); // Let throttle trigger

    // Immediately type more - while first response is still pending
    await titleInput.fill('Slow and Fast');
    await page.waitForTimeout(600);

    await titleInput.fill('Slow and Fast and Final');

    // Wait for all responses (first slow response will arrive after ~2s)
    await page.waitForTimeout(4000);

    // Should have the final value, not reverted to "Slow"
    await expect(titleInput).toHaveValue('Slow and Fast and Final');
  });
});
