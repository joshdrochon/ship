import { test, expect } from './fixtures/isolated-env'
import AxeBuilder from '@axe-core/playwright'

type Page = import('@playwright/test').Page

/**
 * WCAG 2.4.7 Focus Visible, checked so that it can fail.
 *
 * W7-7: the test this replaces focused exactly one element (`#email`) and passed it if
 *
 *     styles.borderColor !== styles.getPropertyValue('--border')
 *
 * Ship declares no `--border` custom property, so `getPropertyValue` returned `""`,
 * `borderColor` was never `""`, and that clause was true on every element in every state.
 * The test could not fail, so it never reported the 22 `focus:outline-none` sites in
 * web/src that removed the outline without substituting anything.
 *
 * What makes this version able to fail:
 *
 *  1. It walks every visible interactive element on the page instead of one.
 *  2. It compares the *focused* computed style against the *unfocused* one for the same
 *     element, so the assertion is about a change the user can see rather than about a
 *     value being non-empty.
 *  3. It normalises a Tailwind `focus:outline-none` to "no outline". That utility emits
 *     `outline: 2px solid transparent`, not `outline: none` — so the naive
 *     `outlineStyle !== 'none'` check passes on exactly the markup that has the defect.
 *     A zero-alpha outline colour is treated as no outline here, which is the whole point.
 *  4. An element that is fully transparent while focused is an offender even if its style
 *     changed, because an indicator nobody can see is not an indicator.
 */
const FOCUS_AUDIT_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(', ')

interface FocusAuditResult {
  checked: number
  skipped: number
  offenders: string[]
}

async function auditFocusIndicators(page: Page): Promise<FocusAuditResult> {
  // `transition-colors` is used all over web/src. Without this, the computed style read
  // immediately after .focus() is a frame part-way through the transition and the
  // before/after diff is noise. Killing transitions does not change the settled value.
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
  })

  // Chromium only matches :focus-visible on a programmatic .focus() when the most recent
  // user interaction was a key press. One Tab arms that flag, so the styles measured below
  // are the ones a keyboard user actually sees, not the ones a mouse user sees.
  await page.keyboard.press('Tab')

  return page.evaluate((selector: string): FocusAuditResult => {
    const isOpaque = (colour: string): boolean => {
      if (colour === 'transparent') return false
      const parts = /rgba?\(([^)]+)\)/.exec(colour)
      if (!parts) return true
      const channels = parts[1].split(',').map((n) => parseFloat(n))
      return channels.length < 4 || channels[3] > 0
    }

    /** Opacity is multiplicative down the tree, so an ancestor can hide the indicator. */
    const effectiveOpacity = (el: Element): number => {
      let value = 1
      for (let node: Element | null = el; node && node !== document.body; node = node.parentElement) {
        value *= parseFloat(getComputedStyle(node).opacity || '1')
      }
      return value
    }

    /** The visual state of every property this codebase uses to indicate focus. */
    const signature = (el: Element): Record<string, string> => {
      const s = getComputedStyle(el)
      const outlineDrawn =
        s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 && isOpaque(s.outlineColor)
      return {
        outline: outlineDrawn
          ? `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor} ${s.outlineOffset}`
          : 'none',
        boxShadow: s.boxShadow,
        border: [
          s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor,
          s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth,
          s.borderTopStyle, s.borderRightStyle, s.borderBottomStyle, s.borderLeftStyle,
        ].join('|'),
        background: `${s.backgroundColor} ${s.backgroundImage}`,
        text: `${s.color} ${s.textDecorationLine} ${s.textDecorationColor}`,
        transform: s.transform,
      }
    }

    const describe = (el: Element): string => {
      const tag = el.tagName.toLowerCase()
      const id = el.id ? `#${el.id}` : ''
      const name =
        el.getAttribute('aria-label') ||
        (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)
      const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 4).join('.')
      return `${tag}${id}${cls ? `.${cls}` : ''}${name ? ` "${name}"` : ''}`
    }

    const offenders: string[] = []
    let checked = 0
    let skipped = 0

    for (const el of Array.from(document.querySelectorAll(selector))) {
      const s = getComputedStyle(el)
      // Not rendered at all: nothing to indicate focus on, and it is not a focus stop.
      if (el.getClientRects().length === 0 || s.visibility === 'hidden' || s.display === 'none') {
        skipped++
        continue
      }

      const active = document.activeElement as HTMLElement | null
      if (active && active !== document.body) active.blur()
      const before = signature(el)

      ;(el as HTMLElement).focus()
      if (document.activeElement !== el) {
        // Refused focus (inert, hidden by a modal's focus trap, etc). Not a focus stop.
        skipped++
        continue
      }
      const after = signature(el)
      const opacity = effectiveOpacity(el)
      ;(el as HTMLElement).blur()
      checked++

      if (opacity === 0) {
        offenders.push(`${describe(el)} — focusable but fully transparent while focused`)
        continue
      }
      if (after.outline !== 'none') continue
      const changedKeys = Object.keys(after).filter((k) => after[k] !== before[k])
      if (changedKeys.length === 0) {
        offenders.push(`${describe(el)} — no outline on focus and no computed style changes`)
      }
    }

    return { checked, skipped, offenders }
  }, FOCUS_AUDIT_SELECTOR)
}

