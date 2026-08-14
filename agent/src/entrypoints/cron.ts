/**
 * The proactive entrypoint. Render runs this every three minutes.
 *
 * ── What "every three minutes" has to survive ──────────────────────────────
 * A cron container starts, does its work, and exits. It has no memory, no warm
 * pool, and no chance to retry later — the next run is a different process.
 * Everything about this file follows from that:
 *
 *   - the watermark advances only inside the graph, on completion (Q24), so a
 *     crash here re-covers the same window rather than losing it
 *   - an advisory lock stops two runs colliding, since a slow scan and the next
 *     schedule tick can overlap
 *   - a hard deadline, because a hung run holds its lock and blocks every
 *     subsequent tick — a silent outage that looks like a healthy quiet project
 *   - a non-zero exit, so Render reports the failure instead of the run
 *     vanishing into a log nobody reads
 *
 * ── Why it exits non-zero rather than retrying in place ────────────────────
 * A retry loop inside a cron job re-implements the scheduler badly, and the
 * scheduler is already running. Exiting non-zero surfaces the failure where
 * someone will see it, and the next tick is three minutes away.
 *
 * ── Why the run is bounded at 4 minutes on a 3-minute schedule ─────────────
 * PRESEARCH.md Q30 budgets 217s worst case. Four minutes leaves headroom above
 * that and still guarantees a wedged run is dead before two more ticks pile up
 * behind it. It is a backstop for a hang, not a performance target.
 */
import { getPool, closePool } from '../data/pool.js';
import {
  compileGraph,
  proactiveThreadId,
  type GraphDeps,
  type ProposedAction,
} from '../graph/index.js';
import { getCheckpointer } from '../graph/checkpointer.js';
import { makeJudge, makeAnswer, describeProvider } from '../llm/index.js';
import { makeShipAct, makeRecommendAct } from '../actions/index.js';
import { agentViaSdk, AGENT_VIA_SDK_ENV_VAR } from '../composition.js';
import { createCitizenReader } from '../data/citizenReader.js';
import { authenticateAsAgent, resolveAgentCredentials } from '../data/citizenClient.js';
import { ensureSynchronousCallbacks, logTracingStatus } from '../observability/tracing.js';

/** Backstop for a hang, not a performance target. See the header. */
const RUN_DEADLINE_MS = 4 * 60_000;

/**
 * Without a Ship API token there is nothing to act with, and the run says so
 * rather than failing.
 *
 * Refusing costs the comment, not the finding — the notification is the primary
 * delivery channel and goes out regardless. A stub returning `ok: true` would
 * be worse in the one way that matters: the trace would claim an action
 * happened.
 */
const refuseToAct = async (action: ProposedAction) => ({
  ok: false,
  detail: `SHIP_API_TOKEN not set — ${action.kind} on ${action.targetId} not performed`,
});

/**
 * The real action client, when the environment can support one.
 *
 * Resolved per run rather than at module load so a missing token degrades this
 * single capability instead of killing the process before any detection
 * happens. Detection is the valuable half; commenting is the garnish.
 */
/**
 * L23 PF-693 — the read seam.
 *
 * Flag-off returns the pooled client untouched. Flag-on authenticates as the
 * agent's own OAuth app and wraps it, so Ship data comes from `@ship/sdk` and
 * the agent's own tables still come from Postgres.
 *
 * It THROWS when the flag is on and the credential is absent, rather than
 * degrading to SQL. A silent degrade would be the worst possible outcome for
 * this lane: the run would succeed, every finding would be delivered, and the
 * audit trail Epic 7 is graded on would be empty — with nothing anywhere saying
 * why. Failing here names the missing variable.
 */
async function resolveReader(client: GraphDeps['db']): Promise<GraphDeps['db']> {
  if (!agentViaSdk()) return client;

  const credentials = resolveAgentCredentials();
  if (!credentials) {
    throw new Error(
      `[fleetgraph] ${AGENT_VIA_SDK_ENV_VAR} is on but AGENT_CLIENT_SECRET is not set. ` +
        'The rewired agent authenticates as its own first-party OAuth app (Client ' +
        'Credentials, RFC 6749 §4.4) and has no other way in. Set AGENT_CLIENT_SECRET — ' +
        'the same variable db:migrate seeds the app from — or turn the flag off.',
    );
  }

  return createCitizenReader({
    client: await authenticateAsAgent(credentials),
    ownState: client,
  });
}

