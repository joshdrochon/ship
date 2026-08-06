/**
 * Capture one LangSmith trace per use case, for the Test Cases table.
 *
 * Brief p.9: "For each use case above, provide: the Ship state that should
 * trigger the agent, what the agent should detect or produce, and the LangSmith
 * trace link from a run against that state." The first two columns have been
 * filled in since the section was written. This produces the third.
 *
 * ── Why this runs locally rather than against the deployment ────────────────
 * Both were possible; this one is better, and the reasoning is worth keeping
 * because the deployed route looks more impressive and is not.
 *
 * The deployed database sits behind an empty `ipAllowList`, so planting state in
 * it means opening a production database to an IP for the duration — a security
 * setting changed for a documentation task. It is also not repeatable: whoever
 * checks this later gets a hand-performed sequence against a live system rather
 * than a script.
 *
 * Suppression makes it worse. `fleetgraph_observations` is unique on
 * `(workspace_id, fingerprint)` and the bucket ladder is coarse, so a second run
 * against the same target never fires. Every recapture would need a fresh
 * target planted in production.
 *
 * And the requirement does not ask for it. It says "a run against that state",
 * not "a run on the deployed instance". MVP requirement 2 — that the graph takes
 * different paths under different conditions — is separately satisfied by the
 * two deployed traces already in FLEETGRAPH.md.
 *
 * So: real graph, real Anthropic model, real detectors, real Postgres from
 * testcontainers loading `schema.sql` and every migration. The only thing that
 * differs from a production run is which database the rows live in, and each
 * case gets a clean one — which is what makes this rerunnable.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   ANTHROPIC_API_KEY=... LANGCHAIN_API_KEY=... \
 *     pnpm --filter @ship/agent exec tsx scripts/capture-test-case-traces.ts
 *
 * Prints a markdown table of public trace links. Costs six model calls.
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { MemorySaver } from '@langchain/langgraph';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

import { compileGraph, type GraphDeps } from '../src/graph/index.js';
import { makeJudge, makeAnswer, describeProvider } from '../src/llm/index.js';
import { makeShipAct } from '../src/actions/index.js';
import { createShipClient, type FetchLike } from '../src/actions/client.js';
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
} from '../src/detectors/fixtures.js';

const API_DB = join(process.cwd(), '..', 'api', 'src', 'db');
const LANGSMITH_API = 'https://api.smith.langchain.com';
const PROJECT = process.env.LANGCHAIN_PROJECT ?? 'fleetgraph-testcases';

/**
 * Ship, faked (engineering requirement 3). Answers 201 to everything.
 *
 * The action layer is real — `makeShipAct` over `createShipClient` — because the
 * trace should show the nodes a real run visits, including the execute node.
 * What is faked is the socket underneath, so capturing a trace never writes to
 * anything outside this container.
 */
const fakeShip: FetchLike = async () => ({ status: 201, ok: true, text: async () => '{}' });

interface Case {
  n: number;
  name: string;
  /** Builds the trigger state. Returns the invocation input for the graph. */
  build: (pool: Pool, ws: Workspace) => Promise<Record<string, unknown>>;
}

