import { test, expect, Page } from './fixtures/isolated-env';
import { documentIdFromUrl, expectDocumentTitleSaved } from './fixtures/test-helpers';

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

    // W6-9: the title is persisted by the collaboration server on a 2s debounce
    // (schedulePersist), not by a REST throttle, so a fixed sleep shorter than
    // that races the durable write. Wait for the value to actually land.
    await expectDocumentTitleSaved(page, 'Hello World');

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

    // W6-9: the title is persisted by the collaboration server on a 2s debounce
    // (schedulePersist), not by a REST throttle, so a fixed sleep shorter than
    // that races the durable write. Wait for the value to actually land.
    await expectDocumentTitleSaved(page, fullTitle);

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

    // W6-9: the title is persisted by the collaboration server on a 2s debounce
    // (schedulePersist), not by a REST throttle, so a fixed sleep shorter than
    // that races the durable write. Wait for the value to actually land.
    await expectDocumentTitleSaved(page, 'Part 1 and Part 2 and Part 3');

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

    // W6-9: the title is persisted by the collaboration server on a 2s debounce
    // (schedulePersist), not by a REST throttle, so a fixed sleep shorter than
    // that races the durable write. Wait for the value to actually land.
    await expectDocumentTitleSaved(page, 'Bug: login fails');

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

  // ---------------------------------------------------------------------------
  // CONTINUOUS TYPING. Restored coverage — read this before editing either test.
  //
  // The test above types in two bursts with a pause between them. That pause is
  // exactly what makes it a weaker test than the one it replaced: `schedulePersist`
  // (api/src/collaboration/index.ts:189) is a pure trailing debounce with no maximum
  // wait, so every keystroke clears the pending timer and restarts it. A pause lets
  // the timer fire; continuous typing never does. The whole exposure lives in the
  // window the paused test steps over — measured at 13,862 ms of unsaved work during
  // continuous typing versus 2,026 ms when idle.
  //
  // So both cases are kept: the paused one above, and the two below, which never let
  // the keyboard go quiet inside the measured window.
  // ---------------------------------------------------------------------------

  const CONTINUOUS_TITLE = 'continuous typing with no pause at all until the very end';
  const KEYSTROKE_GAP_MS = 60;

  test('continuous typing: the whole value survives an unbroken typing session', async ({ page }) => {
    await createNewDocument(page);
    const docId = documentIdFromUrl(page.url());

    const titleInput = page.locator('textarea[placeholder="Untitled"]');
    await titleInput.focus();
    await expect(titleInput).toBeFocused({ timeout: 2000 });

    // No waitForTimeout longer than a keystroke gap anywhere in this loop: the point
    // is that the debounce is never allowed to fire mid-session.
    for (const ch of CONTINUOUS_TITLE) {
      await page.keyboard.type(ch);
      await page.waitForTimeout(KEYSTROKE_GAP_MS);
    }

    // Only now does typing stop, which is the first moment the trailing debounce can
    // fire. The complete value must land — not a truncated prefix from some
    // intermediate flush racing the last keystrokes.
    await expectDocumentTitleSaved(page, CONTINUOUS_TITLE, docId);
    await expect(titleInput).toHaveValue(CONTINUOUS_TITLE);

    await page.reload();
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('textarea[placeholder="Untitled"]')).toHaveValue(CONTINUOUS_TITLE, {
      timeout: 10000,
    });
  });

  // The exposure itself, pinned as a number. This was written as a `test.fail()` against
  // the un-capped debounce and went green once `PERSIST_MAX_WAIT_MS` landed in
  // `api/src/collaboration/index.ts` — it is the regression test for that fix (Rule 3), and
  // it goes red again if the ceiling is ever removed.
  //
  // The guarantee being asserted is the user-facing one: during a long unbroken
  // typing session, work must become durable at some bounded point rather than only
  // when the user stops. Before the fix nothing was written until typing ended, so a
  // browser crash, a laptop lid, or a server restart mid-sentence lost the entire session.
  test('continuous typing: work becomes durable before the typing session ends', async ({ page }) => {
    // The typing session alone is 14 s; the suite default (60 s) leaves too little
    // room for login plus document creation on a loaded machine, and a timeout would
    // satisfy test.fail() for the wrong reason.
    test.setTimeout(90_000);

    await createNewDocument(page);
    const docId = documentIdFromUrl(page.url());

    const titleInput = page.locator('textarea[placeholder="Untitled"]');
    await titleInput.focus();
    await expect(titleInput).toBeFocused({ timeout: 2000 });

    // A correct implementation flushes at least once inside a window this long even
    // if the keyboard never goes quiet. 5 s is deliberately generous against the 2 s
    // debounce — this is asserting "bounded", not a specific cadence.
    const DURABILITY_BUDGET_MS = 5000;
    const TYPING_SESSION_MS = 14_000;

    const serverTitle = async (): Promise<string> => {
      const resp = await page.request.get(`/api/documents/${docId}`);
      expect(resp.ok(), `GET /api/documents/${docId} should succeed`).toBeTruthy();
      return (await resp.json()).title ?? '';
    };

    // A character that does not occur in "Untitled", so "the server has our typing"
    // cannot be confused with "the server still has the default title".
    const MARK = 'q';
    expect('Untitled', 'marker must not occur in the default title').not.toContain(MARK);

    const started = Date.now();
    let firstDurableAt: number | null = null;

    // Type without ever pausing, polling the server between keystrokes. The poll is a
    // network round trip, not a sleep, so the keyboard is never idle for the debounce
    // window — which is the condition under test.
    while (Date.now() - started < TYPING_SESSION_MS) {
      await page.keyboard.type(MARK);
      await page.waitForTimeout(KEYSTROKE_GAP_MS);

      if ((await serverTitle()).includes(MARK)) {
        firstDurableAt = Date.now();
        break;
      }
    }

    const exposureMs = firstDurableAt === null ? Date.now() - started : firstDurableAt - started;
    expect(
      exposureMs,
      firstDurableAt === null
        ? `Nothing was persisted during ${TYPING_SESSION_MS}ms of unbroken typing — the ` +
          'entire session would be lost to a crash. schedulePersist has no maximum wait.'
        : `First durable write took ${exposureMs}ms of unbroken typing.`
    ).toBeLessThanOrEqual(DURABILITY_BUDGET_MS);
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
