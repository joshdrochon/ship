/**
 * FG-238 · The timed proactive test.
 *
 * "Introduce an event into Ship, start the clock, assert the agent surfaces it inside
 * the window." That sentence is PRESEARCH.md Q30's own description of how the latency
 * budget gets verified, and this file is it. MVP requirement 6 sets the window at 5
 * minutes.
 *
 * ── What is actually exercised ──────────────────────────────────────────────────
 * The real cron entrypoint (`agent/src/entrypoints/cron.ts`), in its own process,
 * against the worker's real Postgres, driving the real graph — detectors, triage gate,
 * judgement, blast-radius routing, autonomous comment, delivery. Nothing is stubbed
 * except the two things that would otherwise leave the machine:
 *
 *   Bedrock    `BEDROCK_ENDPOINT` points at the in-process mock this worker already
 *              runs for the API (`e2e/fixtures/mock-bedrock.ts`, `/converse` handler).
 *   LangSmith  every LANGCHAIN_ and LANGSMITH_ variable is stripped from the child.
 *
 * Both go through `sandboxedChildEnv`, which is the same function that sandboxes the
 * API child process — see its header for the history (this suite used to make real,
 * billed Bedrock calls and could not tell).
 *
 * ── Why the assertions are shaped the way they are (FG-241, the trap) ───────────
 * Every failure mode of this system is QUIET. A broken agent does not throw; it
 * produces an empty notification list, or an `ai_unavailable` degradation, or a run
 * that reports `quiet_nothing_survived_judgment`. Note especially that
 * `agent/src/llm/judge.ts#makeJudge` flattens an unreachable provider to zero
 * findings, so a scan with NO model at all ends `quiet_nothing_survived_judgment` and
 * exits 0. "The workspace is healthy" and "the agent is dead" are the same log line
 * unless something distinguishes them.
 *
 * So every assertion below is two-sided:
 *
 *   the baseline scan must be quiet AND must have spent zero model calls
 *   the event scan must be `delivered` AND must have made exactly one Converse call
 *   the notification must exist AND must carry the mock judge's phrasing
 *   the run must exit 0 AND report no errors
 *
 * `expect(notifications.length).toBeGreaterThan(0)` on its own would pass against a
 * fixture that pre-loaded a row, which is why the scenario fixture deliberately leaves
 * the workspace quiet and the baseline scan proves it.
 *
 * ── FG-243 · one test, no cross-test state ─────────────────────────────────────
 * The E2E database resets per spec FILE, and `fullyParallel: true` can place two tests
 * from one file on two workers with two different databases. This file therefore holds
 * a single self-contained test: it seeds its own stage, proves the workspace quiet,
 * introduces the event, and scans. Nothing here depends on another test or another
 * file having run.
 */
import { spawn } from 'child_process';
import path from 'path';

import { test, expect, seedFleetGraphScenario, sandboxedChildEnv } from './fixtures/isolated-env';

const PROJECT_ROOT = path.resolve(__dirname, '..');

/**
 * MVP requirement 6. The whole point of the exercise.
 */
const LATENCY_SLA_MS = 5 * 60_000;

/**
 * What the work itself is allowed to cost, given the cadence it runs at.
 *
 * The SLA is measured from an event appearing in Ship, and in production the agent is
 * not watching — a Render cron fires every three minutes. So the budget decomposes
 * (PRESEARCH.md Q30):
 *
 *   180 s   worst-case wait for the next tick
 *    15 s   container cold start, measured on Render
 *   ─────
 *   105 s   everything this test can actually observe: detect, judge, act, deliver
 *
 * Asserting only `< 300 s` would pass a scan that took four minutes, which would
 * breach the SLA in production on every run that had to wait for a tick. This is the
 * assertion that makes the 5-minute claim hold at the cadence the agent really runs
 * at, so it is the one that fails first if the graph slows down.
 */
const CRON_INTERVAL_MS = 180_000;
const COLD_START_MS = 15_000;
const SCAN_BUDGET_MS = LATENCY_SLA_MS - CRON_INTERVAL_MS - COLD_START_MS;

/**
 * A hard ceiling on the child, so a wedged run fails as a timeout with output rather
 * than as Playwright killing the whole test with none. Requirement 4 ("never hang")
 * applies to the harness as much as to the agent.
 */
const SCAN_KILL_MS = 120_000;

/** One line of `logRun` output from `agent/src/entrypoints/cron.ts`. */
interface ScanLog {
  event: string;
  workspace: string;
  outcome: string | null;
  signals: number;
  findings: number;
  ms: number;
  errors?: string[];
}

