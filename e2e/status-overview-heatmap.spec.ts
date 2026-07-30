import { test, expect, Page } from './fixtures/isolated-env'

/**
 * A project and an allocation that belong to this spec alone.
 *
 * The split-cell test used to rely on the seeded allocation for Dev User in the current
 * week. That allocation is not stable: the Playwright database is worker-scoped
 * (e2e/fixtures/isolated-env.ts) and shared with every other spec on the worker, and
 * `accountability-grid-v3` builds its `assignments[person][week]` map from an
 * unordered query with last-write-wins (api/src/routes/team.ts:1725). Other specs create
 * a second sprint document for Dev User in the same week —
 * manager-reviews-visual.spec.ts:66 and request-changes-ui.spec.ts:68 both do, and both
 * attach the project through `belongs_to` rather than `properties.project_id`, so their
 * row carries a NULL project. Whenever that row won the race, Dev User's current-week
 * cell had no project, rendered as "-" with no buttons at all, and the split-cell
 * assertion found nothing.
 *
 * Allocating Bob Martinez (seeded, and allocated by no other spec) to a project only this
 * spec creates makes the row deterministic, and lets the assertion name the exact cell
 * instead of taking whichever `.first()` button happened to exist.
 */
const SPLIT_CELL_PROJECT = 'Heatmap Split Cell Project'
const SPLIT_CELL_PERSON = 'Bob Martinez'

async function getCsrfToken(page: Page, apiUrl: string): Promise<string> {
  const response = await page.request.get(`${apiUrl}/api/csrf-token`)
  expect(response.ok()).toBe(true)
  const { token } = await response.json()
  return token
}

/** Allocate a seeded person to a spec-owned project for the current week. */
async function createOwnedAllocation(page: Page, apiUrl: string): Promise<void> {
  const csrfToken = await getCsrfToken(page, apiUrl)

  const gridResponse = await page.request.get(`${apiUrl}/api/team/accountability-grid-v3`)
  expect(gridResponse.ok(), 'accountability-grid-v3 must be readable to set up this test').toBe(true)
  const { currentSprintNumber } = await gridResponse.json()

  const peopleResponse = await page.request.get(`${apiUrl}/api/documents?document_type=person`)
  expect(peopleResponse.ok()).toBe(true)
  const people: { id: string; title: string }[] = await peopleResponse.json()
  const person = people.find(p => p.title === SPLIT_CELL_PERSON)
  expect(
    person,
    `Seed data should provide the person "${SPLIT_CELL_PERSON}". See e2e/fixtures/isolated-env.ts.`
  ).toBeTruthy()

  const projectResponse = await page.request.post(`${apiUrl}/api/documents`, {
    headers: { 'x-csrf-token': csrfToken },
    data: { title: SPLIT_CELL_PROJECT, document_type: 'project' },
  })
  expect(projectResponse.ok()).toBe(true)
  const project = await projectResponse.json()

  // `properties.project_id` is what accountability-grid-v3 reads. Setting the project via
  // `belongs_to` instead is exactly the mistake that produced the NULL-project rows
  // described above.
  const sprintResponse = await page.request.post(`${apiUrl}/api/documents`, {
    headers: { 'x-csrf-token': csrfToken },
    data: {
      title: `Week ${currentSprintNumber}`,
      document_type: 'sprint',
      properties: {
        sprint_number: currentSprintNumber,
        project_id: project.id,
        assignee_ids: [person!.id],
        status: 'active',
      },
    },
  })
  expect(sprintResponse.ok()).toBe(true)
}

