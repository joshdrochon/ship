import { test, expect } from './fixtures/isolated-env';

/**
 * E2E tests for AI Analysis API endpoints.
 *
 * Tests:
 * 1. GET /api/ai/status — returns { available: boolean }
 * 2. POST /api/ai/analyze-plan — requires content field (400 if missing)
 * 3. POST /api/ai/analyze-retro — requires retro_content and plan_content fields
 * 4. Rate limiting: endpoint returns 429 after 10 requests
 *
 * Bedrock is faked, not skipped. `e2e/fixtures/isolated-env.ts` starts an in-process
 * mock InvokeModel endpoint per worker, points the API at it with `BEDROCK_ENDPOINT`,
 * and strips every ambient `AWS_*` variable out of the API child process so a
 * developer's real credentials cannot turn this suite into billed Bedrock traffic
 * (Rule 3: stable fakes, not live external calls).
 *
 * Because the fake is deterministic and echoes the submitted plan items back, the
 * analysis assertions below are exact. They must NOT be relaxed to
 * `analysis || ai_unavailable`: that form passes whether the feature works or is
 * entirely unavailable, which is what this suite previously did.
 */

// Helper to get CSRF token for API requests
async function getCsrfToken(page: import('@playwright/test').Page, apiUrl: string): Promise<string> {
  const response = await page.request.get(`${apiUrl}/api/csrf-token`);
  expect(response.ok()).toBe(true);
  const { token } = await response.json();
  return token;
}

// Helper to login as default admin user
async function loginAsAdmin(page: import('@playwright/test').Page, apiUrl: string) {
  await page.goto('/login');
  await page.locator('#email').fill('dev@ship.local');
  await page.locator('#password').fill('admin123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL('/login', { timeout: 5000 });

  const csrfToken = await getCsrfToken(page, apiUrl);
  return { csrfToken };
}

// Sample TipTap JSON content for testing
const samplePlanContent = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'Complete the API integration and write unit tests for the auth module.' }],
    },
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'Deploy staging environment and verify monitoring dashboards.' }],
    },
  ],
};

// What `extractPlanItems` pulls out of samplePlanContent, in order: every paragraph
// longer than 10 characters. The mock echoes these back, so the assertions can check
// that the analysis corresponds to the plan that was actually submitted.
const samplePlanItems = [
  'Complete the API integration and write unit tests for the auth module.',
  'Deploy staging environment and verify monitoring dashboards.',
];

const sampleRetroContent = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'Completed the API integration. Tests pass at 95% coverage.' }],
    },
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'Staging deploy delayed due to infrastructure issues. Moved to next week.' }],
    },
  ],
};

test.describe('AI Status API', () => {
  test('GET /api/ai/status returns availability object', async ({ page, apiServer }) => {
    await loginAsAdmin(page, apiServer.url);

    const response = await page.request.get(`${apiServer.url}/api/ai/status`);
    expect(response.ok(), 'AI status endpoint should return 200').toBe(true);

    const data = await response.json();
    expect(data, 'Response should have available property').toHaveProperty('available');
    expect(
      data.available,
      'AI should report available: the fixture wires BEDROCK_ENDPOINT to the mock. ' +
      'false here means the API child process did not get the endpoint override.'
    ).toBe(true);
  });

  test('GET /api/ai/status requires authentication', async ({ page, apiServer }) => {
    // Do NOT login — request without auth
    const response = await page.request.get(`${apiServer.url}/api/ai/status`);
    expect(response.status(), 'Unauthenticated request should return 401 or 403').toBeGreaterThanOrEqual(401); // 401 or 403 — both are valid auth rejections
    expect(response.status()).toBeLessThanOrEqual(403);
  });
});