interface ScanRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** The `fleetgraph.scan` line. Null means the run never logged one. */
  log: ScanLog | null;
}

/**
 * Run one proactive scan, exactly as Render would, scoped to one workspace.
 *
 * `FLEETGRAPH_WORKSPACE_ID` is the override `main()` reads to scan a single workspace
 * instead of sweeping all of them — it exists in the entrypoint for this test.
 *
 * Invoked through the package's own `agent:cron` script (tsx over `src/`) rather than a
 * build, because `agent/` is not built by `e2e/global-setup.ts` and adding a build step
 * there would slow every one of the other spec files down for one file's benefit. The
 * two compiled things the agent imports — `api/dist/services/circuitBreaker.js` and
 * `@ship/shared` — are both produced by the `pnpm build:api` that global setup already
 * runs.
 */
async function runScan(opts: {
  dbUrl: string;
  workspaceId: string;
  bedrockUrl: string;
  apiUrl: string;
  agentToken: string;
}): Promise<ScanRun> {
  const child = spawn('pnpm', ['--filter', '@ship/agent', 'agent:cron'], {
    cwd: PROJECT_ROOT,
    env: sandboxedChildEnv({
      NODE_ENV: 'test',
      DATABASE_URL: opts.dbUrl,
      // Scan this workspace only. Without it the run sweeps every workspace in the
      // database, which is correct in production and useless for a timed test.
      FLEETGRAPH_WORKSPACE_ID: opts.workspaceId,
      // Rule 3. The agent's judgement call goes to the same in-process fake the API
      // uses, over loopback. Set here rather than inherited so it cannot be lost.
      BEDROCK_ENDPOINT: opts.bedrockUrl,
      // Without these the cron substitutes `refuseToAct` and every autonomous comment
      // reports failure — a degraded run that still delivers its notification, which
      // is precisely the outcome this test must not silently accept.
      SHIP_API_URL: opts.apiUrl,
      SHIP_API_TOKEN: opts.agentToken,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const kill = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(
          `FleetGraph scan did not finish within ${SCAN_KILL_MS}ms.\n` +
            `stdout:\n${stdout}\nstderr:\n${stderr}`
        )
      );
    }, SCAN_KILL_MS);

    child.on('error', (err) => {
      clearTimeout(kill);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(kill);
      resolve(code);
    });
  });

  // The run logs one structured line per workspace (FG-114). Everything else on the
  // stream is pnpm's own noise, so parse rather than assume a position.
  let log: ScanLog | null = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as ScanLog;
      if (parsed.event === 'fleetgraph.scan') log = parsed;
    } catch {
      // Not a log line we care about.
    }
  }

  return { exitCode, stdout, stderr, log };
}

/** Everything the run printed, for an assertion message that can be acted on. */
function transcript(run: ScanRun): string {
  return `\n--- agent stdout ---\n${run.stdout}\n--- agent stderr ---\n${run.stderr}`;
}