// Helper to log in before tests that need auth
async function login(page: import('@playwright/test').Page) {
  await page.goto('/login')
  await page.locator('#email').fill('dev@ship.local')
  await page.locator('#password').fill('admin123')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).not.toHaveURL('/login', { timeout: 5000 })
}

test.describe('Accessibility - axe-core audit', () => {
  test('login page has no critical accessibility violations', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('networkidle')

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()

    // Filter to only critical and serious violations
    const criticalViolations = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious'
    )

    if (criticalViolations.length > 0) {
      console.log('Critical violations:', JSON.stringify(criticalViolations, null, 2))
    }

    expect(criticalViolations).toHaveLength(0)
  })

  test('main app shell has no critical accessibility violations', async ({ page }) => {
    await login(page)
    await page.waitForLoadState('networkidle')

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()

    const criticalViolations = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious'
    )

    if (criticalViolations.length > 0) {
      console.log('Critical violations:', JSON.stringify(criticalViolations, null, 2))
    }

    expect(criticalViolations).toHaveLength(0)
  })

  test('docs mode has no critical accessibility violations', async ({ page }) => {
    await login(page)
    // Navigate to docs mode - click the nav item with "Docs" text or icon
    const docsLink = page.locator('nav a, aside a, [role="navigation"] a').filter({ hasText: /docs/i }).first()
    if (await docsLink.count() > 0) {
      await docsLink.click()
    } else {
      // Try finding by href
      await page.goto('/docs')
    }
    await page.waitForLoadState('networkidle')

    // W7-6. An axe scan only reports on markup that rendered, and the sidebar's
    // "N more..." row (web/src/pages/App.tsx:651-659) renders only past
    // SIDEBAR_ITEM_LIMIT = 10 root documents. With the old 3-document fixture the branch
    // never rendered, so `expect(criticalViolations).toHaveLength(0)` below was green
    // without ever having looked at it. Asserting the precondition turns a silent
    // loss of coverage into a failure: shrink the fixture or raise the limit and this
    // fails loudly instead of quietly scanning less of the page.
    const workspaceTree = page.locator('ul[aria-label="Workspace documents"]')
    await expect(
      workspaceTree.getByRole('link', { name: /\d+ more\.\.\./ }),
      'fixture must seed more than SIDEBAR_ITEM_LIMIT root documents, otherwise this scan ' +
        'silently skips the overflow markup. Add rows to additionalWikiDocs in e2e/fixtures/isolated-env.ts.'
    ).toBeVisible()

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()

    const criticalViolations = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious'
    )

    if (criticalViolations.length > 0) {
      console.log('Critical violations:', JSON.stringify(criticalViolations, null, 2))
    }

    expect(criticalViolations).toHaveLength(0)
  })

  test('programs mode has no critical accessibility violations', async ({ page }) => {
    await login(page)
    // Navigate to programs mode
    const programsLink = page.locator('nav a, aside a, [role="navigation"] a').filter({ hasText: /program/i }).first()
    if (await programsLink.count() > 0) {
      await programsLink.click()
    } else {
      await page.goto('/programs')
    }
    await page.waitForLoadState('networkidle')

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()

    const criticalViolations = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious'
    )

    if (criticalViolations.length > 0) {
      console.log('Critical violations:', JSON.stringify(criticalViolations, null, 2))
    }

    expect(criticalViolations).toHaveLength(0)
  })
})