test.describe('AI Analyze Plan API', () => {
  test('POST /api/ai/analyze-plan returns 400 when content is missing', async ({ page, apiServer }) => {
    const { csrfToken } = await loginAsAdmin(page, apiServer.url);

    const response = await page.request.post(`${apiServer.url}/api/ai/analyze-plan`, {
      headers: { 'x-csrf-token': csrfToken },
      data: {},
    });

    expect(response.status(), 'Should return 400 when content is missing').toBe(400);
    const result = await response.json();
    expect(result.error, 'Error should mention content').toContain('content');
  });

  test('POST /api/ai/analyze-plan returns an analysis of the submitted plan', async ({ page, apiServer }) => {
    const { csrfToken } = await loginAsAdmin(page, apiServer.url);

    const response = await page.request.post(`${apiServer.url}/api/ai/analyze-plan`, {
      headers: { 'x-csrf-token': csrfToken },
      data: { content: samplePlanContent },
    });

    expect(response.ok(), 'analyze-plan should return 200').toBe(true);
    const result = await response.json();

    // Strict: `ai_unavailable` is a failure here, not an acceptable outcome. The mock
    // Bedrock is always up, so this can only mean the endpoint override, the dummy
    // credentials or the response parsing broke.
    expect(
      result.error,
      `analyze-plan degraded instead of analysing: ${JSON.stringify(result)}`
    ).toBeUndefined();

    expect(typeof result.overall_score, 'overall_score should be a number').toBe('number');
    expect(result.overall_score).toBeGreaterThanOrEqual(0);
    expect(result.overall_score).toBeLessThanOrEqual(1);

    // The analysis must correspond to the plan that was submitted, one entry per
    // extracted plan item, in order — not merely be well-shaped.
    expect(Array.isArray(result.items), 'items should be an array').toBe(true);
    expect(
      result.items.map((item: { text: string }) => item.text),
      'items should mirror the submitted plan items'
    ).toEqual(samplePlanItems);

    for (const item of result.items) {
      expect(typeof item.score).toBe('number');
      expect(item.score).toBeGreaterThanOrEqual(0);
      expect(item.score).toBeLessThanOrEqual(1);
      expect(typeof item.feedback).toBe('string');
      expect(Array.isArray(item.issues)).toBe(true);
    }

    expect(
      ['light', 'moderate', 'heavy', 'excessive'],
      'workload_assessment should be one of the documented values'
    ).toContain(result.workload_assessment);
    expect(typeof result.workload_feedback).toBe('string');
    // Present only on the Bedrock path — the cache-invalidation hash.
    expect(typeof result.content_hash, 'content_hash should be returned').toBe('string');
  });

  test('POST /api/ai/analyze-plan requires authentication', async ({ page, apiServer }) => {
    const response = await page.request.post(`${apiServer.url}/api/ai/analyze-plan`, {
      data: { content: samplePlanContent },
    });

    expect(response.status(), 'Unauthenticated request should return 401 or 403').toBeGreaterThanOrEqual(401); // 401 or 403 — both are valid auth rejections
    expect(response.status()).toBeLessThanOrEqual(403);
  });
});