test.describe('FleetGraph · proactive detection (FG-238)', () => {
  test('surfaces an event introduced into Ship inside the 5-minute latency window', async ({
    page,
    apiServer,
    dbContainer,
    bedrockMock,
  }) => {
    // Two agent processes, a browser login and an HTTP round trip. The default 60 s
    // budget is for a UI test; this one has a 105 s assertion inside it.
    test.setTimeout(4 * 60_000);

    const dbUrl = dbContainer.getConnectionUri();
    const scenario = await seedFleetGraphScenario(dbUrl);

    await page.goto('/login');
    await page.locator('#email').fill('dev@ship.local');
    await page.locator('#password').fill('admin123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).not.toHaveURL('/login', { timeout: 10_000 });

    const csrf = await page.request
      .get(`${apiServer.url}/api/csrf-token`)
      .then((r) => r.json())
      .then((j) => j.token as string);

    const notifications = async () => {
      const res = await page.request.get(`${apiServer.url}/api/fleetgraph/notifications`);
      expect(
        res.status(),
        'GET /api/fleetgraph/notifications should answer 200. A 500 here usually means ' +
          'the fleetgraph_* tables are missing from the worker database — see the ' +
          'MIGRATIONS_MISSING_FROM_SCHEMA_SQL note in e2e/fixtures/isolated-env.ts.'
      ).toBe(200);
      return (await res.json()).notifications as Array<Record<string, unknown>>;
    };

    // ── 1 · Baseline: the workspace is quiet, and being quiet costs nothing ──────
    //
    // This is what makes the rest of the test mean anything. It proves the fixture
    // did not pre-load the finding, and it proves the detectors are actually looking
    // (a scan that crashed would not report `quiet_no_signals`).
    expect(await notifications(), 'the seeded scenario must start with no findings').toEqual(
      []
    );

    const baseline = await runScan({
      dbUrl,
      workspaceId: scenario.workspaceId,
      bedrockUrl: bedrockMock.url,
      apiUrl: apiServer.url,
      agentToken: scenario.agentToken,
    });

    expect(baseline.exitCode, `baseline scan should exit 0${transcript(baseline)}`).toBe(0);
    expect(
      baseline.log,
      `baseline scan should log one fleetgraph.scan line${transcript(baseline)}`
    ).not.toBeNull();
    expect(
      baseline.log!.outcome,
      'a healthy workspace must terminate at the triage gate — any other outcome means ' +
        'the fixture is triggering a detector it should not'
    ).toBe('quiet_no_signals');
    expect(baseline.log!.signals).toBe(0);
    expect(baseline.log!.errors ?? []).toEqual([]);
    expect(
      bedrockMock.converseInvocations(),
      'the quiet path must spend zero model calls (PRESEARCH.md Q17) — this is the ' +
        'entire cost argument for scanning every three minutes'
    ).toBe(0);

    // ── 2 · The event ───────────────────────────────────────────────────────────
    //
    // Unstarted work appears in a week that ends today. This is a real user action
    // through the real endpoint, not a row written behind the product's back, and it
    // is the moment the clock starts.
    const clockStart = Date.now();

    const created = await page.request.post(`${apiServer.url}/api/issues`, {
      headers: { 'x-csrf-token': csrf },
      data: {
        title: 'Ship the launch checklist',
        state: 'todo',
        priority: 'high',
        belongs_to: [{ id: scenario.weekId, type: 'sprint' }],
      },
    });
    expect(created.status(), await created.text()).toBe(201);

    // ── 3 · The agent scans ─────────────────────────────────────────────────────
    const scan = await runScan({
      dbUrl,
      workspaceId: scenario.workspaceId,
      bedrockUrl: bedrockMock.url,
      apiUrl: apiServer.url,
      agentToken: scenario.agentToken,
    });

    expect(scan.exitCode, `scan should exit 0${transcript(scan)}`).toBe(0);
    expect(scan.log, `scan should log one fleetgraph.scan line${transcript(scan)}`).not.toBeNull();
    expect(
      scan.log!.errors ?? [],
      `the run must complete with no degraded steps${transcript(scan)}`
    ).toEqual([]);
    expect(
      scan.log!.signals,
      'exactly one detector should fire: sprint_miss_risk on the week that ends today'
    ).toBe(1);
    expect(
      scan.log!.outcome,
      'the run must reach `delivered`. `quiet_nothing_survived_judgment` here does NOT ' +
        'mean the model declined — makeJudge flattens an unreachable provider to zero ' +
        'findings, so that outcome is what a dead Bedrock connection looks like' +
        transcript(scan)
    ).toBe('delivered');
    expect(scan.log!.findings).toBe(1);
    expect(
      bedrockMock.converseInvocations(),
      'judgement must have gone to the in-process fake exactly once — never to the live ' +
        'provider (FG-241), and never zero times'
    ).toBe(1);

    // ── 4 · Surfaced, to the one accountable person, through the UI's own endpoint ─
    const open = await notifications();
    const finding = open.find((n) => n.targetId === scenario.weekId);

    expect(
      finding,
      `the finding must reach the week owner. Open findings: ${JSON.stringify(open)}` +
        transcript(scan)
    ).toBeDefined();
    expect(finding!.signalType).toBe('sprint_miss_risk');
    expect(finding!.targetTitle).toBe(scenario.weekTitle);
    expect(
      String(finding!.body),
      'the body must carry the judged phrasing. A notification whose body did not come ' +
        'from the judgement step means the graph delivered an unjudged measurement.'
    ).toContain('MOCK JUDGEMENT from mock-bedrock');
    expect(
      String(finding!.title),
      'sprint_miss_risk is additive, so the proposal is a comment on the week'
    ).toContain(scenario.weekTitle);

    // ── 5 · The latency claim ───────────────────────────────────────────────────
    const elapsedMs = Date.now() - clockStart;

    // The number itself, in the run log and in the HTML report. PRESEARCH.md Q30 says
    // the verification of the latency budget is "a timed test run"; a pass/fail with no
    // measurement makes the margin invisible, so a slow drift toward the ceiling would
    // only be noticed on the run that finally breached it.
    // eslint-disable-next-line no-console
    console.log(
      `[FG-238] event -> surfaced in ${elapsedMs}ms ` +
        `(scan budget ${SCAN_BUDGET_MS}ms, SLA ${LATENCY_SLA_MS}ms, agent reported ${scan.log!.ms}ms)`
    );
    test.info().annotations.push({
      type: 'latency',
      description: `event -> surfaced: ${elapsedMs}ms of a ${SCAN_BUDGET_MS}ms scan budget`,
    });

    expect(
      elapsedMs,
      `event -> surfaced took ${elapsedMs}ms, over the ${LATENCY_SLA_MS}ms SLA (MVP requirement 6)`
    ).toBeLessThan(LATENCY_SLA_MS);
    expect(
      elapsedMs,
      `event -> surfaced took ${elapsedMs}ms. The observable work must fit in ` +
        `${SCAN_BUDGET_MS}ms, because production adds up to ${CRON_INTERVAL_MS}ms waiting ` +
        `for the next cron tick and ~${COLD_START_MS}ms of cold start on top of it ` +
        '(PRESEARCH.md Q30). Anything slower meets the SLA here and breaches it on Render.'
    ).toBeLessThanOrEqual(SCAN_BUDGET_MS);

    // ── 6 · And a human can see it without knowing where to look ────────────────
    //
    // The rail indicator renders nothing at all when the count is zero, so its presence
    // is itself the assertion: the proactive half of the agent is discoverable rather
    // than only findable by opening the right document (FG-170).
    await page.goto('/');

    // MEASURED, not assumed: the browser can read the finding here. This ran green while
    // the badge below did not, which is what identified the cache below as the cause
    // rather than a delivery problem.
    const seenByBrowser = await page.evaluate(() =>
      fetch('/api/fleetgraph/notifications', { credentials: 'include' }).then((r) => r.text())
    );
    expect(seenByBrowser).toContain(scenario.weekTitle);

    // ── Why the cache has to be dropped, and what it means for the product ───────
    //
    // `web/src/main.tsx` mounts a `PersistQueryClientProvider` backed by IndexedDB, so
    // the React Query cache survives a page load. The login at the top of this test
    // mounted the app and cached `['fleetgraph','notifications'] = []` — correctly, the
    // workspace was quiet then — and `useFleetGraphNotifications` sets `staleTime:
    // 60_000`. A reload inside that minute therefore restores the empty list from
    // storage and renders no badge, even though the request above returns the finding.
    //
    // That is a real property of the product, not a test artifact: a user with the app
    // already open can be up to 60 s behind the agent. It sits well inside the 5-minute
    // SLA, which is measured to delivery, and it is why steps 1-5 above — not this one —
    // are what the latency assertion is made against.
    //
    // Dropped rather than waited out, so CI does not spend a minute per run watching a
    // cache expire. The `toPass` wrapper is the belt: if the delete is blocked by the
    // page's own open connection it completes on the reload, and the retry picks it up.
    await expect(async () => {
      await page.evaluate(async () => {
        const dbs = (await indexedDB.databases?.()) ?? [];
        await Promise.all(
          dbs
            .filter((d) => d.name)
            .map(
              (d) =>
                new Promise<void>((resolve) => {
                  const req = indexedDB.deleteDatabase(d.name!);
                  req.onsuccess = req.onerror = req.onblocked = () => resolve();
                })
            )
        );
      });
      await page.reload();
      await expect(page.getByTestId('fleetgraph-rail-badge')).toBeVisible({ timeout: 10_000 });
    }).toPass({ timeout: 90_000, intervals: [1_000, 2_000, 5_000] });

    await page.getByRole('button', { name: /Agent findings \(\d+ open\)/ }).click();
    const list = page.getByTestId('fleetgraph-notification-list');
    await expect(list).toBeVisible();
    await expect(list).toContainText(scenario.weekTitle);

    // ── 7 · The autonomous action actually happened ─────────────────────────────
    //
    // `sprint_miss_risk` is additive, so the graph is allowed to act without asking —
    // and did, over Ship's own HTTP API with the agent's `api_tokens` bearer. Without
    // this the run would still deliver its notification while every comment silently
    // failed, and step 3's `errors` assertion is the only other thing that would notice.
    const comments = await page.request
      .get(`${apiServer.url}/api/documents/${scenario.weekId}/comments`)
      .then((r) => r.json());
    expect(
      comments,
      'the agent should have commented on the week it raised the finding about'
    ).toHaveLength(1);
    expect(String(comments[0].content)).toContain('— FleetGraph');
    expect(
      String(comments[0].content),
      'the comment carries the measurement, not just the prose — that is the part a ' +
        'human can check (agent/src/actions/act.ts#commentBody)'
    ).toContain('threshold of 2');
  });
});
