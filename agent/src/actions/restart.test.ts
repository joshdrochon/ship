/**
 * FG-137 — the full `interrupt()` → resume cycle, across a process boundary.
 *
 * ── Why this test is written the hard way ──────────────────────────────────
 * The Render cron container EXITS when its run ends. That is what a cron job
 * is. So between "the agent proposes a reassignment" and "a human clicks
 * accept" there is no process — not a sleeping one, not an idle one, none. Q19
 * is the whole reason the checkpointer exists, and this is the only test that
 * can show it was needed.
 *
 * A test that keeps the compiled graph in a variable and resumes it later
 * proves nothing at all. It would pass with an in-memory checkpointer, it would
 * pass with no checkpointer if LangGraph happened to cache, and it would pass
 * on a build that loses every pending approval on deploy. The thing under test
 * is precisely the part that a same-process test cannot reach.
 *
 * So there are two tests here, and the first is the real one:
 *
 *   1. the proposing half runs in a SEPARATE NODE PROCESS, which exits. Its
 *      `act` throws if called, so a proposing process that acts fails loudly.
 *      The resume then happens here, in a process that has never seen that
 *      graph, that state, or that checkpointer.
 *   2. the same cycle in-process with the graph and checkpointer explicitly
 *      destroyed — the fast one, which covers dismiss as well as accept and
 *      would still catch a regression if the child-process test were skipped.
 *
 * ── Why load imbalance ─────────────────────────────────────────────────────
 * It is the only signal `routeAction` classifies as a mutation, so it is the
 * only one that reaches the approval gate. The fixture below is built to
 * produce exactly that signal and no other, so the proposal under test is not
 * decided by sort order among ties.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Command } from '@langchain/langgraph';
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';

import { compileGraph } from '../graph/index.js';
import type { GraphDeps, JudgeFn, AnswerFn, ActFn } from '../graph/deps.js';
import { runDetectors } from '../detectors/index.js';
import {
  createWorkspace,
  createUser,
  createIssue,
  createSprint,
  attachToSprint,
  type Workspace,
} from '../detectors/fixtures.js';

const execFileAsync = promisify(execFile);
const AGENT_DIR = process.cwd();
const API_DB = join(AGENT_DIR, '..', 'api', 'src', 'db');

let container: StartedPostgreSqlContainer;
let connectionString: string;
let pool: Pool;
let ws: Workspace;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  connectionString = container.getConnectionUri();
  pool = new Pool({ connectionString });
  await pool.query(readFileSync(join(API_DB, 'schema.sql'), 'utf8'));
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`
  );
  for (const f of readdirSync(join(API_DB, 'migrations'))
    .filter((x) => x.endsWith('.sql'))
    .sort()) {
    await pool.query(readFileSync(join(API_DB, 'migrations', f), 'utf8'));
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  ws = await createWorkspace(pool, `restart-${Date.now()}-${Math.round(performance.now())}`);
});

/**
 * A sprint where one person carries eight active issues and two carry one each.
 *
 * Median 1, factor 2, so only the person on eight is over the bar — one
 * `load_imbalance` signal, and deliberately nothing else: every issue was
 * touched today (no stalled work), the sprint ends in ten days (no miss risk),
 * nothing is in review, and there is no state history (no rework churn).
 */
async function loadImbalancedSprint(): Promise<{ sprintId: string }> {
  const sprintId = await createSprint(pool, ws, {
    title: 'Week 32',
    endsInDays: 10,
    ownerId: ws.ownerId,
  });

  for (let p = 0; p < 3; p++) {
    const uid = await createUser(pool, `p${p}-${sprintId.slice(0, 8)}@t.local`, `P${p}`);
    for (let n = 0; n < (p === 2 ? 8 : 1); n++) {
      const issue = await createIssue(pool, ws, {
        title: `P${p} issue ${n}`,
        state: 'in_progress',
        updatedDaysAgo: 0,
        assigneeId: uid,
      });
      await attachToSprint(pool, issue, sprintId);
    }
  }

  return { sprintId };
}

function fakes(actBehaviour?: ActFn) {
  const calls = { judge: 0, answer: 0, act: 0 };

  const judge: JudgeFn = async ({ signals }) => {
    calls.judge++;
    return signals.map((s) => ({
      fingerprint: s.fingerprint,
      severity: 'high' as const,
      recipientUserId: s.accountableUserId,
      worthSurfacing: true,
      phrasing: `${s.type} on ${s.targetTitle}`,
    }));
  };
  const answer: AnswerFn = async () => {
    calls.answer++;
    return '';
  };
  const act: ActFn = async (action) => {
    calls.act++;
    return actBehaviour ? actBehaviour(action) : { ok: true };
  };

  return { calls, judge, answer, act };
}

function depsWith(f: ReturnType<typeof fakes>, db: Pool): GraphDeps {
  return { db, judge: f.judge, answer: f.answer, act: f.act };
}

/**
 * The thread id the caller chooses.
 *
 * `awaitApproval` stores whatever `configurable.thread_id` was passed, because
 * that is the only id the checkpointer actually wrote under and therefore the
 * only one that can be resumed. The format mirrors `threadIdFor` so a trace and
 * a notification row read the same way.
 */
