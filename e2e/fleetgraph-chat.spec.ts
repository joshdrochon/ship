/**
 * FG-239 · The on-demand test: a user invokes the agent from a context-aware view and
 * gets a grounded response.
 *
 * ── Status: both tests are `test.fixme()`, and this is not a stub ───────────────
 * They are written against the behaviour the system is meant to have, and they fail
 * today for exactly one reason:
 *
 *   `api/src/routes/fleetgraph/agentBridge.ts#invokeAgentChat` throws
 *   `AgentUnavailableError('agent_not_wired')`, so `POST /api/fleetgraph/chat`
 *   answers 503 `{ error: 'ai_unavailable', reason: 'agent_not_wired' }`.
 *
 * That seam is deliberate — its header explains that importing `agent/` from `api/`
 * would make the API's build depend on the agent's, so the route was finished against
 * a stable signature while the graph was built in parallel. The graph now exists
 * (`agent/src/graph/`, on-demand path: `resolve_scope -> on_demand_fetch_* ->
 * compose_answer -> END`). What is missing is the function body.
 *
 * ── What unblocks them ─────────────────────────────────────────────────────────
 * Replace the body of `invokeAgentChat` so it invokes the compiled graph with
 * `{ mode: 'on_demand', scope: { workspaceId, documentId, documentType, tab }, messages:
 * [{ role: 'user', content: message }] }` and returns `{ answer, threadId }`. Then
 * delete the two `.fixme` markers below. Nothing else in this file should need to
 * change — that is what makes them worth writing now.
 *
 * ── What is deliberately NOT done here ─────────────────────────────────────────
 * The assertions are not weakened to accept the 503. `expect(res.status()).toBe(503)`
 * would pass today, keep passing after the graph is wired and the chat is broken, and
 * pass again if someone deletes the whole feature. An assertion that accepts a
 * degraded result is worse than no test — the same mistake this suite made for real
 * when `e2e/ai-analysis-api.spec.ts` accepted `ai_unavailable` as a pass while making
 * billed Bedrock calls (see `e2e/fixtures/mock-bedrock.ts`).
 *
 * ── The limit of "grounded" against a fake model ───────────────────────────────
 * `mock-bedrock.ts` derives its JUDGEMENT response from the request, so the proactive
 * test can assert that a finding round-trips. Its prose branch — the one
 * `compose_answer` hits, since the answer prompt carries no `toolConfig` — is canned.
 * So these tests prove the chain rather than the content: the question reached the
 * graph, the graph called the model (the fake, exactly once, never the live provider),
 * and the model's words came back to the user under a thread id. Asserting that the
 * answer QUOTES the document's measured state needs the mock's prose branch to echo
 * the rendered prompt the way its judge branch already echoes fingerprints. That is a
 * change to `mock-bedrock.ts` worth making at the same time as wiring the seam, when
 * it can actually be run.
 */
import { test, expect, type Page } from './fixtures/isolated-env';

