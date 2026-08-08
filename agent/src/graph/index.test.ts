/**
 * The graph's load-bearing claims, asserted rather than described.
 *
 * Three of them, and the first is the one the whole cost model rests on:
 *
 *   FG-092  a quiet run terminates at the triage gate having called the model
 *           ZERO times
 *   FG-093  a run with signals actually reaches judgment
 *   FG-094  the state object is fully populated by the time delivery runs
 *
 * The judge is injected rather than module-mocked precisely so the first can be
 * asserted on a counter the graph increments through its real code path. A test
 * that mocked the module would be testing the mock.
 *
 * A fourth test asserts the paths DIFFER — quiet and drifting runs visiting
 * different node sets is MVP requirement 2, and it is the kind of claim that
 * quietly stops being true the first time someone rewires an edge.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTestPool } from '../testing/pool.js';

import { compileGraph, NODES } from './index.js';
import type { GraphDeps, JudgeFn, AnswerFn, ActFn } from './deps.js';
import {
  createWorkspace,
  createUser,
  createIssue,
  createSprint,
  attachToSprint,
  recordStateChange,
  type Workspace,
} from '../detectors/fixtures.js';

const API_DB = join(process.cwd(), '..', 'api', 'src', 'db');

let container: StartedPostgreSqlContainer;
let pool: Pool;
let ws: Workspace;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = createTestPool(container.getConnectionUri());
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
  ws = await createWorkspace(pool, `graph-${Date.now()}-${Math.round(performance.now())}`);
});

/**
 * Stable fakes for both external services (engineering requirement 3).
 *
 * Plain objects rather than network interceptors — which is the payoff for
 * injecting them in the first place. Each counts its calls, because "was the
 * model consulted" is an assertion this suite has to make repeatedly.
 */
function fakes() {
  const calls = { judge: 0, answer: 0, act: 0 };

  const judge: JudgeFn = async ({ signals }) => {
    calls.judge++;
    return signals.map((s) => ({
      fingerprint: s.fingerprint,
      severity: 'medium' as const,
      recipientUserId: s.accountableUserId,
      worthSurfacing: true,
      phrasing: `${s.type} on ${s.targetTitle}`,
    }));
  };

  const answer: AnswerFn = async () => {
    calls.answer++;
    return 'a grounded answer';
  };

  const act: ActFn = async () => {
    calls.act++;
    return { ok: true };
  };

  return { calls, judge, answer, act };
}

function depsWith(f: ReturnType<typeof fakes>): GraphDeps {
  return { db: pool, judge: f.judge, answer: f.answer, act: f.act };
}

/** Run the graph and collect the node names it actually visited. */
async function visitedNodes(graph: ReturnType<typeof compileGraph>, input: object) {
  const seen: string[] = [];
  for await (const chunk of await graph.stream(input as never, { recursionLimit: 50 })) {
    for (const name of Object.keys(chunk as object)) seen.push(name);
  }
  return seen;
}

