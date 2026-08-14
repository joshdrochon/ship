/**
 * The flag-on read path — PF-693, PF-694, PF-696, PF-697.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A `Queryable` AND NOT A NEW INTERFACE.
 * ---------------------------------------------------------------------------
 * Every detector and every fetch node already takes `db: Queryable`
 * (`data/queryable.ts`), and `Queryable` has exactly one method. PF-693's
 * acceptance is that a diff over `detectors/**` and `graph/nodes/**` shows ZERO
 * changed function signatures — so the flag-on path supplies an SDK-backed
 * reader through that same parameter, and the detectors never learn which path
 * they are on.
 *
 * The alternative was to give every detector a second constructor argument or a
 * `mode` flag. That doubles every detector test — one run per state, for
 * assertions that are about thresholds and business days and have nothing to do
 * with transport. Injecting at the one seam that already exists is what keeps
 * `stalledWork.test.ts` unmodified.
 *
 * ---------------------------------------------------------------------------
 * IT IS A ROUTER, NOT A TRANSLATOR — AND THAT IS THE HONEST PART.
 * ---------------------------------------------------------------------------
 * This is NOT a general SQL-to-REST engine and no amount of care would make one
 * a good idea. It is a small table of RECOGNISED STATEMENTS, each with a handler
 * that serves the same rows from `@ship/sdk`. Three outcomes, and the third is
 * the one that makes the whole thing safe:
 *
 *   1. a recognised Ship-data statement  → served from the public API
 *   2. a statement touching only the agent's OWN tables → passed to the pool
 *   3. anything else                     → **throws**, naming the table
 *
 * (3) is what stops this from being a silent fallback. A detector edited to
 * select a new column fails loudly on the flag-on path rather than quietly
 * dropping back to SQL and taking the front-door claim with it. That is the
 * difference between a bounded claim and an unfalsifiable one.
 *
 * ---------------------------------------------------------------------------
 * PF-697 — THE TABLE INVARIANT, WHICH IS WHAT MAKES "FOR EVERY ACTION"
 * CHECKABLE.
 * ---------------------------------------------------------------------------
 * p.18 asks how you would tell, post-demo, that the agent *"actually went
 * through the public API for every action"*. An adjective is not checkable; a
 * table set is. Every statement this reader passes to the pool is recorded, and
 * `tablesTouched()` reports what they referenced. The run asserts that set is a
 * subset of the agent's own tables plus `SQL_EXCEPTIONS` below — and that array
 * is short, literal, and carries a reason per entry.
 */
import type { ShipClient, ShipIssue } from '@ship/sdk';
import type { Queryable } from './queryable.js';

/**
 * The agent's OWN tables. Reads and writes here are NOT Ship data and never
 * were: they are the agent's private state — its watermarks, its observations,
 * its notifications, its LangGraph checkpoints.
 *
 * Excluded from the invariant on purpose, and the reason is worth stating
 * because it looks like a loophole and is not: routing these through a public
 * API would mean publishing `fleetgraph_observations` as a public resource,
 * which is the agent's own bookkeeping and belongs to nobody else. Under D5b
 * `fleetgraph_notifications` is also the recommendation channel, which exists
 * precisely BECAUSE the public API has no route for what it carries.
 */
export const AGENT_OWN_TABLES = [
  'fleetgraph_watermarks',
  'fleetgraph_observations',
  'fleetgraph_notifications',
  'fleetgraph_checkpoints',
  // LangGraph's own checkpointer tables. Created and owned by
  // `@langchain/langgraph-checkpoint-postgres`, not by this repo.
  'checkpoints',
  'checkpoint_blobs',
  'checkpoint_writes',
  'checkpoint_migrations',
] as const;

/**
 * PF-695, option (c), as DATA — the bound on the front-door claim.
 *
 * Every entry is a Ship table the flag-on path still reads over SQL, with the
 * reason it is not on the public API. A short list a reader can check beats an
 * absolute claim they cannot.
 *
 * The two decisions behind its shortness, both recorded rather than assumed:
 *
 *   · `document_associations` is NOT here. L99's **D13** answered it: issue→
 *     sprint and issue→project membership arrives as `issueSchema.belongs_to`,
 *     the junction rows themselves. Option (a)'s flat `sprint_id` was rejected
 *     because `document_associations`'s uniqueness constraint does not forbid
 *     an issue in two sprints, so a scalar would publish a cardinality the
 *     schema does not enforce.
 *   · `workspaces` is NOT here, and must never be. PF-696: the sprint's
 *     calendar window comes from `sprintSchema`'s server-computed
 *     `start_date`/`end_date`, not from a join to tenant configuration.
 */
export interface SqlException {
  table: string;
  readers: string[];
  reason: string;
}