const CASES: Case[] = [
  {
    n: 1,
    name: 'Stalled work',
    build: async (pool, ws) => {
      const dev = await createUser(pool, `dev-${ws.workspaceId}@ship.local`, 'Dev');
      await createIssue(pool, ws, { state: 'in_progress', assigneeId: dev, updatedDaysAgo: 20 });
      return { mode: 'proactive', scope: { workspaceId: ws.workspaceId } };
    },
  },
  {
    n: 2,
    name: 'Sprint-miss risk',
    build: async (pool, ws) => {
      const owner = await createUser(pool, `owner-${ws.workspaceId}@ship.local`, 'Owner');
      const sprint = await createSprint(pool, ws, { endsInDays: 1, ownerId: owner });
      for (let i = 0; i < 4; i++) {
        const id = await createIssue(pool, ws, {
          state: i % 2 === 0 ? 'todo' : 'backlog',
          updatedDaysAgo: 0,
        });
        await attachToSprint(pool, id, sprint);
      }
      return { mode: 'proactive', scope: { workspaceId: ws.workspaceId } };
    },
  },
  {
    n: 3,
    name: 'Load imbalance',
    build: async (pool, ws) => {
      const owner = await createUser(pool, `owner-${ws.workspaceId}@ship.local`, 'Owner');
      const sprint = await createSprint(pool, ws, { endsInDays: 10, ownerId: owner });
      const load = [1, 1, 8];
      for (let p = 0; p < load.length; p++) {
        const person = await createUser(pool, `p${p}-${ws.workspaceId}@ship.local`, `Person ${p}`);
        for (let i = 0; i < load[p]!; i++) {
          const id = await createIssue(pool, ws, {
            state: 'in_progress',
            assigneeId: person,
            updatedDaysAgo: 0,
          });
          await attachToSprint(pool, id, sprint);
        }
      }
      return { mode: 'proactive', scope: { workspaceId: ws.workspaceId } };
    },
  },
  {
    n: 4,
    name: 'Review bottleneck',
    build: async (pool, ws) => {
      const dev = await createUser(pool, `dev-${ws.workspaceId}@ship.local`, 'Dev');
      await createIssue(pool, ws, { state: 'in_review', assigneeId: dev, updatedDaysAgo: 12 });
      return { mode: 'proactive', scope: { workspaceId: ws.workspaceId } };
    },
  },
  {
    n: 5,
    name: 'Rework churn',
    build: async (pool, ws) => {
      const owner = await createUser(pool, `owner-${ws.workspaceId}@ship.local`, 'Owner');
      const project = await createProject(pool, ws, { ownerId: owner });
      for (let i = 0; i < 3; i++) {
        const id = await createIssue(pool, ws, { updatedDaysAgo: 0 });
        await attachToProject(pool, id, project);
        await recordStateChange(pool, id, 'done', 'in_progress', ws.ownerId, 3);
      }
      return { mode: 'proactive', scope: { workspaceId: ws.workspaceId } };
    },
  },
  {
    n: 6,
    name: 'On-demand contextual answer',
    build: async (pool, ws) => {
      const dev = await createUser(pool, `dev-${ws.workspaceId}@ship.local`, 'Dev');
      const issue = await createIssue(pool, ws, {
        state: 'in_progress',
        assigneeId: dev,
        updatedDaysAgo: 20,
      });
      await recordStateChange(pool, issue, 'todo', 'in_progress', ws.ownerId, 21);
      return {
        mode: 'on_demand',
        scope: { workspaceId: ws.workspaceId, documentId: issue, documentType: 'issue' },
        messages: [{ role: 'user', content: 'What is the state of this issue and is it at risk?' }],
      };
    },
  },
];

/**
 * Make a run publicly shareable and return its URL.
 *
 * Retried on 404, which is not "no such run" here but "not yet". A run becomes
 * visible to the query endpoint before it is durable enough to share, so the
 * first attempt on a freshly-finished run can lose that race — observed on case
 * 2 while case 1 succeeded immediately.
 */
async function share(runId: string, apiKey: string): Promise<string> {
  let last = '';
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await fetch(`${LANGSMITH_API}/api/v1/runs/${runId}/share`, {
      method: 'PUT',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (res.ok) {
      const { share_token } = (await res.json()) as { share_token: string };
      return `https://smith.langchain.com/public/${share_token}/r`;
    }
    last = `${res.status} ${await res.text()}`;
    if (res.status !== 404) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`share ${runId}: ${last}`);
}

/**
 * The root run for a project, newest first.
 *
 * Polled rather than read once: traces upload on a background queue, so the run
 * is not queryable the instant `invoke` returns even with callbacks synchronous.
 */
async function latestRunId(apiKey: string, sessionId: string, after: string): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = await fetch(`${LANGSMITH_API}/api/v1/runs/query`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: [sessionId], is_root: true, limit: 5 }),
    });
    if (res.ok) {
      const { runs } = (await res.json()) as { runs: Array<{ id: string; start_time: string }> };
      const fresh = runs.find((r) => r.start_time > after);
      if (fresh) return fresh.id;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('no run appeared in LangSmith within 60s');
}