test.describe('Status Overview Heatmap', () => {
  test.beforeEach(async ({ page }) => {
    // Login before each test
    await page.goto('/login')
    await page.locator('#email').fill('dev@ship.local')
    await page.locator('#password').fill('admin123')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()

    // Wait for app to load
    await expect(page).not.toHaveURL('/login', { timeout: 5000 })
  })

  test('can navigate to Status Overview via Teams sidebar', async ({ page }) => {
    // Click Teams icon in rail
    await page.getByRole('button', { name: 'Teams' }).click()

    // Wait for Teams mode to load
    await expect(page).toHaveURL(/\/team\//, { timeout: 5000 })

    // Click Status Overview in sidebar
    await page.getByRole('button', { name: 'Status Overview' }).click()

    // Should navigate to /team/status
    await expect(page).toHaveURL(/\/team\/status/, { timeout: 5000 })
  })

  test('displays legend with status colors', async ({ page }) => {
    await page.goto('/team/status')
    await page.waitForLoadState('networkidle')

    // Should see status legend
    await expect(page.getByText('Status:')).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('Done')).toBeVisible()
    await expect(page.getByText('Due', { exact: true })).toBeVisible()
    await expect(page.getByText('Late')).toBeVisible()
    await expect(page.getByText('Future', { exact: true })).toBeVisible()

    // Should see cell layout explanation
    await expect(page.getByText('Left = Plan, Right = Retro')).toBeVisible()
  })

  test('displays programs with people directly underneath', async ({ page }) => {
    await page.goto('/team/status')
    await page.waitForLoadState('networkidle')

    // Wait for heatmap to load - new header is "Program / Person" (no project level)
    await expect(page.getByText('Program / Person')).toBeVisible({ timeout: 10000 })

    // Should see program headers - in isolated env without allocations, people go to "No Program"
    // The seed data or full database would show other programs
    const programButton = page.getByRole('button', { name: /No Program|API Platform|Infrastructure|Design System/ }).first()
    await expect(programButton).toBeVisible({ timeout: 5000 })
  })

  test('shows people directly under programs without expansion', async ({ page }) => {
    await page.goto('/team/status')
    await page.waitForLoadState('networkidle')

    // Wait for heatmap to load
    await expect(page.getByText('Program / Person')).toBeVisible({ timeout: 10000 })

    // People should be visible directly - no need to click to expand
    // Look for any person name from the seed data
    await expect(page.getByText(/Dev User|Alice Chen|Grace Lee|Carol Williams/).first()).toBeVisible({ timeout: 5000 })
  })

  /**
   * RISK MITIGATED: an allocated person's week must render as a split cell — a Weekly
   * Plan half and a Weekly Retro half, each a separately labelled, separately clickable
   * button. That split is the only way a manager can see and reach the two documents
   * independently; if StatusCell (web/src/components/StatusOverviewHeatmap.tsx:66) ever
   * regresses to a single button, a whole-cell link, or a status-less block, the grid
   * silently stops being navigable and this test fails.
   *
   * Both halves are addressed by their full accessible name, which carries the project,
   * so the test asserts that the cell for a known allocation is split — not merely that
   * some button somewhere on the page happens to mention a plan.
   */
  test('displays split cells for plan/retro status', async ({ page, apiServer }) => {
    await createOwnedAllocation(page, apiServer.url)

    await page.goto('/team/status')
    await page.waitForLoadState('networkidle')

    // Wait for heatmap to load
    await expect(page.getByText('Program / Person')).toBeVisible({ timeout: 10000 })

    // The allocated person is listed directly, without expanding anything
    await expect(page.getByText(SPLIT_CELL_PERSON).first()).toBeVisible({ timeout: 5000 })

    // The status word varies with the day of the week (calculateStatus in
    // api/src/routes/team.ts), so match on the shape of the label, not a fixed status.
    const planButton = page.getByRole('button', {
      name: new RegExp(`^Weekly Plan \\(.+\\) \\(${SPLIT_CELL_PROJECT}\\)$`),
    })
    await expect(planButton, 'the plan half of the split cell should render').toHaveCount(1)
    await expect(planButton).toBeVisible({ timeout: 5000 })

    const retroButton = page.getByRole('button', {
      name: new RegExp(`^Weekly Retro \\(.+\\) \\(${SPLIT_CELL_PROJECT}\\)$`),
    })
    await expect(retroButton, 'the retro half of the split cell should render').toHaveCount(1)
    await expect(retroButton).toBeVisible({ timeout: 5000 })
  })

  test('clicking plan cell navigates to weekly plan document', async ({ page }) => {
    await page.goto('/team/status')
    await page.waitForLoadState('networkidle')

    // Wait for heatmap to load
    await expect(page.getByText('Program / Person')).toBeVisible({ timeout: 10000 })

    // Wait for people to appear (visible directly, no expansion needed)
    await expect(page.getByText(/Dev User|Alice Chen|Grace Lee/).first()).toBeVisible({ timeout: 5000 })

    // Click a plan cell (any week)
    const planButton = page.getByRole('button', { name: /Weekly Plan/ }).first()
    await planButton.click()

    // Should navigate to a document page
    await expect(page).toHaveURL(/\/documents\//, { timeout: 10000 })

    // Should see Weekly Plan title
    await expect(page.getByRole('heading', { name: /Week \d+ Plan/ })).toBeVisible({ timeout: 5000 })
  })

  test('clicking retro cell navigates to weekly retro document', async ({ page }) => {
    await page.goto('/team/status')
    await page.waitForLoadState('networkidle')

    // Wait for heatmap to load
    await expect(page.getByText('Program / Person')).toBeVisible({ timeout: 10000 })

    // Wait for people to appear (visible directly, no expansion needed)
    await expect(page.getByText(/Dev User|Alice Chen|Grace Lee/).first()).toBeVisible({ timeout: 5000 })

    // Click a retro cell (any week)
    const retroButton = page.getByRole('button', { name: /Weekly Retro/ }).first()
    await retroButton.click()

    // Should navigate to a document page
    await expect(page).toHaveURL(/\/documents\//, { timeout: 10000 })

    // Should see Weekly Retro title
    await expect(page.getByRole('heading', { name: /Week \d+ Retro/ })).toBeVisible({ timeout: 5000 })
  })

  test('Show archived checkbox is present', async ({ page }) => {
    await page.goto('/team/status')
    await page.waitForLoadState('networkidle')

    // Should see Show archived checkbox
    await expect(page.getByRole('checkbox', { name: 'Show archived' })).toBeVisible({ timeout: 10000 })
  })

  test('displays week columns with dates', async ({ page }) => {
    await page.goto('/team/status')
    await page.waitForLoadState('networkidle')

    // Wait for heatmap to load
    await expect(page.getByText('Program / Person')).toBeVisible({ timeout: 10000 })

    // Should see week headers with format "Week N" and date range
    await expect(page.getByText(/Week \d+/).first()).toBeVisible({ timeout: 5000 })

    // Should see date ranges like "Jan 10-16" or "Dec 27 - Jan 2"
    await expect(page.getByText(/[A-Z][a-z]+ \d+/).first()).toBeVisible({ timeout: 5000 })
  })

  test('API returns accountability-grid-v3 data structure', async ({ page }) => {
    await page.goto('/team/status')

    // Intercept the API call - now using v3 endpoint
    const response = await page.waitForResponse(
      resp => resp.url().includes('/api/team/accountability-grid-v3') && resp.status() === 200,
      { timeout: 10000 }
    )

    const data = await response.json()

    // Verify data structure
    expect(data).toHaveProperty('programs')
    expect(data).toHaveProperty('weeks')
    expect(data).toHaveProperty('currentSprintNumber')

    // Verify programs array has expected structure (now contains people, not projects)
    expect(Array.isArray(data.programs)).toBe(true)
    expect(data.programs.length).toBeGreaterThan(0)
    expect(data.programs[0]).toHaveProperty('id')
    expect(data.programs[0]).toHaveProperty('name')
    expect(data.programs[0]).toHaveProperty('people') // Changed from 'projects' to 'people'

    // Verify weeks array has expected structure
    expect(Array.isArray(data.weeks)).toBe(true)
    expect(data.weeks.length).toBeGreaterThanOrEqual(3)
    expect(data.weeks[0]).toHaveProperty('number')
    expect(data.weeks[0]).toHaveProperty('name')
    expect(data.weeks[0]).toHaveProperty('startDate')
    expect(data.weeks[0]).toHaveProperty('endDate')
    expect(data.weeks[0]).toHaveProperty('isCurrent')

    // Verify at least one week is marked as current
    const currentWeeks = data.weeks.filter((w: { isCurrent: boolean }) => w.isCurrent)
    expect(currentWeeks.length).toBe(1)
  })

  test('non-admin users see appropriate content', async ({ page }) => {
    // This test requires a non-admin user to exist
    // The seed data creates dev@ship.local as super-admin
    // For now, we just verify the admin can access
    await page.goto('/team/status')

    // Admin should see the grid, not an error - using new header
    await expect(page.getByText('Program / Person')).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('Admin access required')).not.toBeVisible()
  })
})