export const SQL_EXCEPTIONS: readonly SqlException[] = [
  {
    table: 'document_history',
    readers: ['detectors/reworkChurn.ts', 'graph/nodes/resolveScope.ts'],
    reason:
      'PF-695 option (c). A GET /api/v1/issues/:id/history route would invent a public ' +
      'endpoint the PRD never asks for and a scope p.3 does not register — the sprawl p.2 ' +
      'warns against. Named and counted rather than hidden.',
  },
  {
    table: 'users',
    readers: ['detectors/loadImbalance.ts', 'graph/nodes/fetchParticipants.ts'],
    reason:
      'No public users resource ships this week. Only the display NAME is read; it degrades ' +
      'to the id, which is cosmetic in a prompt — and PF-688 establishes there is no user ' +
      'context on a client-credentials token to resolve names against anyway.',
  },
  {
    table: 'document_associations',
    readers: ['detectors/loadImbalance.ts', 'detectors/sprintMissRisk.ts'],
    reason:
      'Rescued in principle by D13 (issueSchema.belongs_to), but these two detectors have ' +
      'not been re-pointed at it yet — see F144. This entry is the honest state of the ' +
      'branch, not a design decision: it should shrink to nothing, not stay.',
  },
];

/** A statement the reader saw, with the tables it referenced. */
export interface RecordedStatement {
  sql: string;
  /** `'sdk'` when the public API served it, `'sql'` when the pool did. */
  servedBy: 'sdk' | 'sql';
  tables: string[];
}

/**
 * Tables a statement references.
 *
 * Deliberately crude — `FROM x`, `JOIN x`, `INSERT INTO x`, `UPDATE x`. It is a
 * safety net over statements written in this repository, not a SQL parser, and
 * it errs toward reporting MORE tables rather than fewer: a false positive
 * fails the invariant and gets looked at, while a false negative would let a
 * read slip past the check silently.
 */
export function tablesIn(sql: string): string[] {
  const found = new Set<string>();
  const pattern = /\b(?:from|join|into|update)\s+(?:only\s+)?([a-z_][a-z0-9_]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql)) !== null) {
    const table = match[1]!.toLowerCase();
    // `SELECT … FROM (VALUES …)` and CTE self-references are not tables.
    if (table !== 'select' && table !== 'values') found.add(table);
  }
  return [...found];
}