function resolveAct(db: GraphDeps['db']) {
  // ── L23 PF-704 — the ONE read of the flag, at the composition root ────────
  //
  // Resolved here and passed down, never consulted again. `agentViaSdk()` is
  // the only function that touches `process.env.SHIP_AGENT_VIA_SDK` in the
  // whole package, and `flagSite.test.ts` greps to keep it that way.
  if (agentViaSdk()) {
    // D5b. No Ship write path exists for this agent, so `comment` and
    // `history_note` become recommendations in `fleetgraph_notifications` —
    // its own table, reached over the same connection the graph already has.
    //
    // Note what is NOT checked here: `SHIP_API_TOKEN`. The read-only path
    // needs no Ship credential to deliver a recommendation, so a deployment
    // running flag-on with no token still surfaces its findings. That is a
    // genuine improvement and it is the only one D5b buys for free.
    return makeRecommendAct({ db });
  }

  if (!process.env.SHIP_API_TOKEN) return refuseToAct;
  try {
    return makeShipAct();
  } catch (err) {
    console.error(
      '[fleetgraph] action client unavailable:',
      err instanceof Error ? err.message : err
    );
    return refuseToAct;
  }
}

export interface CronResult {
  workspaceId: string;
  outcome: string | null;
  signals: number;
  findings: number;
  errors: string[];
  ms: number;
  skipped?: 'locked';
}

/**
 * Scan one workspace.
 *
 * The advisory lock is per workspace and session-scoped, which is why it takes
 * a dedicated client rather than going through the pool: a lock acquired on one
 * pooled connection and released on another is not a lock.
 *
 * `pg_try_advisory_lock` rather than `pg_advisory_lock` — a run that cannot get
 * the lock should exit immediately and let the holder finish, not queue up
 * behind it. Queueing is how three-minute ticks turn into a pile of blocked
 * processes (FG-113).
 */
export async function scanWorkspace(
  workspaceId: string,
  deps: Omit<GraphDeps, 'db'> & { db?: GraphDeps['db'] } = {} as never
): Promise<CronResult> {
  const started = Date.now();
  const pool = getPool();
  const client = await pool.connect();

  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS got', [
      `fleetgraph:${workspaceId}`,
    ]);

    if (!rows[0]?.got) {
      return {
        workspaceId,
        outcome: null,
        signals: 0,
        findings: 0,
        errors: [],
        ms: Date.now() - started,
        skipped: 'locked',
      };
    }

    try {
      const checkpointer = await getCheckpointer();

      // ── L23 PF-693 — the read seam, resolved once ────────────────────────
      //
      // Flag-off: the pooled client, exactly as Part 2 shipped it.
      // Flag-on:  a `CitizenReader` over the SAME `Queryable` interface, which
      //           serves Ship data from `@ship/sdk` and passes the agent's own
      //           tables through to that same client.
      //
      // The detectors and fetch nodes take `db: Queryable` either way and never
      // learn which they got. That is the entire reason the seam is here and
      // not inside each detector.
      //
      // A flag-on run with no credential FAILS rather than falling back. A
      // silent fallback is how "the agent went through the front door" becomes
      // a claim nobody can check — the whole run would read from SQL and every
      // audit assertion would pass vacuously, because there would be no rows to
      // contradict.
      const db = deps.db ?? (await resolveReader(client));

      const graph = compileGraph(
        {
          db,
          judge: deps.judge ?? makeJudge(),
          answer: deps.answer ?? makeAnswer(),
          act: deps.act ?? resolveAct(client),
          now: deps.now,
        },
        checkpointer
      );

      // The checkpointer requires a thread id, and this is the one the
      // approval endpoint will resume — `awaitApproval` reads it back out of
      // the runtime config rather than inventing a parallel one.
      //
      // Per run rather than per workspace: a single long-lived thread would
      // mean the next scan resumes a thread still suspended at an approval and
      // immediately re-interrupts it, tangling two runs together.
      const startedAt = new Date();
      const final = await graph.invoke(
        { mode: 'proactive', scope: { workspaceId } } as never,
        {
          recursionLimit: 50,
          configurable: { thread_id: proactiveThreadId(workspaceId, startedAt) },
        }
      );

      return {
        workspaceId,
        outcome: final.outcome ?? null,
        signals: final.signals?.length ?? 0,
        findings: final.findings?.length ?? 0,
        errors: final.errors ?? [],
        ms: Date.now() - started,
      };
    } finally {
      // Released explicitly rather than left to session teardown. The client
      // goes back to the pool and could be handed to the next scan still
      // holding it.
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`fleetgraph:${workspaceId}`]);
    }
  } finally {
    client.release();
  }
}