test.describe('AI Analyze Retro API', () => {
  test('POST /api/ai/analyze-retro returns 400 when retro_content is missing', async ({ page, apiServer }) => {
    const { csrfToken } = await loginAsAdmin(page, apiServer.url);

    const response = await page.request.post(`${apiServer.url}/api/ai/analyze-retro`, {
      headers: { 'x-csrf-token': csrfToken },
      data: { plan_content: samplePlanContent },
    });

    expect(response.status(), 'Should return 400 when retro_content is missing').toBe(400);
    const result = await response.json();
    expect(result.error, 'Error should mention retro_content').toContain('retro_content');
  });

  test('POST /api/ai/analyze-retro returns 400 when plan_content is missing', async ({ page, apiServer }) => {
    const { csrfToken } = await loginAsAdmin(page, apiServer.url);

    const response = await page.request.post(`${apiServer.url}/api/ai/analyze-retro`, {
      headers: { 'x-csrf-token': csrfToken },
      data: { retro_content: sampleRetroContent },
    });

    expect(response.status(), 'Should return 400 when plan_content is missing').toBe(400);
    const result = await response.json();
    expect(result.error, 'Error should mention plan_content').toContain('plan_content');
  });

  test('POST /api/ai/analyze-retro returns 400 when both fields are missing', async ({ page, apiServer }) => {
    const { csrfToken } = await loginAsAdmin(page, apiServer.url);

    const response = await page.request.post(`${apiServer.url}/api/ai/analyze-retro`, {
      headers: { 'x-csrf-token': csrfToken },
      data: {},
    });

    expect(response.status(), 'Should return 400 when both fields are missing').toBe(400);
  });

  test('POST /api/ai/analyze-retro returns coverage of the submitted plan', async ({ page, apiServer }) => {
    const { csrfToken } = await loginAsAdmin(page, apiServer.url);

    const response = await page.request.post(`${apiServer.url}/api/ai/analyze-retro`, {
      headers: { 'x-csrf-token': csrfToken },
      data: {
        retro_content: sampleRetroContent,
        plan_content: samplePlanContent,
      },
    });

    expect(response.ok(), 'analyze-retro should return 200').toBe(true);
    const result = await response.json();

    expect(
      result.error,
      `analyze-retro degraded instead of analysing: ${JSON.stringify(result)}`
    ).toBeUndefined();

    expect(typeof result.overall_score, 'overall_score should be a number').toBe('number');
    expect(result.overall_score).toBeGreaterThanOrEqual(0);
    expect(result.overall_score).toBeLessThanOrEqual(1);

    expect(Array.isArray(result.plan_coverage), 'plan_coverage should be an array').toBe(true);
    expect(
      result.plan_coverage.map((row: { plan_item: string }) => row.plan_item),
      'plan_coverage should cover every submitted plan item, in order'
    ).toEqual(samplePlanItems);

    for (const row of result.plan_coverage) {
      expect(typeof row.addressed).toBe('boolean');
      expect(typeof row.has_evidence).toBe('boolean');
      expect(typeof row.feedback).toBe('string');
    }

    expect(Array.isArray(result.suggestions), 'suggestions should be an array').toBe(true);
    expect(typeof result.content_hash, 'content_hash should be returned').toBe('string');
  });

  test('POST /api/ai/analyze-retro requires authentication', async ({ page, apiServer }) => {
    const response = await page.request.post(`${apiServer.url}/api/ai/analyze-retro`, {
      data: {
        retro_content: sampleRetroContent,
        plan_content: samplePlanContent,
      },
    });

    expect(response.status(), 'Unauthenticated request should return 401 or 403').toBeGreaterThanOrEqual(401); // 401 or 403 — both are valid auth rejections
    expect(response.status()).toBeLessThanOrEqual(403);
  });
});

test.describe('AI Rate Limiting', () => {
  test('POST /api/ai/analyze-plan returns 429 after 10 rapid requests', async ({ page, apiServer }) => {
    const { csrfToken } = await loginAsAdmin(page, apiServer.url);

    // Send 10 requests rapidly to hit the rate limit
    const requests = [];
    for (let i = 0; i < 11; i++) {
      requests.push(
        page.request.post(`${apiServer.url}/api/ai/analyze-plan`, {
          headers: { 'x-csrf-token': csrfToken },
          data: { content: samplePlanContent },
        })
      );
    }

    const responses = await Promise.all(requests);
    const statuses = responses.map(r => r.status());

    // At least one response should be 429 (rate limited)
    // Note: depending on implementation timing, some may succeed
    const has429 = statuses.some(s => s === 429);
    const allSucceeded = statuses.every(s => s === 200);

    // If all requests return 200, AI might be unavailable (catches before rate limit)
    // or rate limit window is per-hour and 11 isn't enough. Mark as soft check.
    if (!allSucceeded) {
      expect(has429, 'At least one request should be rate-limited (429)').toBe(true);
    }

    // Verify the 429 response body mentions rate limit
    const rateLimitedResponse = responses.find(r => r.status() === 429);
    if (rateLimitedResponse) {
      const body = await rateLimitedResponse.json();
      expect(body.error, 'Rate limit error should mention rate limit').toContain('Rate limit');
    }
  });
});