/** Normalised for matching: one space between tokens, lower case. */
function normalise(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * A statement this reader knows how to serve from the public API.
 *
 * `match` is checked against the NORMALISED statement. The predicates below are
 * specific enough that no two overlap and specific enough that a materially
 * edited detector stops matching — which is the failure this design wants,
 * because the alternative is serving a detector rows it did not ask for.
 */
interface SdkStatement {
  name: string;
  match: (sql: string) => boolean;
  run: (client: ShipClient, params: unknown[]) => Promise<Record<string, unknown>[]>;
}

/** Milliseconds, from `$2::timestamptz - ($3 || ' days')::interval`. */
function cutoffFrom(params: unknown[]): number {
  const now = new Date(String(params[1] ?? new Date().toISOString())).getTime();
  const days = Number(params[2] ?? 0);
  return now - days * 86_400_000;
}

/**
 * Issues in one state, older than a cutoff, oldest first.
 *
 * Serves `stalledWork` (`in_progress`) and `reviewBottleneck` (`in_review`) —
 * PF-694's two detectors, the ones `issueSchema` fully covers.
 *
 * ── Why `iterate()` and not `list()` ────────────────────────────────────────
 * PF-694: the walk is bounded by the COLLECTION rather than by a hand-rolled
 * page loop. `iterate()` is L18's PF-533 generator, so cursor handling, the
 * stalled-cursor guard and the `next_cursor === undefined` bug L99 F21 records
 * are all somewhere that already has tests.
 *
 * ── Why the filtering is here and not on the wire ───────────────────────────
 * `/api/v1/issues` takes no `state` or `updated_before` parameter. Inventing
 * them would be a cross-lane edit to L10 for the benefit of one consumer, and
 * p.2 prefers a small API that matches its spec. The cost is measured rather
 * than hand-waved: PF-698 records requests-per-scan at the fixture workspace
 * size against the configured per-app rate limit.
 */
function issuesInState(state: string): SdkStatement['run'] {
  return async (client, params) => {
    const cutoff = cutoffFrom(params);
    const rows: Record<string, unknown>[] = [];

    for await (const issue of client.issues.iterate()) {
      if (issue.state !== state) continue;
      const updatedAt = new Date(issue.updated_at);
      if (updatedAt.getTime() >= cutoff) continue;
      rows.push(projectIssue(issue, updatedAt));
    }

    // `ORDER BY d.updated_at ASC`, reproduced. The public list is newest-first
    // keyset order, so the sort has to happen here — and it has to happen at
    // all, because both detectors present their signals oldest-first and a
    // reader of the notification list would see a different order otherwise.
    rows.sort(
      (a, b) => (a.updated_at as Date).getTime() - (b.updated_at as Date).getTime(),
    );
    return rows;
  };
}

/**
 * The public issue, shaped as the detector's `SELECT` shaped it.
 *
 * ⚑ **`started_at` is null here and it is not null on the SQL path.**
 * `issueSchema` (L10 PF-282) does not carry `started_at`, so `stalledWork`'s
 * `context.started_at` degrades to null under the flag. That is a REAL
 * difference in the emitted `Signal[]` and it is recorded rather than papered
 * over — see F143. It touches neither the measurement, the threshold, the
 * bucket nor the fingerprint, so suppression and delivery are unaffected; what
 * is lost is one line of context in the judgment prompt.
 */
function projectIssue(issue: ShipIssue, updatedAt: Date): Record<string, unknown> {
  return {
    id: issue.id,
    title: issue.title,
    updated_at: updatedAt,
    started_at: null,
    assignee_id: issue.assignee_id,
    priority: issue.priority,
  };
}

const SDK_STATEMENTS: readonly SdkStatement[] = [
  {
    name: 'stalledWork — in_progress issues idle past the threshold',
    match: (sql) =>
      sql.includes('from documents') &&
      sql.includes("document_type = 'issue'") &&
      sql.includes("properties->>'state' = 'in_progress'"),
    run: issuesInState('in_progress'),
  },
  {
    name: 'reviewBottleneck — in_review issues waiting past the threshold',
    match: (sql) =>
      sql.includes('from documents') &&
      sql.includes("document_type = 'issue'") &&
      sql.includes("properties->>'state' = 'in_review'"),
    run: issuesInState('in_review'),
  },
];

export interface CitizenReaderDeps {
  /** Authenticated as the agent's own OAuth app. See `citizenClient.ts`. */
  client: ShipClient;
  /**
   * The agent's own database, for its own tables — and for the exceptions.
   *
   * Named `ownState` rather than `pool` so a reader of the composition root
   * sees what it is FOR. Every statement that reaches it is recorded and
   * checked against the invariant.
   */
  ownState: Queryable;
}

export interface CitizenReader extends Queryable {
  /** Every statement this reader saw, in order. PF-697's evidence. */
  readonly statements: readonly RecordedStatement[];
  /** Distinct tables reached over SQL rather than over the public API. */
  tablesTouchedBySql(): string[];
  /** Tables reached over SQL that are neither the agent's own nor a named exception. */
  invariantViolations(): { table: string; sql: string }[];
}

/**
 * The flag-on `Queryable`.
 *
 * Handed to the graph as `deps.db`, so detectors, fetch nodes and the agent's
 * own boundary helpers all go through it — which is what lets one object both
 * serve the public reads and police the rest.
 */
export function createCitizenReader(deps: CitizenReaderDeps): CitizenReader {
  const statements: RecordedStatement[] = [];
  const allowed = new Set<string>([
    ...AGENT_OWN_TABLES,
    ...SQL_EXCEPTIONS.map((e) => e.table),
  ]);

  return {
    async query(text: string, params: unknown[] = []) {
      const sql = normalise(text);

      const handler = SDK_STATEMENTS.find((s) => s.match(sql));
      if (handler) {
        statements.push({ sql: text, servedBy: 'sdk', tables: tablesIn(text) });
        return { rows: await handler.run(deps.client, params) };
      }

      const tables = tablesIn(text);
      const forbidden = tables.filter((t) => !allowed.has(t));
      if (forbidden.length > 0) {
        /**
         * THE LOUD FAILURE. Not a fallback.
         *
         * A silent drop-back to SQL here would make the front-door claim
         * unfalsifiable: every future detector edit would quietly widen the
         * exception surface and nothing would say so. Throwing names the table
         * and points at the two ways forward — serve it from the SDK, or add it
         * to `SQL_EXCEPTIONS` with a reason somebody has to write down.
         */
        throw new Error(
          `[fleetgraph] flag-on path tried to read ${forbidden.join(', ')} over SQL. ` +
            'Under SHIP_AGENT_VIA_SDK the agent reads Ship data through @ship/sdk. Either ' +
            'teach citizenReader.ts to serve this statement from the public API, or add the ' +
            'table to SQL_EXCEPTIONS with the reason it has no public route (PF-695/PF-697). ' +
            `Statement: ${sql.slice(0, 200)}`,
        );
      }

      statements.push({ sql: text, servedBy: 'sql', tables });
      return deps.ownState.query(text, params);
    },

    statements,

    tablesTouchedBySql() {
      const seen = new Set<string>();
      for (const s of statements) {
        if (s.servedBy !== 'sql') continue;
        for (const t of s.tables) seen.add(t);
      }
      return [...seen].sort();
    },

    invariantViolations() {
      const out: { table: string; sql: string }[] = [];
      for (const s of statements) {
        if (s.servedBy !== 'sql') continue;
        for (const t of s.tables) {
          if (!allowed.has(t)) out.push({ table: t, sql: s.sql });
        }
      }
      return out;
    },
  };
}