test.describe('Accessibility - Keyboard Navigation', () => {
  test('can navigate login form with keyboard only', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('domcontentloaded')

    // Email field should be auto-focused on page load
    // Wait a bit for React to render and autofocus to take effect
    const emailField = page.locator('#email')
    await page.waitForTimeout(200)

    // If not already focused, click to focus (autofocus can be unreliable in tests)
    if (!await emailField.evaluate(el => el === document.activeElement)) {
      await emailField.focus()
    }
    await expect(emailField).toBeFocused({ timeout: 2000 })

    // In dev mode, fields are pre-filled, so clear and type fresh values
    await page.keyboard.press('Meta+a')
    await page.keyboard.type('dev@ship.local')

    // Tab to password field
    await page.keyboard.press('Tab')
    const passwordField = page.locator('#password')
    await expect(passwordField).toBeFocused()

    // Clear and type password
    await page.keyboard.press('Meta+a')
    await page.keyboard.type('admin123')

    // Tab to submit button
    await page.keyboard.press('Tab')
    const submitButton = page.getByRole('button', { name: 'Sign in', exact: true })
    await expect(submitButton).toBeFocused()

    // Press Enter to submit
    await page.keyboard.press('Enter')

    // Should be logged in
    await expect(page).not.toHaveURL('/login', { timeout: 5000 })
  })

  test('can navigate main app with keyboard - full flow from login to create issue', async ({ page }) => {
    // Login using the form
    await page.goto('/login')
    await page.locator('#email').fill('dev@ship.local')
    await page.locator('#password').fill('admin123')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page).not.toHaveURL('/login', { timeout: 5000 })

    // After login, verify we can tab through the app
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(500) // Give UI time to settle

    // Verify the page has focusable elements by checking they exist
    const focusableSelector = 'a, button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
    const focusableCount = await page.locator(focusableSelector).count()

    // Should have focusable elements in the app
    expect(focusableCount).toBeGreaterThan(0)

    // Tab a few times and verify we can move focus
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')

    // The page should still be valid (not crashed)
    await expect(page).not.toHaveURL('/login')
  })

  test('focus is visible on all interactive elements - login page', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('networkidle')

    const { checked, offenders } = await auditFocusIndicators(page)

    // Guards the audit itself: if the selector or the page stops producing elements, the
    // empty-offenders assertion below would pass vacuously — which is the exact failure
    // mode (W7-7) this test exists to close.
    expect(checked, 'login page should expose interactive elements to audit').toBeGreaterThanOrEqual(3)
    expect(
      offenders,
      'WCAG 2.4.7: every interactive element must show a visible change when focused'
    ).toEqual([])
  })

  test('focus is visible on all interactive elements - app shell', async ({ page }) => {
    // W7-6's other half. The login page has 4 controls; the authenticated shell has the
    // sidebar, icon rail, toolbars and comboboxes where the unreplaced `focus:outline-none`
    // sites actually live. Auditing only /login is how 22 of them survived.
    await login(page)
    await page.waitForLoadState('networkidle')

    const { checked, offenders } = await auditFocusIndicators(page)

    expect(checked, 'app shell should expose interactive elements to audit').toBeGreaterThanOrEqual(20)
    expect(
      offenders,
      'WCAG 2.4.7: every interactive element must show a visible change when focused'
    ).toEqual([])
  })

  test('tab order is logical on login page', async ({ page }) => {
    await page.goto('/login')

    // Email should be focused first (autoFocus)
    await expect(page.locator('#email')).toBeFocused({ timeout: 2000 })

    // Tab to password
    await page.keyboard.press('Tab')
    await expect(page.locator('#password')).toBeFocused()

    // Tab to submit
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeFocused()
  })
})

test.describe('Accessibility - Screen Reader Announcements', () => {
  test('login errors are announced via aria-live or role=alert', async ({ page }) => {
    await page.goto('/login')

    // Submit with invalid credentials
    await page.locator('#email').fill('invalid@test.com')
    await page.locator('#password').fill('wrongpassword')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()

    // Wait for error to appear
    await page.waitForTimeout(1000)

    // Check for aria-live region or alert role
    const alertOrLive = page.locator('[role="alert"], [aria-live="polite"], [aria-live="assertive"]')
    const count = await alertOrLive.count()

    // Should have an alert for the error
    expect(count).toBeGreaterThanOrEqual(1)
  })

  test('form fields have accessible labels', async ({ page }) => {
    await page.goto('/login')

    // Check email field has a label
    const emailField = page.locator('#email')
    const emailLabelledBy = await emailField.getAttribute('aria-labelledby')
    const emailLabel = page.locator('label[for="email"]')

    // Should have either aria-labelledby or a label element
    const hasEmailLabel = emailLabelledBy || (await emailLabel.count()) > 0

    expect(hasEmailLabel).toBeTruthy()

    // Check password field has a label
    const passwordField = page.locator('#password')
    const passwordLabelledBy = await passwordField.getAttribute('aria-labelledby')
    const passwordLabel = page.locator('label[for="password"]')

    const hasPasswordLabel = passwordLabelledBy || (await passwordLabel.count()) > 0

    expect(hasPasswordLabel).toBeTruthy()
  })
})

test.describe('Accessibility - Loading States', () => {
  test('login button shows loading state during submission', async ({ page }) => {
    await page.goto('/login')

    await page.locator('#email').fill('dev@ship.local')
    await page.locator('#password').fill('admin123')

    const submitButton = page.getByRole('button', { name: 'Sign in', exact: true })

    // Verify the button exists and has initial text
    const initialText = await submitButton.textContent()
    expect(initialText?.toLowerCase()).toContain('sign in')

    // Click and check for either:
    // 1. Button text changes to loading state
    // 2. Button becomes disabled
    // 3. We successfully navigate away (fast login)
    await submitButton.click()

    // Wait for either loading state OR navigation
    const result = await Promise.race([
      // Check for text change to "Signing in..."
      page.waitForFunction(
        () => {
          const btn = document.querySelector('button[type="submit"]')
          return btn?.textContent?.toLowerCase().includes('signing')
        },
        { timeout: 1000 }
      ).then(() => 'loading'),
      // Check for successful navigation
      page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 5000 }).then(() => 'navigated'),
    ]).catch(() => 'timeout')

    // Either we saw loading state or we navigated (fast login is ok)
    expect(['loading', 'navigated']).toContain(result)
  })
})