function threadId(fingerprint: string): string {
  return `fg:${ws.workspaceId}:${fingerprint}`;
}

/** The one load-imbalance fingerprint this workspace produces. */
async function theFingerprint(): Promise<string> {
  const run = await runDetectors(ws.workspaceId, pool);
  const imbalance = run.signals.filter((s) => s.type === 'load_imbalance');
  expect(run.signals, 'the fixture must produce exactly one signal').toHaveLength(1);
  expect(imbalance, 'and it must be the mutation-classified one').toHaveLength(1);
  return imbalance[0]!.fingerprint;
}

async function pendingApproval(fingerprint: string) {
  const { rows } = await pool.query(
    `SELECT o.id, o.resolution, n.pending_thread_id, n.title
       FROM fleetgraph_observations o
       LEFT JOIN fleetgraph_notifications n ON n.observation_id = o.id
      WHERE o.workspace_id = $1 AND o.fingerprint = $2`,
    [ws.workspaceId, fingerprint]
  );
  return rows[0] as
    | { id: string; resolution: string | null; pending_thread_id: string | null; title: string }
    | undefined;
}

/** How many checkpoints Postgres holds for a thread. Zero means nothing survived. */
async function checkpointCount(thread: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM checkpoints WHERE thread_id = $1`,
    [thread]
  );
  return rows[0].n as number;
}

/**
 * The proposing half, in a process of its own.
 *
 * `tsx --eval` rather than a checked-in script file: `agent/tsconfig.json`
 * compiles everything under `src/` that is not a `.test.ts`, so a helper module
 * here would ship inside the Docker image for no reason.
 *
 * The child's `act` throws. A proposal is not an action, and a proposing
 * process that acts is the exact failure the approval gate exists to prevent —
 * so it fails the test rather than passing quietly.
 *
 * Wrapped in an async IIFE because `tsx --eval` compiles to CJS, where
 * top-level await is a build error. Dynamic `import()` works fine inside it.
 */
const CHILD_SOURCE = `
(async () => {
  const { Pool } = await import('pg');
  const { PostgresSaver } = await import('@langchain/langgraph-checkpoint-postgres');
  const { compileGraph } = await import('./src/graph/index.js');

  const url = process.env.FG_DB_URL;
  const pool = new Pool({ connectionString: url });
  const saver = PostgresSaver.fromConnString(url);
  await saver.setup();

  const graph = compileGraph(
    {
      db: pool,
      judge: async ({ signals }) =>
        signals.map((s) => ({
          fingerprint: s.fingerprint,
          severity: 'high',
          recipientUserId: s.accountableUserId,
          worthSurfacing: true,
          phrasing: s.type + ' on ' + s.targetTitle,
        })),
      answer: async () => '',
      act: async () => {
        throw new Error('the proposing process must never act — that is what the gate is for');
      },
    },
    saver
  );

  const out = await graph.invoke(
    { mode: 'proactive', scope: { workspaceId: process.env.FG_WORKSPACE } },
    { configurable: { thread_id: process.env.FG_THREAD }, recursionLimit: 50 }
  );

  console.log('FG137 ' + JSON.stringify({
    pid: process.pid,
    interrupted: Boolean(out.__interrupt__),
    outcome: out.outcome ?? null,
  }));

  await saver.end();
  await pool.end();
  process.exit(0);
})().catch((err) => {
  console.error('FG137-CHILD-FAILED', err && err.stack ? err.stack : err);
  process.exit(1);
});
`;

describe('FG-137 — interrupt and resume across a process restart', () => {
  it('proposes in a process that then EXITS, and resumes in one that never saw it', async () => {
    await loadImbalancedSprint();
    const fingerprint = await theFingerprint();
    const thread = threadId(fingerprint);

    // ── Process 1: the cron container ────────────────────────────────────
    const { stdout } = await execFileAsync('npx', ['tsx', '--eval', CHILD_SOURCE], {
      cwd: AGENT_DIR,
      env: {
        ...process.env,
        FG_DB_URL: connectionString,
        FG_WORKSPACE: ws.workspaceId,
        FG_THREAD: thread,
      },
      timeout: 120_000,
    });

    const line = stdout.split('\n').find((l) => l.startsWith('FG137 '));
    expect(line, `child produced no result. stdout:\n${stdout}`).toBeTruthy();
    const child = JSON.parse(line!.slice('FG137 '.length)) as {
      pid: number;
      interrupted: boolean;
      outcome: string | null;
    };

    expect(child.pid, 'the proposal must not have run in this process').not.toBe(process.pid);
    expect(child.interrupted, 'the run must have suspended at the gate').toBe(true);

    // That process is now gone. Everything below has to come out of Postgres.
    const proposal = await pendingApproval(fingerprint);
    expect(proposal, 'the observation is written BEFORE the interrupt').toBeTruthy();
    expect(proposal!.resolution).toBeNull();
    expect(
      proposal!.pending_thread_id,
      'the notification must name the thread the checkpointer actually wrote'
    ).toBe(thread);
    expect(proposal!.title).toContain('rebalancing');

    expect(await checkpointCount(thread), 'the suspended run lives in Postgres').toBeGreaterThan(0);

    // ── Process 2: this one. A human clicks accept, hours later ──────────
    const f = fakes();
    const saver = PostgresSaver.fromConnString(connectionString);
    await saver.setup();
    const graph = compileGraph(depsWith(f, pool), saver);

    const final = await graph.invoke(
      new Command({ resume: { decision: 'accept' } }) as never,
      { configurable: { thread_id: thread }, recursionLimit: 50 }
    );

    // The action ran HERE, after the restart, from state this process never
    // built. That is the claim.
    expect(f.calls.act, 'the approved action executes in the resuming process').toBe(1);
    // And it resumed mid-graph rather than starting over: re-judging would mean
    // the resume replayed the run instead of continuing it, and would spend
    // tokens on every approval.
    expect(f.calls.judge, 'a resume must not re-run judgement').toBe(0);
    expect(final.outcome).toBe('delivered');
    expect(final.pending?.action.class, 'the proposal survived the restart intact').toBe('mutation');
    expect(final.pending?.action.targetId).toBeTruthy();

    const resolved = await pendingApproval(fingerprint);
    expect(resolved!.resolution).toBe('accepted');

    await saver.end();
  }, 180_000);

  it('a dismissal survives the restart too, and never executes the action', async () => {
    // Same cycle in-process, with the first graph and its checkpointer
    // explicitly destroyed. Faster than spawning, and it covers the branch
    // where the human says no — which must resolve the observation without
    // ever calling `act`.
    await loadImbalancedSprint();
    const fingerprint = await theFingerprint();
    const thread = threadId(fingerprint);

    const before = fakes();
    const saver1 = PostgresSaver.fromConnString(connectionString);
    await saver1.setup();
    const graph1 = compileGraph(depsWith(before, pool), saver1);

    const suspended = await graph1.invoke(
      { mode: 'proactive', scope: { workspaceId: ws.workspaceId } } as never,
      { configurable: { thread_id: thread }, recursionLimit: 50 }
    );
    expect((suspended as { __interrupt__?: unknown }).__interrupt__).toBeTruthy();
    expect(before.calls.act, 'proposing is not acting').toBe(0);

    // Throw it all away. The connection pool behind the first checkpointer is
    // closed, so nothing below can be served by a socket it left open.
    await saver1.end();
    // Deliberately NOT nulled-and-forgotten: the linter is right that a dead
    // assignment proves nothing. What proves it is that everything below uses
    // saver2/graph2 exclusively, and saver1's pool is closed — a leaked reuse
    // would throw on a closed pool rather than silently succeed.

    const after = fakes();
    const saver2 = PostgresSaver.fromConnString(connectionString);
    await saver2.setup();
    const graph2 = compileGraph(depsWith(after, pool), saver2);

    const final = await graph2.invoke(
      new Command({ resume: { decision: 'dismiss' } }) as never,
      { configurable: { thread_id: thread }, recursionLimit: 50 }
    );

    expect(final.outcome).toBe('delivered');
    expect(after.calls.act, 'a dismissal must never execute the proposal').toBe(0);
    expect(after.calls.judge).toBe(0);

    const resolved = await pendingApproval(fingerprint);
    expect(resolved!.resolution).toBe('dismissed');

    await saver2.end();
  }, 180_000);

  it('a snooze across the restart sets the horizon in business days', async () => {
    await loadImbalancedSprint();
    const fingerprint = await theFingerprint();
    const thread = threadId(fingerprint);

    const before = fakes();
    const saver1 = PostgresSaver.fromConnString(connectionString);
    await saver1.setup();
    await compileGraph(depsWith(before, pool), saver1).invoke(
      { mode: 'proactive', scope: { workspaceId: ws.workspaceId } } as never,
      { configurable: { thread_id: thread }, recursionLimit: 50 }
    );
    await saver1.end();

    const after = fakes();
    const saver2 = PostgresSaver.fromConnString(connectionString);
    await saver2.setup();
    await compileGraph(depsWith(after, pool), saver2).invoke(
      new Command({ resume: { decision: 'snooze', businessDays: 5 } }) as never,
      { configurable: { thread_id: thread }, recursionLimit: 50 }
    );

    const { rows } = await pool.query(
      `SELECT resolution, snooze_until, resolved_at FROM fleetgraph_observations
        WHERE workspace_id = $1 AND fingerprint = $2`,
      [ws.workspaceId, fingerprint]
    );
    expect(rows[0].resolution).toBe('snoozed');
    // 5 business days always span at least 5 calendar days, never fewer.
    expect(rows[0].snooze_until.getTime() - Date.now()).toBeGreaterThan(4.5 * 86_400_000);
    // A snooze is not a resolution — it is a deferral, and `resolved_at` stays
    // null so the finding can wake.
    expect(rows[0].resolved_at).toBeNull();
    expect(after.calls.act, 'a snooze must never execute the proposal').toBe(0);

    await saver2.end();
  }, 180_000);
});
