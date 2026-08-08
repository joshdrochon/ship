import { test, expect } from './fixtures/isolated-env';

/**
 * E2E tests for Project Weeks tab feature.
 *
 * Tests the complete flow:
 * 1. Create allocation (person assigned to project for a week)
 * 2. Navigate to project's Weeks tab and verify allocation appears
 * 3. Click a cell to open weekly plan document
 * 4. Verify Properties sidebar shows correct context (project and person names)
 * 5. Verify navigation back to project works
 */

// Helper to get CSRF token for API requests
async function getCsrfToken(page: import('@playwright/test').Page, apiUrl: string): Promise<string> {
  const response = await page.request.get(`${apiUrl}/api/csrf-token`);
  expect(response.ok()).toBe(true);
  const { token } = await response.json();
  return token;
}

// Helper to login and get user context
async function loginAndGetContext(page: import('@playwright/test').Page, apiUrl: string) {
  await page.goto('/login');
  await page.locator('#email').fill('dev@ship.local');
  await page.locator('#password').fill('admin123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL('/login', { timeout: 5000 });

  const csrfToken = await getCsrfToken(page, apiUrl);

  const meResponse = await page.request.get(`${apiUrl}/api/auth/me`);
  expect(meResponse.ok()).toBe(true);
  const meData = await meResponse.json();
  const userId = meData.data.user.id;

  return { csrfToken, userId };
}

// Helper to get person document ID for the current user
async function getPersonIdForUser(
  page: import('@playwright/test').Page,
  apiUrl: string,
  userId: string
): Promise<string> {
  const response = await page.request.get(`${apiUrl}/api/documents?document_type=person`);
  expect(response.ok()).toBe(true);
  const docs = await response.json();
  const person = docs.find(
    (d: { properties?: { user_id?: string } }) => d.properties?.user_id === userId
  );
  expect(person, 'User should have an associated person document').toBeTruthy();
  return person.id;
}

// Helper to create a project for testing
async function createTestProject(
  page: import('@playwright/test').Page,
  apiUrl: string,
  csrfToken: string,
  title: string
): Promise<string> {
  const response = await page.request.post(`${apiUrl}/api/documents`, {
    headers: { 'x-csrf-token': csrfToken },
    data: {
      title,
      document_type: 'project',
    },
  });
  expect(response.ok()).toBe(true);
  const project = await response.json();
  return project.id;
}

// Helper to create a sprint with allocation
async function createAllocation(
  page: import('@playwright/test').Page,
  apiUrl: string,
  csrfToken: string,
  projectId: string,
  personId: string,
  weekNumber: number
): Promise<string> {
  // Create a sprint document with the person allocated to this project
  const response = await page.request.post(`${apiUrl}/api/documents`, {
    headers: { 'x-csrf-token': csrfToken },
    data: {
      title: `Week ${weekNumber}`,
      document_type: 'sprint',
      properties: {
        sprint_number: weekNumber,
        project_id: projectId,
        assignee_ids: [personId],
        status: 'active',
      },
    },
  });
  expect(response.ok()).toBe(true);
  const sprint = await response.json();
  return sprint.id;
}

test.describe('Project Weeks Tab', () => {
  test('shows allocated team members in the grid', async ({ page, apiServer }) => {
    const { csrfToken, userId } = await loginAndGetContext(page, apiServer.url);
    const personId = await getPersonIdForUser(page, apiServer.url, userId);

    // Create a test project
    const projectId = await createTestProject(
      page,
      apiServer.url,
      csrfToken,
      'E2E Test Project'
    );

    // Create allocations for weeks 10 and 11
    await createAllocation(page, apiServer.url, csrfToken, projectId, personId, 10);
    await createAllocation(page, apiServer.url, csrfToken, projectId, personId, 11);

    // Navigate to project's Weeks tab
    await page.goto(`/documents/${projectId}/weeks`);

    // Wait for the grid to load
    await expect(page.locator('text=Team Member')).toBeVisible({ timeout: 10000 });

    // Verify the person appears in the grid (Dev User from seed data)
    await expect(page.locator('text=Dev User')).toBeVisible();

    // Verify we see colored status cells (not dash for unallocated)
    const statusCells = page.locator('button[title*="Weekly Plan"]');
    await expect(statusCells.first()).toBeVisible();
  });

  test('clicking cell opens weekly plan document with context', async ({ page, apiServer }) => {
    const { csrfToken, userId } = await loginAndGetContext(page, apiServer.url);
    const personId = await getPersonIdForUser(page, apiServer.url, userId);

    // Create a test project
    const projectId = await createTestProject(
      page,
      apiServer.url,
      csrfToken,
      'Click Test Project'
    );

    // Create allocation for week 10
    await createAllocation(page, apiServer.url, csrfToken, projectId, personId, 10);

    // Navigate to project's Weeks tab
    await page.goto(`/documents/${projectId}/weeks`);

    // Wait for grid to load
    await expect(page.locator('text=Team Member')).toBeVisible({ timeout: 10000 });

    // Click on the plan status cell (left half of the colored cell)
    const planCell = page.locator('button[title*="Weekly Plan"]').first();
    await expect(planCell).toBeVisible();
    await planCell.click();

    // Wait for navigation to weekly plan document
    await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+$/, { timeout: 10000 });

    // Verify we're on a weekly plan document.
    //
    // The heading, not a substring match. `text=Weekly Plan` matched any element whose
    // text contained that phrase, and FleetGraph's chat panel put a second one on the
    // page — "Grounded in this weekly plan. Try:" — which turned this into a strict-mode
    // violation the moment the panel mounted. The assertion was always meant to be about
    // the document's heading; the loose selector just had not been contradicted yet.
    await expect(page.getByRole('heading', { name: 'Weekly Plan' })).toBeVisible();

    // Verify Properties sidebar shows person name (not UUID)
    // The label is just "Person" (without colon), rendered by WeeklyDocumentSidebar
    await expect(page.getByText('Person', { exact: true })).toBeVisible();
    // Use exact match to avoid matching title which includes "- Dev User"
    await expect(page.getByText('Dev User', { exact: true })).toBeVisible();

    // Verify Properties sidebar shows project name as a link
    // Label is "Project" (without colon)
    await expect(page.getByText('Project', { exact: true })).toBeVisible();
    await expect(page.locator('a:has-text("Click Test Project")')).toBeVisible();
  });

  test('project link in Properties sidebar navigates back to project', async ({ page, apiServer }) => {
    const { csrfToken, userId } = await loginAndGetContext(page, apiServer.url);
    const personId = await getPersonIdForUser(page, apiServer.url, userId);

    // Create a test project
    const projectId = await createTestProject(
      page,
      apiServer.url,
      csrfToken,
      'Navigation Test Project'
    );

    // Week 12, not 10, and the number is load-bearing.
    //
    // A weekly plan document is unique by PERSON + WEEK — `weekly-plans.ts:219`,
    // where `project_id` is explicitly "a legacy field, not used for uniqueness".
    // Three tests in this file allocated Dev User to week 10 (lines 117, 147 and
    // this one), so whichever of them clicked a cell first created the one
    // week-10 document and the others silently reused it, carrying the FIRST
    // test's project association.
    //
    // That is what broke this test in CI. It asserts a Properties-sidebar link
    // to its own project; it was handed the document created under "Click Test
    // Project" and the link pointed there instead. The failure artifact shows it
    // exactly: zero occurrences of "Navigation Test Project", five of "Click
    // Test Project", including the sidebar link.
    //
    // Week 12 is unused by every other test here (10, 11, 15, 20, 21, 22 are
    // taken), so this test gets its own document and its own project.
    //
    // Deliberately NOT fixed by changing the uniqueness rule. Person+week is
    // Ship's accountability model — `docs/week-documentation-philosophy.md:76`,
    // "a person can only own one week per week window (across all programs)" —
    // and this is a FleetGraph change, not a Ship product decision. The tests
    // were never meant to share a document; they collided by accident.
    //
    // Honest limit: this removes the collision, which is confirmed. It does not
    // explain why the old version was INTERMITTENT rather than always failing —
    // the sharing is deterministic and the retry passed. That is still unknown.
    await createAllocation(page, apiServer.url, csrfToken, projectId, personId, 12);

    // Navigate to project's Weeks tab and click to open weekly plan
    await page.goto(`/documents/${projectId}/weeks`);
    await expect(page.locator('text=Team Member')).toBeVisible({ timeout: 10000 });

    const planCell = page.locator('button[title*="Weekly Plan"]').first();
    await planCell.click();

    // Wait for weekly plan document. Heading, not substring — see line 164.
    await expect(page.getByRole('heading', { name: 'Weekly Plan' })).toBeVisible({
      timeout: 10000,
    });

    // Click the project link to navigate back
    // Scoped to the Properties sidebar, which is the panel this test is named for. An
    // unqualified `a:has-text(...)` matches the same project twice in the 4-panel layout
    // -- once in the contextual sidebar's projects list, once here -- so it passed only in
    // the window where exactly one of the two panels had painted: 0 matches read as
    // "element(s) not found", 2 as a strict mode violation. A retry made it worse rather
    // than better, because the second attempt renders both panels from a warm cache.
    // Located by href, not by accessible name. The name is not stable at this point:
    // PropertiesPanel.tsx:251 renders `weeklyReviewState?.projectName` and falls back to
    // `projectId.substring(0, 8) + '...'` until `projectDoc` has been fetched
    // (useWeeklyReviewActions.ts:167). So the link is present and clickable immediately,
    // carrying a truncated UUID as its label, and only becomes "Navigation Test Project"
    // once a separate request lands. Matching on the name therefore raced that request and
    // failed with `element(s) not found` -- three attempts in a row on a loaded CI runner,
    // where the fetch is slowest.
    //
    // The href is derived from `projectId` in the document's own properties, so it is
    // correct from first paint. This test is named for navigation; the href is the thing
    // navigation depends on, and the label is incidental to it.
    const projectLink = page
      .getByLabel('Document properties')
      .locator(`a[href="/documents/${projectId}/weeks"]`);
    await expect(projectLink).toBeVisible({ timeout: 10000 });
    await projectLink.click();

    // Verify we're back at the project's Weeks tab
    await expect(page).toHaveURL(new RegExp(`/documents/${projectId}/weeks`), { timeout: 10000 });
    await expect(page.locator('text=Team Member')).toBeVisible();
  });
});