/** Every workspace worth scanning. Archived ones are not. */
export async function listWorkspaces(): Promise<string[]> {
  const { rows } = await getPool().query(
    `SELECT id FROM workspaces WHERE archived_at IS NULL ORDER BY created_at`
  );
  return rows.map((r) => r.id as string);
}

/**
 * One line per run, structured (FG-114).
 *
 * JSON rather than prose because the thing you will want six weeks from now is
 * "how often did we spend tokens" and "how long is a scan taking", and neither
 * is greppable out of a sentence. `outcome` is the field that answers both:
 * `quiet_no_signals` means the run cost nothing.
 */
function logRun(r: CronResult): void {
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      event: 'fleetgraph.scan',
      workspace: r.workspaceId,
      outcome: r.skipped ?? r.outcome,
      signals: r.signals,
      findings: r.findings,
      ms: r.ms,
      ...(r.errors.length ? { errors: r.errors } : {}),
    })
  );
}

export async function main(): Promise<number> {
  const deadline = setTimeout(() => {
    console.error(
      `[fleetgraph] run exceeded ${RUN_DEADLINE_MS}ms — exiting so the next tick is not blocked`
    );
    process.exit(2);
  }, RUN_DEADLINE_MS);
  // Do not hold the event loop open on the deadline itself.
  deadline.unref?.();

  let failed = false;

  // Order matters. A cron container exits the moment the scan ends, and
  // LangChain uploads traces on a background queue that dies with the process —
  // so without this the run is correct and LangSmith stays empty forever.
  ensureSynchronousCallbacks();

  // Once per process, before any work. An empty LangSmith project and a graph
  // that never ran look identical from the outside; this says which it is.
  logTracingStatus();

  // Same argument, one layer down. A run that surfaced nothing because the
  // project is calm and a run that surfaced nothing because there was no model
  // credential produce the same output — no findings, no notification. That
  // ambiguity is what let the deployed cron sit inert with every layer
  // behaving as designed. This line names the provider before the ambiguity
  // can arise.
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      event: 'fleetgraph.model',
      ...describeProvider(),
    })
  );

  try {
    // A single workspace can be targeted, which is what makes a timed latency
    // test (FG-209) and local verification possible without scanning
    // everything.
    const only = process.env.FLEETGRAPH_WORKSPACE_ID;
    const workspaces = only ? [only] : await listWorkspaces();

    if (workspaces.length === 0) {
      console.log(
        JSON.stringify({ at: new Date().toISOString(), event: 'fleetgraph.scan', workspaces: 0 })
      );
      return 0;
    }

    for (const workspaceId of workspaces) {
      try {
        const result = await scanWorkspace(workspaceId);
        logRun(result);
        // Degrade per workspace: one workspace's errors must not stop the
        // others being scanned. They are still reported.
        if (result.errors.length) failed = true;
      } catch (err) {
        failed = true;
        console.error(
          JSON.stringify({
            at: new Date().toISOString(),
            event: 'fleetgraph.scan.failed',
            workspace: workspaceId,
            error: err instanceof Error ? err.message : String(err),
          })
        );
      }
    }

    return failed ? 1 : 0;
  } catch (err) {
    console.error(
      '[fleetgraph] cron failed:',
      err instanceof Error ? (err.stack ?? err.message) : err
    );
    return 1;
  } finally {
    clearTimeout(deadline);
    await closePool();
  }
}

// Run when invoked directly, not when imported by a test.
if (process.argv[1]?.endsWith('cron.js') || process.argv[1]?.endsWith('cron.ts')) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[fleetgraph] unhandled:', err);
      process.exit(1);
    });
}