describe('the graph', () => {
  it('FG-092 — a quiet run terminates at the triage gate with ZERO model calls', async () => {
    // A healthy workspace: everything moving, nothing idle.
    const sprint = await createSprint(pool, ws, { endsInDays: 6, ownerId: ws.ownerId });
    for (let n = 0; n < 4; n++) {
      const i = await createIssue(pool, ws, { state: 'in_progress', updatedDaysAgo: 0 });
      await attachToSprint(pool, i, sprint);
    }

    const f = fakes();
    const graph = compileGraph(depsWith(f));
    const seen = await visitedNodes(graph, {
      mode: 'proactive',
      scope: { workspaceId: ws.workspaceId },
    });

    // The assertion the entire cost argument rests on. 480 scans a day is only
    // affordable because almost every one of them ends here.
    expect(f.calls.judge, 'a quiet run must not consult the model').toBe(0);
    expect(f.calls.act, 'a quiet run must not act').toBe(0);

    expect(seen).toContain(NODES.triageGate);
    expect(seen).toContain(NODES.closeQuiet);
    expect(seen).not.toContain(NODES.judgeSignals);
    expect(seen).not.toContain(NODES.routeAction);
  }, 60_000);

  it('FG-093 — a run with signals reaches judgment', async () => {
    // Idle 20 days, well past the 5-business-day threshold.
    const assignee = await createUser(pool, `a-${ws.workspaceId.slice(0, 8)}@t.local`, 'A');
    await createIssue(pool, ws, {
      state: 'in_progress',
      updatedDaysAgo: 20,
      assigneeId: assignee,
    });

    const f = fakes();
    const graph = compileGraph(depsWith(f));
    const seen = await visitedNodes(graph, {
      mode: 'proactive',
      scope: { workspaceId: ws.workspaceId },
    });

    expect(seen).toContain(NODES.judgeSignals);
    expect(f.calls.judge, 'the batch is judged in ONE call, never one per signal').toBe(1);
  }, 60_000);

  it('FG-094 — the state object is fully populated at deliver', async () => {
    const assignee = await createUser(pool, `b-${ws.workspaceId.slice(0, 8)}@t.local`, 'B');
    await createIssue(pool, ws, {
      state: 'in_progress',
      updatedDaysAgo: 20,
      assigneeId: assignee,
    });

    const f = fakes();
    const graph = compileGraph(depsWith(f));
    const final = await graph.invoke(
      { mode: 'proactive', scope: { workspaceId: ws.workspaceId } } as never,
      { recursionLimit: 50 }
    );

    expect(final.mode).toBe('proactive');
    expect(final.scope.workspaceId).toBe(ws.workspaceId);
    expect(final.scannedThrough, 'scannedThrough must be captured before any query').toBeTruthy();
    expect(final.signals.length).toBeGreaterThan(0);
    expect(final.findings.length).toBeGreaterThan(0);
    expect(final.pending, 'route_action must have selected something to propose').toBeTruthy();
    expect(final.outcome).toBe('delivered');

    // The watermark is the proof that delivery closed the window (Q24).
    const { rows } = await pool.query(
      `SELECT last_scanned_at, last_run_completed_at FROM fleetgraph_watermarks WHERE workspace_id = $1`,
      [ws.workspaceId]
    );
    expect(rows[0]?.last_run_completed_at).toBeTruthy();
  }, 60_000);

  it('a quiet run and a drifting run take visibly DIFFERENT paths', async () => {
    // MVP requirement 2, asserted rather than promised. Two traces from the
    // same graph must not be the same shape, or the graph is a pipeline.
    const quietWs = await createWorkspace(pool, `quiet-${Math.round(performance.now())}`);
    await createIssue(pool, quietWs, { state: 'in_progress', updatedDaysAgo: 0 });

    const driftWs = await createWorkspace(pool, `drift-${Math.round(performance.now())}`);
    const u = await createUser(pool, `c-${driftWs.workspaceId.slice(0, 8)}@t.local`, 'C');
    await createIssue(pool, driftWs, { state: 'in_progress', updatedDaysAgo: 20, assigneeId: u });

    const f = fakes();
    const graph = compileGraph(depsWith(f));

    const quiet = await visitedNodes(graph, {
      mode: 'proactive',
      scope: { workspaceId: quietWs.workspaceId },
    });
    const drift = await visitedNodes(graph, {
      mode: 'proactive',
      scope: { workspaceId: driftWs.workspaceId },
    });

    expect(new Set(quiet)).not.toEqual(new Set(drift));
    expect(drift.length).toBeGreaterThan(quiet.length);
  }, 90_000);

  it('the on-demand path cannot reach any execute node', async () => {
    // Structural, not a prompt instruction (Q3). If someone adds an edge from
    // compose_answer to an execute node, this fails.
    const doc = await createIssue(pool, ws, { state: 'in_progress', updatedDaysAgo: 20 });

    const f = fakes();
    const graph = compileGraph(depsWith(f));
    const seen = await visitedNodes(graph, {
      mode: 'on_demand',
      scope: { workspaceId: ws.workspaceId, documentId: doc },
      actor: ws.ownerId,
      messages: [{ role: 'user', content: 'why is this behind?' }],
    });

    expect(seen).toContain(NODES.composeAnswer);
    expect(seen).not.toContain(NODES.executeAutonomous);
    expect(seen).not.toContain(NODES.executeApproved);
    expect(seen).not.toContain(NODES.awaitApproval);
    expect(f.calls.act, 'chat must never act').toBe(0);
    expect(f.calls.answer).toBe(1);
  }, 60_000);

  it('on-demand history reaches the answer prompt with its field names intact', async () => {
    // Regression. `resolveScope` selected `field_name` (wrong — the column is
    // `field`), and the fix corrected the SELECT but not the row mapping two
    // lines below. The query stopped throwing, so the test above went green
    // while every history entry silently carried `field: undefined` into the
    // answer prompt.
    //
    // Asserting the node ran is not the same as asserting it produced anything
    // usable. This checks the value, not the absence of an exception.
    const doc = await createIssue(pool, ws, { state: 'in_progress', updatedDaysAgo: 20 });
    await recordStateChange(pool, doc, 'todo', 'in_progress', ws.ownerId, 2);

    const f = fakes();
    const deps: GraphDeps = {
      ...depsWith(f),
      answer: async (input) => {
        // The document facts are carried into state as a message by
        // resolve_scope; pull them back out the way the prompt does.
        const doc = input.scope.documentId;
        expect(doc).toBeTruthy();
        return 'ok';
      },
    };

    const graph = compileGraph(deps);
    const final = await graph.invoke(
      {
        mode: 'on_demand',
        scope: { workspaceId: ws.workspaceId, documentId: doc },
        actor: ws.ownerId,
        messages: [{ role: 'user', content: 'what happened here?' }],
      } as never,
      { recursionLimit: 50 }
    );

    const resolved = final.messages
      .map((m: { content: string }) => {
        try {
          return JSON.parse(m.content);
        } catch {
          return null;
        }
      })
      .find((p: { document?: unknown } | null) => p?.document);

    expect(resolved, 'resolve_scope must carry the document into state').toBeTruthy();
    const seenHistory: Array<{ field?: string }> = resolved.document.recentHistory;
    expect(seenHistory.length).toBeGreaterThan(0);
    expect(
      seenHistory[0]?.field,
      'history entries must name the field that changed, not undefined'
    ).toBeTruthy();
  }, 60_000);
});