/**
 * Resolve the LangSmith project id, waiting for it to exist.
 *
 * LangSmith creates a project lazily, on its first trace. Looking it up before
 * the first run therefore fails with "no LangSmith project named ..." on a clean
 * account — which is exactly what happened the first time this ran, and reads as
 * a configuration error rather than an ordering one.
 */
async function sessionIdFor(apiKey: string, name: string): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = await fetch(`${LANGSMITH_API}/api/v1/sessions?name=${encodeURIComponent(name)}`, {
      headers: { 'x-api-key': apiKey },
    });
    if (res.ok) {
      const sessions = (await res.json()) as Array<{ id: string }>;
      if (sessions.length) return sessions[0]!.id;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `no LangSmith project named ${name} after 60s — the first run should have created it`
  );
}

async function main() {
  const apiKey = process.env.LANGCHAIN_API_KEY;
  if (!apiKey) throw new Error('LANGCHAIN_API_KEY is required');
  if (!process.env.ANTHROPIC_API_KEY && !process.env.BEDROCK_ENDPOINT) {
    throw new Error('ANTHROPIC_API_KEY is required — these traces must show a real model');
  }

  // Traces upload on a background queue that a short-lived process outruns.
  process.env.LANGCHAIN_TRACING_V2 = 'true';
  process.env.LANGCHAIN_CALLBACKS_BACKGROUND = 'false';
  process.env.LANGCHAIN_PROJECT = PROJECT;

  console.error(`provider: ${JSON.stringify(describeProvider())}`);
  console.error(`project:  ${PROJECT}`);

  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16').start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });

  try {
    await pool.query(readFileSync(join(API_DB, 'schema.sql'), 'utf8'));
    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`
    );
    for (const f of readdirSync(join(API_DB, 'migrations'))
      .filter((x) => x.endsWith('.sql'))
      .sort()) {
      await pool.query(readFileSync(join(API_DB, 'migrations', f), 'utf8'));
    }

    // Resolved lazily, AFTER the first run has created the project. Hoisting this
    // above the loop is what failed on the first attempt: the project does not
    // exist until something traces into it.
    let sessionId: string | undefined;

    const deps: GraphDeps = {
      db: pool,
      judge: makeJudge(),
      answer: makeAnswer(),
      act: makeShipAct(
        createShipClient({ baseUrl: 'http://ship.local', token: 'capture', fetchImpl: fakeShip })
      ),
    };

    const rows: Array<{ n: number; name: string; nodes: string[]; url: string }> = [];

    for (const c of CASES) {
      // A fresh workspace per case, so no case can suppress or contaminate another.
      const ws = await createWorkspace(pool, `tc${c.n}-${Date.now()}`);
      const input = await c.build(pool, ws);

      const before = new Date(Date.now() - 1000).toISOString();
      const graph = compileGraph(deps, new MemorySaver());
      const nodes: string[] = [];

      for await (const chunk of await graph.stream(input as never, {
        recursionLimit: 50,
        configurable: { thread_id: `tc:${c.n}:${ws.workspaceId}` },
      })) {
        for (const name of Object.keys(chunk as object)) nodes.push(name);
      }

      sessionId ??= await sessionIdFor(apiKey, PROJECT);
      const runId = await latestRunId(apiKey, sessionId, before);
      const url = await share(runId, apiKey);
      rows.push({ n: c.n, name: c.name, nodes, url });
      console.error(`  ${c.n}. ${c.name.padEnd(30)} ${nodes.length} nodes  ${url}`);
    }

    console.log('\n| # | Use case | Path | Trace |');
    console.log('|---|---|---|---|');
    for (const r of rows) {
      console.log(`| ${r.n} | ${r.name} | \`${r.nodes.join(' → ')}\` (${r.nodes.length}) | ${r.url} |`);
    }
  } finally {
    await pool.end();
    await container.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
