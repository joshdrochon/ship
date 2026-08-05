/**
 * FG-229 — one regression test per use case, end to end.
 *
 * ── Why this file exists when the detectors already have tests ──────────────
 * `detectors/*.test.ts` proves each SQL predicate fires. That is a different
 * claim from the one the use-case table in `FLEETGRAPH.md` makes. The table says
 * what the AGENT does — what it detects, what shape the finding takes, who hears
 * about it, and what the human is left deciding — and every one of those is a
 * property of the whole graph, not of a query.
 *
 * A detector can be perfectly correct while the run carrying its signal routes
 * to the wrong node, notifies nobody, or proposes an action the table says it
 * must never take. Each test below therefore runs the REAL graph against a real
 * Postgres and asserts the row of the table, column by column:
 *
 *   trigger  →  the fixture, built to satisfy exactly that predicate
 *   detects  →  signal type, target, shape (one per issue vs one per sprint)
 *   produces →  the proposed action and its blast-radius class
 *   decides  →  who was notified, and that the agent did not decide for them
 *
 * ── Why each fixture produces exactly ONE signal ───────────────────────────
 * `route_action` escalates the top-ranked finding per run and records the rest.
 * A fixture that tripped two detectors would make "the agent proposed X" depend
 * on sort order among ties, so every workspace here is built to trip one and
 * only one — asserted, not assumed, by a length check in each test.
 *
 * ── Why every run goes through a checkpointer ──────────────────────────────
 * Each test needs two things from one run: the nodes it visited, and the state
 * it ended in. Streaming gives the first and `invoke` gives the second, but
 * calling both means running twice — and the SECOND run finds the first run's
 * observation already recorded and terminates `quiet_all_suppressed`. That is
 * correct behaviour and it makes a two-run helper silently assert nothing. So
 * the run is streamed once and the end state is read back out of the
 * checkpointer.
 *
 * ── FG-233 lives here too, and deliberately ────────────────────────────────
 * `POST /api/issues/bulk` must never be called. `client.test.ts` asserts that
 * against `assertSingleDocumentPath` with literal strings, which proves the
 * guard works but not that the guard sits on the path a real run takes. Here the
 * action layer is wired to a RECORDING fetch and the assertion is made against
 * what six real runs actually put on the wire. Nothing in the source is
 * inspected as a string; the request log is the evidence.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { MemorySaver } from '@langchain/langgraph';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

import { compileGraph, NODES } from './index.js';
import type { GraphDeps, GraphStateType, JudgeFn, AnswerFn } from './index.js';
import { makeShipAct } from '../actions/act.js';
import { createShipClient, assertSingleDocumentPath, type FetchLike } from '../actions/client.js';
import { THRESHOLDS } from '../detectors/types.js';
import {
  createWorkspace,
  createUser,
  createIssue,
  createSprint,
  createProject,
  attachToSprint,
  attachToProject,
  recordStateChange,
  type Workspace,
} from '../detectors/fixtures.js';

const API_DB = join(process.cwd(), '..', 'api', 'src', 'db');

let container: StartedPostgreSqlContainer;
let connectionString: string;
let pool: Pool;
let ws: Workspace;

/**
 * Every request the action layer made across every test in this file.
 *
 * Module-scoped rather than per-test because FG-233's claim is about the whole
 * surface: not "this run did not call bulk" but "no run in the use-case table
 * can". The final describe asserts against the accumulated log.
 */
const wire: Array<{ method: string; url: string }> = [];

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
  ws = await createWorkspace(pool, `uc-${Date.now()}-${Math.round(performance.now())}`);
});

/**
 * The stable fake for Ship (engineering requirement 3), recording as it goes.
 *
 * A plain function rather than a network interceptor, which is the payoff for
 * `ShipClientOptions.fetchImpl` being injectable. It answers 201 to everything,
 * because what is under test here is WHICH requests are made — `client.test.ts`
 * owns how failures behave.
 */
const recordingFetch: FetchLike = async (url, init) => {
  wire.push({ method: init.method, url });
  return { status: 201, ok: true, text: async () => '{}' };
};

/** The model, faked. It surfaces everything, so routing is what is under test. */
function fakes() {
  const calls = { judge: 0, answer: 0 };

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

  const answer: AnswerFn = async () => 'a grounded answer';

  return { calls, judge, answer };
}

