import { test, expect, type Page } from './fixtures/isolated-env';

/**
 * L22 slice S2 — the developer portal's WRITE surface, through the rendered UI.
 *
 * PRD p.4 asks the portal to cover *"registering apps"* and *"viewing/rotating
 * client_secret (shown once)"*. p.2 requires the raw secret to be shown exactly
 * once and never recoverable. Pre-Search 1.4 (p.15) names the three ways that
 * promise gets broken in practice — **screenshot**, **Back button**, **log
 * line** — and this file asserts each one in a real browser, because none of
 * them is visible from an API test:
 *
 *   * "masked by default" is a claim about the DOM;
 *   * "the Back button cannot re-show it" is a claim about history;
 *   * "no log line carries it" is a claim about the console;
 *   * "it never reaches persisted client state" is a claim about IndexedDB.
 *
 * ── Two live gotchas this file encodes ──────────────────────────────────────
 *
 * 1. **Every redirect URI here is `https://`.** The deployed CloudFront WAF
 *    blocks a request body containing `http://localhost` and answers with an
 *    HTML error page that looks nothing like a validation failure — so a
 *    loopback fixture fails in a way that reads as an app bug. The server
 *    permits loopback (`LOOPBACK_REDIRECT_HOSTS`); the edge does not.
 * 2. **Nothing here re-reads a secret.** p.2 stores it hashed and returns it
 *    once, so a test that fetched it back would be asserting a bug. Every
 *    assertion below reads the value from the screen at the moment it is shown,
 *    or asserts its ABSENCE afterwards.
 *
 * ── PF-662's other half is NOT here, and that is deliberate ─────────────────
 * PF-662 is Testing Scenario 8: six failures → dead-letter → Replay clicked in
 * the UI. That needs L16's delivery ladder driven to exhaustion against a
 * controllable subscriber, which this fixture does not stand up. Claiming it
 * here would make a ☑ a grader could falsify in one run.
 */

test.describe.configure({ mode: 'serial' });

/** A name unique enough to type into the rotate confirmation without ambiguity. */
const APP_NAME = 'Portal Write Surface Demo';
const REDIRECT_URI = 'https://portal-write-surface.example/callback';

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.locator('#email').fill('dev@ship.local');
  await page.locator('#password').fill('admin123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL('/login');
}

/**
 * Everything the persisted TanStack cache holds, as one string.
 *
 * `web/src/lib/queryClient.ts` persists to IndexedDB via
 * `createStore('ship-query-cache','queries')` under the key `tanstack-query`,
 * and that store survives reload and logout. PF-667's assertion is that a raw
 * secret never appears in it — read out of the real database rather than
 * reasoned about from the hook's source.
 */
async function persistedCacheText(page: Page): Promise<string> {
  return page.evaluate(async () => {
    return await new Promise<string>((resolve) => {
      const open = indexedDB.open('ship-query-cache');
      open.onerror = () => resolve('');
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('queries')) {
          resolve('');
          return;
        }
        const tx = db.transaction('queries', 'readonly');
        const req = tx.objectStore('queries').getAll();
        req.onerror = () => resolve('');
        req.onsuccess = () => {
          try {
            resolve(JSON.stringify(req.result));
          } catch {
            // A structured-clone value that will not stringify cannot hold a
            // string secret in a form the app could read back either.
            resolve('');
          }
        };
      };
    });
  });
}