test.describe('Project Allocation Grid API', () => {
  test('GET /project-allocation-grid returns allocated people', async ({ page, apiServer }) => {
    const { csrfToken, userId } = await loginAndGetContext(page, apiServer.url);
    const personId = await getPersonIdForUser(page, apiServer.url, userId);

    // Create project and allocation
    const projectId = await createTestProject(
      page,
      apiServer.url,
      csrfToken,
      'API Test Project'
    );
    await createAllocation(page, apiServer.url, csrfToken, projectId, personId, 15);

    // Query the allocation grid API
    const response = await page.request.get(
      `${apiServer.url}/api/weekly-plans/project-allocation-grid/${projectId}`
    );
    expect(response.ok()).toBe(true);

    const data = await response.json();
    expect(data.projectId).toBe(projectId);
    expect(data.people).toHaveLength(1);
    expect(data.people[0].id).toBe(personId);
    expect(data.people[0].name).toBe('Dev User');
    expect(data.people[0].weeks).toHaveProperty('15');
    expect(data.people[0].weeks[15].isAllocated).toBe(true);
  });

  test('allocation grid shows multiple weeks for same person', async ({ page, apiServer }) => {
    const { csrfToken, userId } = await loginAndGetContext(page, apiServer.url);
    const personId = await getPersonIdForUser(page, apiServer.url, userId);

    // Create project and allocations for multiple weeks
    const projectId = await createTestProject(
      page,
      apiServer.url,
      csrfToken,
      'Multi-Week Test'
    );
    await createAllocation(page, apiServer.url, csrfToken, projectId, personId, 20);
    await createAllocation(page, apiServer.url, csrfToken, projectId, personId, 21);
    await createAllocation(page, apiServer.url, csrfToken, projectId, personId, 22);

    // Query the allocation grid API
    const response = await page.request.get(
      `${apiServer.url}/api/weekly-plans/project-allocation-grid/${projectId}`
    );
    expect(response.ok()).toBe(true);

    const data = await response.json();
    expect(data.people[0].weeks).toHaveProperty('20');
    expect(data.people[0].weeks).toHaveProperty('21');
    expect(data.people[0].weeks).toHaveProperty('22');
    expect(data.people[0].weeks[20].isAllocated).toBe(true);
    expect(data.people[0].weeks[21].isAllocated).toBe(true);
    expect(data.people[0].weeks[22].isAllocated).toBe(true);
  });
});