function depsWith(f: ReturnType<typeof fakes>): GraphDeps {
  return {
    db: pool,
    judge: f.judge,
    answer: f.answer,
    // The REAL action layer over a fake socket. Wiring a fake at `act` instead
    // would skip `makeShipAct` and `createShipClient` entirely, and those two are
    // where FG-233's guarantee actually lives.
    act: makeShipAct(
      createShipClient({
        baseUrl: 'http://ship.test',
        token: 'test-token',
        fetchImpl: recordingFetch,
      })
    ),
  };
}

/**
 * One proactive scan. Streamed once; the end state comes from the checkpointer.
 *
 * See the header for why this must not run the graph twice.
 */
async function scanOnce(deps?: GraphDeps) {
  const f = fakes();
  const graph = compileGraph(deps ?? depsWith(f), new MemorySaver());
  const thread = `uc:${ws.workspaceId}`;
  const seen: string[] = [];

  for await (const chunk of await graph.stream(
    { mode: 'proactive', scope: { workspaceId: ws.workspaceId } } as never,
    { recursionLimit: 50, configurable: { thread_id: thread } }
  )) {
    for (const name of Object.keys(chunk as object)) seen.push(name);
  }

  const snapshot = await graph.getState({ configurable: { thread_id: thread } });
  return { seen, state: snapshot.values as GraphStateType, calls: f.calls };
}

async function notificationsFor(targetId: string) {
  const { rows } = await pool.query(
    `SELECT recipient_user_id, title, body, target_id
       FROM fleetgraph_notifications
      WHERE workspace_id = $1 AND target_id = $2`,
    [ws.workspaceId, targetId]
  );
  return rows as Array<{
    recipient_user_id: string;
    title: string;
    body: string | null;
    target_id: string;
  }>;
}

// ---------------------------------------------------------------------------
// Use case 1 — Engineer / PM: work that looks active but has not moved
// ---------------------------------------------------------------------------

describe('use case 1 — stalled work', () => {
  it('detects an idle in_progress issue, comments autonomously, tells the assignee', async () => {
    // The trigger exactly as the table states it: in_progress, not archived or
    // deleted, `updated_at` unmoved. 20 calendar days clears 5 business days
    // whichever weekday the suite runs on.
    const assignee = await createUser(pool, `uc1-${ws.workspaceId.slice(0, 8)}@t.local`, 'Dana');
    const issueId = await createIssue(pool, ws, {
      title: 'Fix the login redirect',
      state: 'in_progress',
      updatedDaysAgo: 20,
      assigneeId: assignee,
    });

    const { seen, state } = await scanOnce();

    // ── detects ──────────────────────────────────────────────────────────
    expect(state.signals, 'the fixture must trip exactly one detector').toHaveLength(1);
    const signal = state.signals[0]!;
    expect(signal.type).toBe('stalled_work');
    expect(signal.targetType, 'one signal per ISSUE, per the table').toBe('issue');
    expect(signal.targetId).toBe(issueId);
    expect(signal.threshold).toBe(THRESHOLDS.STALLED_WORK_DAYS);
    expect(
      signal.measurement,
      'the idle count travels with the signal so a human can check it'
    ).toBeGreaterThanOrEqual(THRESHOLDS.STALLED_WORK_DAYS);
    expect(signal.accountableUserId, 'the assignee is who is accountable (Q6)').toBe(assignee);

    // ── produces ─────────────────────────────────────────────────────────
    expect(state.pending?.action.class, 'a comment is additive').toBe('additive');
    expect(state.pending?.action.kind).toBe('comment');
    expect(seen).toContain(NODES.executeAutonomous);
    expect(seen).not.toContain(NODES.awaitApproval);

    // ── decides ──────────────────────────────────────────────────────────
    // Blocked, done-but-unmarked or abandoned is the human's call. All the agent
    // does is comment and notify.
    const notes = await notificationsFor(issueId);
    expect(notes, 'the assignee must actually be told').toHaveLength(1);
    expect(notes[0]!.recipient_user_id).toBe(assignee);
    expect(state.outcome).toBe('delivered');
  }, 90_000);
});

// ---------------------------------------------------------------------------
// Use case 2 — PM: a sprint about to miss, as ONE signal
// ---------------------------------------------------------------------------