test.describe('L22 S2 — register an app and handle its shown-once secret', () => {
  /**
   * Captured in the first test and used by the ones after it. The file is
   * `serial` for exactly this reason: the secret exists for one moment and the
   * later assertions are about what happens to that same value.
   */
  let issuedSecret = '';
  let appId = '';

  test('PF-664 — the register form is generated from the scope registry', async ({ page }) => {
    await login(page);
    await page.goto('/portal');

    // The registry read the form depends on, asserted at the source: the
    // checkboxes must be exactly what the server serves, not a literal list.
    const registry = await page.request.get('/api/apps/registry');
    expect(registry.status()).toBe(200);
    const served = (await registry.json()).data.scopes as { scope: string }[];
    expect(served.length).toBeGreaterThan(0);

    await page.getByTestId('register-app-open').click();
    await expect(page.getByTestId('register-app-dialog')).toBeVisible();

    for (const { scope } of served) {
      await expect(
        page.getByTestId(`scope-${scope}`),
        `the form must offer every scope the registry serves — ${scope} is missing`
      ).toBeVisible();
    }
    // …and nothing beyond it.
    await expect(page.locator('[data-testid^="scope-"]')).toHaveCount(served.length);
  });

  test('PF-664 — server-side validation renders under the field it names', async ({ page }) => {
    await login(page);
    await page.goto('/portal');
    await page.getByTestId('register-app-open').click();

    await page.getByTestId('register-app-name').fill(APP_NAME);
    // http on a non-loopback host: rejected by `redirectUriProblem`, not by the
    // form. The form is allowed to send it — that is PF-664's requirement that
    // the server does the rejecting.
    await page.getByTestId('register-app-redirects').fill('http://not-loopback.example/cb');
    await page.getByTestId('scope-documents:read').check();
    await page.getByTestId('register-app-submit').click();

    await expect(page.getByTestId('field-error-redirects')).toContainText('https');
    // The dialog is still open, with the values intact — a validation failure
    // that cleared the form would cost the developer their work.
    await expect(page.getByTestId('register-app-name')).toHaveValue(APP_NAME);
  });

  test('PF-666 / PF-669 — the secret is masked, revealed deliberately, and never logged', async ({
    page,
  }) => {
    const consoleLines: string[] = [];
    page.on('console', (msg) => consoleLines.push(msg.text()));

    await login(page);
    await page.goto('/portal');
    await page.getByTestId('register-app-open').click();

    await page.getByTestId('register-app-name').fill(APP_NAME);
    await page.getByTestId('register-app-redirects').fill(REDIRECT_URI);
    await page.getByTestId('scope-documents:read').check();
    await page.getByTestId('scope-webhooks:manage').check();
    await page.getByTestId('register-app-submit').click();

    const dialog = page.getByTestId('secret-once-dialog');
    await expect(dialog).toBeVisible();

    // MASKED BY DEFAULT — asserted as an absence, because `display:none` would
    // still ship the characters to dev tools and to an a11y dump.
    await expect(page.getByTestId('secret-once-masked')).toBeVisible();
    await expect(page.getByTestId('secret-once-value')).toHaveCount(0);
    const maskedBody = await page.locator('body').textContent();
    expect(maskedBody).not.toMatch(/ship_secret_/);

    // REVEAL is a deliberate act.
    await page.getByTestId('secret-once-reveal').click();
    issuedSecret = (await page.getByTestId('secret-once-value').textContent())!.trim();
    expect(issuedSecret).toMatch(/^ship_secret_/);

    // …and Hide takes it back out of the document entirely.
    await page.getByTestId('secret-once-reveal').click();
    await expect(page.getByTestId('secret-once-value')).toHaveCount(0);
    expect(await page.locator('body').textContent()).not.toContain(issuedSecret);

    // PF-667 — the persisted query cache must not hold it. Read out of the real
    // IndexedDB store, not inferred from which hook was used.
    expect(
      await persistedCacheText(page),
      'the raw client_secret reached the IndexedDB-persisted TanStack cache, which ' +
        'survives reload and logout'
    ).not.toContain(issuedSecret);

    // PF-669 — p.15's third vector. The whole flow, not just the happy path.
    const logged = consoleLines.filter((l) => l.includes(issuedSecret));
    expect(logged, `the browser console carried the raw secret: ${logged.join(' | ')}`).toEqual([]);

    // Dismiss is gated on the acknowledgement: "never recoverable" is a fact the
    // developer is told BEFORE losing the value.
    await expect(page.getByTestId('secret-once-dismiss')).toBeDisabled();
    await page.getByTestId('secret-once-ack').check();
    await page.getByTestId('secret-once-dismiss').click();
    await expect(dialog).toHaveCount(0);

    // The app is now in the sidebar, which is the only place it appears.
    await expect(page.getByRole('link', { name: new RegExp(APP_NAME) })).toBeVisible();
  });

  test('PF-668 — Back and reload cannot bring the secret back', async ({ page }) => {
    expect(issuedSecret, 'the previous test must have captured a secret').toMatch(
      /^ship_secret_/
    );

    await login(page);
    await page.goto('/portal');
    const appLink = page.getByRole('link', { name: new RegExp(APP_NAME) });
    await appLink.click();
    await expect(page).toHaveURL(/\/portal\/[0-9a-f-]{36}/);
    appId = page.url().split('/portal/')[1]!.split('?')[0]!;

    // Away, and back. The shown-once display was a modal over the app list with
    // no route and no history entry of its own, so there is nothing to return
    // to — Back leaves the portal instead.
    await page.goto('/documents');
    await page.goBack();
    await expect(page.locator('body')).not.toContainText(issuedSecret);
    await expect(page.getByTestId('secret-once-dialog')).toHaveCount(0);

    // And after a full reload, which is where a URL- or history-carried value
    // would survive.
    await page.reload();
    await expect(page.locator('body')).not.toContainText(issuedSecret);
    expect(page.url()).not.toContain(issuedSecret);

    // The screen says the value is gone and names the only recovery, rather
    // than leaving the developer to discover it (p.2's "never recoverable"
    // stated, not implied).
    await page.getByTestId('app-record-toggle').click();
    await expect(page.getByTestId('app-record-secret-prefix')).toContainText(/rotate/i);
  });

  test('PF-663 — the app record carries client_id, scopes, redirect URIs and created-at', async ({
    page,
  }) => {
    await login(page);
    await page.goto(`/portal/${appId}`);
    await page.getByTestId('app-record-toggle').click();

    await expect(page.getByTestId('app-record-client-id')).toContainText('ship_app_');
    await expect(page.getByTestId('app-record-scopes')).toContainText('documents:read');
    await expect(page.getByTestId('app-record-scopes')).toContainText('webhooks:manage');
    // The scope's description comes from `ScopeRegistry` — the same source
    // PF-070's 403 body reads, so it is written once.
    await expect(page.getByTestId('app-record-scopes')).toContainText('Read documents');
    await expect(page.getByTestId('app-record-redirects')).toContainText(REDIRECT_URI);
    await expect(page.getByTestId('app-record-created')).not.toBeEmpty();

    // The panel is structurally incapable of showing the secret: the read
    // projection has no slot for one.
    await expect(page.locator('body')).not.toContainText(issuedSecret);
  });

  test('PF-670 — rotation needs the app name typed, and issues a different secret', async ({
    page,
  }) => {
    const consoleLines: string[] = [];
    page.on('console', (msg) => consoleLines.push(msg.text()));

    await login(page);
    await page.goto(`/portal/${appId}`);

    await page.getByTestId('rotate-secret-open').click();
    const confirm = page.getByTestId('rotate-confirm');
    await expect(confirm).toBeDisabled();

    // A near-miss must not pass — the point of typing it is that a mis-click
    // cannot break every live integration.
    await page.getByTestId('rotate-confirm-input').fill(APP_NAME.toLowerCase());
    await expect(confirm).toBeDisabled();

    await page.getByTestId('rotate-confirm-input').fill(APP_NAME);
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(page.getByTestId('secret-once-dialog')).toBeVisible();
    await expect(page.getByTestId('secret-once-masked')).toBeVisible();
    await page.getByTestId('secret-once-reveal').click();
    const rotatedSecret = (await page.getByTestId('secret-once-value').textContent())!.trim();

    expect(rotatedSecret).toMatch(/^ship_secret_/);
    expect(rotatedSecret).not.toBe(issuedSecret);

    // PF-670's copy is DATA: the notice states D3's shipped model, which the
    // server reported as `rotation_policy` rather than this screen assuming it.
    await expect(page.getByTestId('rotation-policy-notice')).toContainText(/immediately/i);

    // PF-669 again, on the rotate path — the ticket names create AND rotate.
    expect(consoleLines.filter((l) => l.includes(rotatedSecret))).toEqual([]);
    expect(await persistedCacheText(page)).not.toContain(rotatedSecret);

    await page.getByTestId('secret-once-ack').check();
    await page.getByTestId('secret-once-dismiss').click();

    // The record now shows a bumped version, and still no secret.
    await page.getByTestId('app-record-toggle').click();
    await expect(page.getByTestId('app-record-secret-prefix')).toContainText('version 2');
    await expect(page.locator('body')).not.toContainText(rotatedSecret);
  });
});