async function login(page: Page) {
  await page.goto('/login');
  await page.locator('#email').fill('dev@ship.local');
  await page.locator('#password').fill('admin123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL('/login', { timeout: 10_000 });
}

/**
 * An issue from the base seed, with its id.
 *
 * Read from the API rather than hard-coded: ids are generated per worker, and a
 * fixture that pinned one would break the moment the seed order changed.
 */
async function firstIssue(page: Page, apiUrl: string): Promise<{ id: string; title: string }> {
  const res = await page.request.get(`${apiUrl}/api/issues`);
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  const issues = Array.isArray(body) ? body : (body.issues ?? []);
  expect(
    issues.length,
    'The base seed should provide issues to chat about. Run the fixture in ' +
      'e2e/fixtures/isolated-env.ts (seedMinimalTestData) — it creates 24 for Ship Core alone.'
  ).toBeGreaterThan(2);
  return { id: issues[0].id as string, title: issues[0].title as string };
}

test.describe('FleetGraph · on-demand chat (FG-239)', () => {
  /**
   * The transport contract, at the level the UI uses it.
   *
   * Two things are asserted that a passing 503 could never show: an answer comes back
   * with a thread id (a graph run happened and can be continued), and the model call
   * went to the in-process fake exactly once (FG-241 — never the live provider, and
   * never zero times, which is what a route answering from a canned string would do).
   */
  test.fixme(
    'a question about the document in view returns a grounded answer',
    async ({ page, apiServer, bedrockMock }) => {
      await login(page);
      const issue = await firstIssue(page, apiServer.url);

      const csrf = await page.request
        .get(`${apiServer.url}/api/csrf-token`)
        .then((r) => r.json())
        .then((j) => j.token as string);

      const before = bedrockMock.converseInvocations();

      const res = await page.request.post(`${apiServer.url}/api/fleetgraph/chat`, {
        headers: { 'x-csrf-token': csrf },
        // FG-144 / Q7 · route parameters only. The server schema is `.strict()`, so
        // adding `content` here would be a 400 — the privacy boundary is enforced by
        // the schema, not by this comment.
        data: {
          document_id: issue.id,
          document_type: 'issue',
          tab: null,
          message: 'Why has this issue not moved?',
        },
      });

      expect(
        res.status(),
        `chat should answer 200. A 503 here means agentBridge.ts is still the unwired ` +
          `seam — see this file's header. Body: ${await res.text()}`
      ).toBe(200);

      const body = await res.json();
      expect(body.documentId).toBe(issue.id);
      expect(
        String(body.answer ?? '').length,
        'an empty answer is a failed run wearing a success status'
      ).toBeGreaterThan(0);
      expect(
        body.threadId,
        'a thread id proves a checkpointed graph run happened and can be continued'
      ).toBeTruthy();
      expect(
        String(body.answer),
        'the answer must have come back from the model call, not from a string the route ' +
          'built itself — the E2E fake marks its prose so the two can be told apart'
      ).toContain('MOCK ANSWER from mock-bedrock');
      expect(
        bedrockMock.converseInvocations() - before,
        'exactly one Converse call, to the loopback fake (FG-241)'
      ).toBe(1);
    }
  );

  /**
   * The same thing through the surface a user actually touches.
   *
   * The chat lives in the 256px properties sidebar of the document view — no fifth
   * panel, no standalone chatbot route (FG-174, and the brief's explicit constraint).
   * Clicking a suggested prompt is the cheapest real invocation: it is a click a user
   * makes, and it exercises the same `send()` path as typing.
   */
  test.fixme(
    'invoking chat from the document view shows the answer and no unavailable notice',
    async ({ page, apiServer }) => {
      await login(page);
      const issue = await firstIssue(page, apiServer.url);

      await page.goto(`/documents/${issue.id}`);

      const chat = page.getByTestId('agent-chat');
      await expect(chat).toBeVisible({ timeout: 15_000 });

      // The empty state names what this document type can be asked about (FG-166),
      // and its buttons are real invocations.
      await expect(page.getByTestId('agent-chat-empty')).toBeVisible();
      await page.getByRole('button', { name: 'Why has this issue not moved?' }).click();

      await expect(page.getByTestId('agent-chat-user-turn')).toHaveText(
        'Why has this issue not moved?'
      );

      const answer = page.getByTestId('agent-chat-agent-turn');
      await expect(answer).toBeVisible({ timeout: 30_000 });
      await expect(answer).toContainText('MOCK ANSWER from mock-bedrock');

      // The composer stays usable, and nothing renders the "switched off" state. Both
      // halves matter: FG-167 requires a 503 to read as plainly off, so its ABSENCE is
      // the assertion that the agent answered rather than degraded.
      await expect(page.getByTestId('agent-chat-unavailable')).toHaveCount(0);
      await expect(page.getByTestId('agent-chat-thread')).toBeVisible();
      await expect(page.getByPlaceholder('Ask about this document…')).toBeEnabled();
    }
  );
});