describe('use case 2 — sprint miss risk', () => {
  it('raises one signal PER SPRINT carrying the unstarted count, not one per issue', async () => {
    const owner = await createUser(pool, `uc2-${ws.workspaceId.slice(0, 8)}@t.local`, 'Priya');
    const sprintId = await createSprint(pool, ws, {
      title: 'Week 31',
      endsInDays: 1,
      ownerId: owner,
    });

    // Four unstarted issues, freshly touched so nothing else fires — and four
    // rather than one so "per sprint, not per issue" is a distinguishable claim.
    for (let n = 0; n < 4; n++) {
      const id = await createIssue(pool, ws, {
        title: `Unstarted ${n}`,
        state: n % 2 === 0 ? 'todo' : 'backlog',
        updatedDaysAgo: 0,
      });
      await attachToSprint(pool, id, sprintId);
    }

    const { seen, state } = await scanOnce();

    expect(
      state.signals,
      'four unstarted issues must produce ONE finding, or the PM gets four pings'
    ).toHaveLength(1);
    const signal = state.signals[0]!;
    expect(signal.type).toBe('sprint_miss_risk');
    expect(signal.targetType).toBe('sprint');
    expect(signal.targetId).toBe(sprintId);
    expect(signal.measurement, 'the count of unstarted issues is the measurement').toBe(4);
    expect(signal.accountableUserId, 'the sprint owner descopes, reassigns or moves').toBe(owner);

    expect(state.pending?.action.class).toBe('additive');
    expect(seen).toContain(NODES.executeAutonomous);

    const notes = await notificationsFor(sprintId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.recipient_user_id).toBe(owner);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// Use case 3 — PM / Director: load imbalance. The one that is GATED.
// ---------------------------------------------------------------------------

describe('use case 3 — load imbalance', () => {
  it('proposes a rebalance to the sprint owner and never performs it', async () => {
    // Median 1, factor 2, three people holding work — only the person on eight
    // clears the bar. Everything touched today and the sprint ends in ten days,
    // so this is the only signal the workspace produces.
    const sprintId = await createSprint(pool, ws, {
      title: 'Week 32',
      endsInDays: 10,
      ownerId: ws.ownerId,
    });

    for (let p = 0; p < 3; p++) {
      const uid = await createUser(pool, `uc3-p${p}-${sprintId.slice(0, 8)}@t.local`, `P${p}`);
      for (let n = 0; n < (p === 2 ? 8 : 1); n++) {
        const id = await createIssue(pool, ws, {
          title: `P${p} issue ${n}`,
          state: 'in_progress',
          updatedDaysAgo: 0,
          assigneeId: uid,
        });
        await attachToSprint(pool, id, sprintId);
      }
    }

    // The gated path suspends, so it needs the DURABLE checkpointer rather than
    // the in-memory one the other tests use: what is being asserted is the
    // production suspend, and an in-memory saver would prove the branch was
    // taken without proving the proposal survives the process that made it.
    const saver = PostgresSaver.fromConnString(connectionString);
    await saver.setup();

    const f = fakes();
    const graph = compileGraph(depsWith(f), saver);
    const thread = `fg:uc3:${ws.workspaceId}`;
    const seen: string[] = [];

    for await (const chunk of await graph.stream(
      { mode: 'proactive', scope: { workspaceId: ws.workspaceId } } as never,
      { recursionLimit: 50, configurable: { thread_id: thread } }
    )) {
      for (const name of Object.keys(chunk as object)) seen.push(name);
    }

    const snapshot = await graph.getState({ configurable: { thread_id: thread } });
    const state = snapshot.values as GraphStateType;

    expect(state.signals, 'the fixture must trip exactly one detector').toHaveLength(1);
    const signal = state.signals[0]!;
    expect(signal.type).toBe('load_imbalance');
    // "About the overloaded person, to the sprint owner" — the target is the
    // sprint, because that is the thing the owner can act on.
    expect(signal.targetType).toBe('sprint');
    expect(signal.targetId).toBe(sprintId);
    // The finding is ABOUT the overloaded person even though it is addressed to
    // the owner, so the context has to name them and say by how much. A signal
    // that only said "this sprint is unbalanced" would leave the owner to work
    // out who — which is the part the measurement already knows.
    expect(signal.context.overloaded_person, 'name the person who is drowning').toBe('P2');
    expect(signal.context.their_active_issues).toBe(8);
    expect(signal.context.team_median).toBe(1);
    expect(signal.context.team_size, 'a median below 3 people is meaningless').toBe(
      THRESHOLDS.LOAD_IMBALANCE_MIN_TEAM
    );
    expect(signal.threshold).toBe(
      (signal.context.team_median as number) * THRESHOLDS.LOAD_IMBALANCE_FACTOR
    );

    // ── the agent proposes, never reassigns ──────────────────────────────
    expect(state.pending?.action.class, 'moving work between people is a mutation').toBe(
      'mutation'
    );
    // The gate node does not appear in the stream: `interrupt()` throws out of
    // it, so LangGraph reports the thread as still owing that node rather than
    // as having completed it. `next` is therefore the assertion that the run is
    // parked AT the gate — a stronger claim than "it visited the gate", which a
    // run that sailed through would also satisfy.
    expect(snapshot.next, 'the run is suspended AT the approval gate').toContain(
      NODES.awaitApproval
    );
    expect(seen, 'a mutation must NEVER reach the autonomous branch').not.toContain(
      NODES.executeAutonomous
    );
    expect(seen).not.toContain(NODES.deliver);
    expect(state.outcome, 'nothing was delivered — a human still has to answer').not.toBe(
      'delivered'
    );

    const notes = await notificationsFor(sprintId);
    expect(notes, 'the sprint owner is asked BEFORE anything happens').toHaveLength(1);
    expect(notes[0]!.recipient_user_id).toBe(ws.ownerId);
    expect(notes[0]!.title.toLowerCase()).toContain('rebalanc');

    await saver.end();
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Use case 4 — Engineer / PM: finished work stuck at the review gate
// ---------------------------------------------------------------------------

describe('use case 4 — review bottleneck', () => {
  it('detects an in_review issue idle past 2 business days and routes it to the assignee', async () => {
    // Q6: Ship has no reviewer field, so the finding goes to the assignee rather
    // than to a reviewer the schema cannot express. Asserted rather than
    // described, because a future schema change should break this test.
    const assignee = await createUser(pool, `uc4-${ws.workspaceId.slice(0, 8)}@t.local`, 'Sam');
    const issueId = await createIssue(pool, ws, {
      title: 'Add the export endpoint',
      state: 'in_review',
      updatedDaysAgo: 12,
      assigneeId: assignee,
    });

    const { seen, state } = await scanOnce();

    expect(state.signals).toHaveLength(1);
    const signal = state.signals[0]!;
    expect(signal.type).toBe('review_bottleneck');
    expect(signal.targetType).toBe('issue');
    expect(signal.targetId).toBe(issueId);
    expect(signal.threshold).toBe(THRESHOLDS.REVIEW_BOTTLENECK_DAYS);
    expect(signal.measurement).toBeGreaterThanOrEqual(THRESHOLDS.REVIEW_BOTTLENECK_DAYS);
    expect(signal.accountableUserId, 'no reviewer exists in the schema (Q6)').toBe(assignee);

    expect(state.pending?.action.class).toBe('additive');
    expect(seen).toContain(NODES.executeAutonomous);

    const notes = await notificationsFor(issueId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.recipient_user_id).toBe(assignee);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// Use case 5 — Director: rework churn, aggregated per project
// ---------------------------------------------------------------------------

describe('use case 5 — rework churn', () => {
  it('aggregates reopened work PER PROJECT and reports it to the project owner', async () => {
    const owner = await createUser(pool, `uc5-${ws.workspaceId.slice(0, 8)}@t.local`, 'Ada');
    const projectId = await createProject(pool, ws, { title: 'Platform', ownerId: owner });

    // Three issues each returning from done inside the 30-day lookback. Three,
    // not two, so the aggregate is distinguishable from the threshold itself.
    for (let n = 0; n < 3; n++) {
      const id = await createIssue(pool, ws, { title: `Reopened ${n}`, updatedDaysAgo: 0 });
      await attachToProject(pool, id, projectId);
      await recordStateChange(pool, id, 'done', 'in_progress', ws.ownerId, 3);
    }

    const { seen, state } = await scanOnce();

    expect(
      state.signals,
      'three reopened issues aggregate to ONE project-level finding'
    ).toHaveLength(1);
    const signal = state.signals[0]!;
    expect(signal.type).toBe('rework_churn');
    expect(signal.targetType, 'per project — not per issue, and not per sprint').toBe('project');
    expect(signal.targetId).toBe(projectId);
    expect(signal.threshold).toBe(THRESHOLDS.REWORK_CHURN_REOPENS);
    expect(signal.measurement).toBeGreaterThanOrEqual(THRESHOLDS.REWORK_CHURN_REOPENS);
    expect(signal.accountableUserId).toBe(owner);

    expect(state.pending?.action.class, 'a quality signal is information, not a change').toBe(
      'additive'
    );
    expect(seen).toContain(NODES.executeAutonomous);

    const notes = await notificationsFor(projectId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.recipient_user_id).toBe(owner);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// Use case 6 — Any: on-demand chat, read-only by construction
// ---------------------------------------------------------------------------

describe('use case 6 — on-demand chat', () => {
  it('answers about the document the user is looking at and takes no action at all', async () => {
    const assignee = await createUser(pool, `uc6-${ws.workspaceId.slice(0, 8)}@t.local`, 'Kim');
    const issueId = await createIssue(pool, ws, {
      title: 'Rewrite the importer',
      state: 'in_progress',
      updatedDaysAgo: 20,
      assigneeId: assignee,
    });
    await recordStateChange(pool, issueId, 'todo', 'in_progress', ws.ownerId, 21);

    // The input the answer node was actually given, captured rather than
    // trusted. "It answered" is not the same claim as "it answered about THIS
    // document, from THIS document's measured state".
    let sawDocumentId: string | undefined;
    let sawSignals = -1;

    const f = fakes();
    const deps: GraphDeps = {
      ...depsWith(f),
      answer: async (input) => {
        sawDocumentId = input.scope.documentId;
        sawSignals = input.signals.length;
        return 'This has not moved in 14 business days; the assignee is Kim.';
      },
    };

    const graph = compileGraph(deps, new MemorySaver());
    const thread = `uc6:${ws.workspaceId}`;
    const seen: string[] = [];

    for await (const chunk of await graph.stream(
      {
        mode: 'on_demand',
        scope: { workspaceId: ws.workspaceId, documentId: issueId, documentType: 'issue' },
        actor: ws.ownerId,
        messages: [{ role: 'user', content: 'why is this behind?' }],
      } as never,
      { recursionLimit: 50, configurable: { thread_id: thread } }
    )) {
      for (const name of Object.keys(chunk as object)) seen.push(name);
    }

    const state = (await graph.getState({ configurable: { thread_id: thread } }))
      .values as GraphStateType;

    // ── grounded in that document's real state ───────────────────────────
    expect(sawDocumentId, 'the answer is scoped to the document the user opened').toBe(issueId);
    expect(
      sawSignals,
      'the answer node is handed the measured state rather than asked to guess'
    ).toBeGreaterThan(0);
    expect(state.answer).toBeTruthy();

    // ── no action taken, structurally ────────────────────────────────────
    expect(seen).toContain(NODES.composeAnswer);
    expect(seen).not.toContain(NODES.routeAction);
    expect(seen).not.toContain(NODES.executeAutonomous);
    expect(seen).not.toContain(NODES.executeApproved);
    expect(seen).not.toContain(NODES.awaitApproval);

    // Nothing was recorded for the human to act on, and nothing was suppressed —
    // a read-only path that wrote observations would silence the proactive scan
    // every time somebody opened a chat.
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM fleetgraph_observations WHERE workspace_id = $1`,
      [ws.workspaceId]
    );
    expect(rows[0].n, 'chat must not record observations').toBe(0);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// FG-233 — the bulk endpoint, asserted against the wire
// ---------------------------------------------------------------------------

describe('FG-233 — POST /api/issues/bulk is never called', () => {
  it('made requests, and not one of them was a bulk write', () => {
    // The guard against a vacuous pass. An empty log would satisfy every
    // assertion below while proving nothing — and an empty log is exactly what a
    // broken action layer produces.
    expect(
      wire.length,
      'the use cases above must have reached the action layer'
    ).toBeGreaterThan(0);

    for (const req of wire) {
      const path = new URL(req.url).pathname;
      expect(path, `${req.method} ${path} is a bulk write`).not.toMatch(/bulk/i);
      // Stronger than "not bulk": every request the agent made addressed exactly
      // one document. An endpoint nobody has written yet fails this too.
      expect(() => assertSingleDocumentPath(path)).not.toThrow();
    }
  });

  it('and every path it produced names a single document id', () => {
    const paths = new Set(wire.map((r) => new URL(r.url).pathname));
    expect(paths.size).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p).toMatch(
        /^\/api\/(documents\/[0-9a-fA-F-]{36}\/comments|issues\/[0-9a-fA-F-]{36}\/history)$/
      );
    }
  });
});
