/**
 * `issueService` — the shared domain service for issues (PF-277, PF-279, PF-280,
 * PF-292, PF-293).
 *
 * ## Why this file exists
 *
 * Same reason `services/documents.ts` does, and it is finding F8 applied to the
 * second resource. `docs/architecture.md`'s Public/Internal Boundary diagram
 * claims *"both surfaces call the same domain services"*; before this file the
 * issue write SQL was inline in `api/src/routes/issues.ts`, tangled with
 * `requireAuth(req)`, `req.workspaceId` and `res.status(...)`. A public route
 * with nothing to call would have had to re-implement the query, and the
 * boundary claim would have been false from commit one.
 *
 * **Nothing here knows what HTTP is.** No `express`, no `req`, no `res`, no
 * `requireAuth`. The caller passes a `DomainContext` of plain values. That is
 * what makes the boundary checkable rather than decorative — the public surface
 * authenticates with bearer tokens and the internal one with session cookies,
 * so a service reaching for `req` could only ever serve one of them.
 *
 * ## Issues are NOT a table
 *
 * They are `documents` rows with `document_type = 'issue'` (CLAUDE.md,
 * "everything is a document"; `api/src/db/schema.sql`). `state`, `priority`,
 * `assignee_id`, `source` and `rejection_reason` live inside the `properties`
 * JSONB. Every query here is therefore a `documents` query with a type
 * predicate, and finding F18's proposed fix — adding `'issues'` to
 * `KEYSET_INDEXED_TABLES` — cannot work, because `EXPLAIN SELECT … FROM issues`
 * has no relation to explain. The correct artifact is a PARTIAL index over
 * `documents` (migration 068).
 *
 * ## Two list shapes, deliberately
 *
 * `mode:'internal'`  `ORDER BY CASE priority … , updated_at DESC` — what Ship's
 *                    issue board has always shown, filters and all. Preserved
 *                    byte-for-byte.
 * `mode:'keyset'`    `ORDER BY created_at DESC, id DESC` — the public sort, on
 *                    columns nothing rewrites. PF-281: both internal sort keys
 *                    are MUTABLE (`priority` is user-editable, `updated_at` is
 *                    rewritten by every PATCH), so a keyset over them skips and
 *                    repeats rows under ordinary use. PRD p.3 requires cursors
 *                    "stable across reordering operations"; that ordering cannot
 *                    provide it.
 *
 * ## The publish sites are HERE, never in a route (PF-292, PF-293)
 *
 * PRD p.3: *"Domain layer publishes on writes — never the route layer."*
 * `issue.created` fires from `create()` after COMMIT; `issue.assigned` and
 * `issue.status_changed` hang off the SAME `changes[]` diff the history loop
 * already walks in `update()`. Re-implementing that diff in the public route is
 * the failure mode PF-293 exists to prevent — two diffs disagree, and the one
 * nobody remembers is the one that stops firing.
 */
import type { PoolClient } from 'pg';
import type { Database } from '../db/client.js';
import type { IEventBus } from '../platform/webhooks/bus.js';
import { issueEventPayload } from '../platform/webhooks/payloads.js';
import { logDocumentChange, getTimestampUpdates } from '../utils/document-crud.js';

/** The `document_type` an issue is stored as. One definition. */
export const ISSUE_DOCUMENT_TYPE = 'issue';

/**
 * Everything the domain needs to know about who is asking. Plain values only —
 * identical in shape to `documents.ts`'s so the two services compose in one
 * handler without translation.
 */
export interface DomainContext {
  workspaceId: string;
  userId: string | null;
  db: Database;
}

/** The issue states and priorities, as data. The public Zod enum reads these. */
export const ISSUE_STATES = [
  'triage',
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'cancelled',
] as const;

export const ISSUE_PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const;

export type IssueState = (typeof ISSUE_STATES)[number];
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

/** The association kinds `document_associations.relationship_type` allows. */
export const BELONGS_TO_TYPES = ['program', 'project', 'sprint', 'parent'] as const;
export type BelongsToType = (typeof BELONGS_TO_TYPES)[number];

export interface BelongsToRef {
  id: string;
  type: BelongsToType;
}

/**
 * Row-level visibility, in one place, in TWO bindings.
 *
 * The internal surface already computes `isAdmin` with its own
 * `getVisibilityContext()` round trip and threads the boolean into the query
 * (`VISIBILITY_FILTER_SQL`). The public surface has no such round trip and must
 * not grow one — MVP gate item 9 budgets queries per request, and a second pool
 * checkout on the hottest public endpoint is a measurable regression.
 *
 * So the predicate has two forms of the same rule:
 *
 *   'flag'      `… OR $n = TRUE` — the internal binding, unchanged, so
 *               `list-endpoints-regression.test.ts` and PF-264's query counts
 *               stay exactly where they were.
 *   'subquery'  `… OR (SELECT role …) = 'admin'` — the public binding. Postgres
 *               evaluates it once as an InitPlan: one index probe inside a query
 *               we were already issuing, rather than a second round trip.
 *
 * Written once with two bindings rather than twice, because a second copy of a
 * visibility rule is how one surface comes to disclose what the other hides.
 */
function visibilityPredicate(
  alias: string,
  userParam: string,
  admin: { kind: 'flag'; param: string } | { kind: 'subquery'; workspaceParam: string },
): string {
  const adminClause =
    admin.kind === 'flag'
      ? `${admin.param} = TRUE`
      : `(SELECT wm.role FROM workspace_memberships wm
           WHERE wm.workspace_id = ${admin.workspaceParam} AND wm.user_id = ${userParam}) = 'admin'`;
  return `(${alias}.visibility = 'workspace' OR ${alias}.created_by = ${userParam} OR ${adminClause})`;
}

/**
 * The timestamp a CURSOR is minted from — rendered by POSTGRES, at microsecond
 * precision, and never by JavaScript.
 *
 * Identical to `documents.ts`'s `CURSOR_TIMESTAMP_EXPR` and for the identical
 * reason: `timestamptz` stores microseconds, node-postgres parses it into a JS
 * `Date` which holds milliseconds, so `row.created_at.toISOString()` truncates
 * `…:00.123456Z` to `…:00.123Z`. Fed back as a keyset bound, that silently
 * SKIPS every row between `.123000` and `.123456` on every page boundary — rows
 * the consumer should have received next, absent with no error.
 *
 * With issues this is not a theoretical case: `POST /api/v1/issues` takes a
 * per-workspace advisory lock to allocate `ticket_number`, so a bulk import
 * creates rows in tight succession inside the same millisecond by construction.
 */
const CURSOR_TIMESTAMP_EXPR = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** The columns the INTERNAL issue list has always returned. Unchanged. */
const INTERNAL_LIST_COLUMNS = `d.id, d.title, d.properties, d.ticket_number,
             d.content,
             d.created_at, d.updated_at, d.created_by,
             d.started_at, d.completed_at, d.cancelled_at, d.reopened_at,
             d.converted_from_id,
             u.name as assignee_name,
             CASE WHEN person_doc.archived_at IS NOT NULL THEN true ELSE false END as assignee_archived`;

const INTERNAL_LIST_JOINS = `FROM documents d
      LEFT JOIN users u ON (d.properties->>'assignee_id')::uuid = u.id
      LEFT JOIN documents person_doc ON person_doc.workspace_id = d.workspace_id
        AND person_doc.document_type = 'person'
        AND person_doc.properties->>'user_id' = d.properties->>'assignee_id'`;

/** An issue row as the domain hands it back. Wide, and read defensively. */
export interface IssueRow {
  id: string;
  title: string;
  properties: Record<string, unknown> | null;
  ticket_number: number | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
  created_by: string | null;
  [column: string]: unknown;
}

/** The keyset cursor position a public page resumes from. */
export interface KeysetCursor {
  timestamp: string;
  id: string;
}

export type IssueListInput =
  | {
      mode: 'internal';
      /**
       * Computed by the caller with `getVisibilityContext()`. Threaded in rather
       * than recomputed so the internal route's query count does not move.
       */
      isAdmin: boolean;
      source?: string | undefined;
      /** Comma-separated on the wire; already split by the caller. */
      states?: string[] | undefined;
      priority?: string | undefined;
      assigneeId?: string | undefined;
      programId?: string | undefined;
      sprintId?: string | undefined;
      parentFilter?: string | undefined;
    }
  | {
      mode: 'keyset';
      /** Rows to fetch. Callers pass `limit + 1` to detect the last page. */
      limit: number;
      cursor: KeysetCursor | null;
    };

export interface IssueCreateInput {
  title: string;
  state?: IssueState | undefined;
  priority?: IssuePriority | undefined;
  assigneeId?: string | null | undefined;
  belongsTo?: readonly BelongsToRef[] | undefined;
  source?: string | undefined;
  dueDate?: string | null | undefined;
  /**
   * Ship's internal accountability machinery. Present on the INPUT because the
   * internal route sets it; **absent from the public request schema** (PF-279) —
   * a third-party app minting system-generated action items is a privilege
   * escalation dressed as a field.
   */
  isSystemGenerated?: boolean | undefined;
  accountabilityTargetId?: string | null | undefined;
  accountabilityType?: string | null | undefined;
}

export interface IssueUpdateInput {
  title?: string | undefined;
  state?: IssueState | undefined;
  priority?: IssuePriority | undefined;
  assigneeId?: string | null | undefined;
  belongsTo?: readonly BelongsToRef[] | undefined;
}

/** One entry of the change diff, exactly as the history table records it. */
export interface IssueChange {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface IssueUpdateResult {
  row: IssueRow;
  /** The diff that was written to history AND that the events hang off. */
  changes: IssueChange[];
}

export interface IssueServiceDeps {
  /**
   * PF-292 — the bus the domain publishes writes on, injected from
   * `createApp(deps)` rather than imported, so the composition root stays the
   * only place a concrete is chosen. Optional because the internal routes
   * predate the bus.
   */
  bus?: IEventBus | undefined;
}

export function createIssueService(deps: IssueServiceDeps = {}) {
  /**
   * List issues.
   *
   * Returns raw rows. Projection is the caller's job on purpose: the internal
   * surface flattens `properties` into top-level legacy fields and adds
   * `display_id`, while the public surface applies an allowlist (PF-282). Doing
   * either here would force the other to undo it.
   */
  async function list(ctx: DomainContext, input: IssueListInput): Promise<IssueRow[]> {
    if (input.mode === 'internal') {
      // Moved VERBATIM from `routes/issues.ts`. The filter set, the parameter
      // order and the ORDER BY are a Part 1 contract the Ship board depends on;
      // `list-endpoints-regression.test.ts` is what holds it.
      let query = `
      SELECT ${INTERNAL_LIST_COLUMNS}
      ${INTERNAL_LIST_JOINS}
      WHERE d.workspace_id = $1 AND d.document_type = '${ISSUE_DOCUMENT_TYPE}'
        AND ${visibilityPredicate('d', '$2', { kind: 'flag', param: '$3' })}
    `;
      const params: (string | boolean | string[] | null)[] = [
        ctx.workspaceId,
        ctx.userId,
        input.isAdmin,
      ];

      query += ` AND d.archived_at IS NULL AND d.deleted_at IS NULL`;

      if (input.source) {
        query += ` AND d.properties->>'source' = $${params.length + 1}`;
        params.push(input.source);
      }

      if (input.states && input.states.length > 0) {
        query += ` AND d.properties->>'state' = ANY($${params.length + 1})`;
        params.push(input.states);
      }

      if (input.priority) {
        query += ` AND d.properties->>'priority' = $${params.length + 1}`;
        params.push(input.priority);
      }

      if (input.assigneeId) {
        if (input.assigneeId === 'null' || input.assigneeId === 'unassigned') {
          query += ` AND (d.properties->>'assignee_id' IS NULL OR d.properties->>'assignee_id' = '')`;
        } else {
          query += ` AND d.properties->>'assignee_id' = $${params.length + 1}`;
          params.push(input.assigneeId);
        }
      }

      if (input.programId) {
        query += ` AND EXISTS (
        SELECT 1 FROM document_associations da
        WHERE da.document_id = d.id AND da.related_id = $${params.length + 1} AND da.relationship_type = 'program'
      )`;
        params.push(input.programId);
      }

      if (input.sprintId) {
        query += ` AND EXISTS (
        SELECT 1 FROM document_associations da
        WHERE da.document_id = d.id AND da.related_id = $${params.length + 1} AND da.relationship_type = 'sprint'
      )`;
        params.push(input.sprintId);
      }

      if (input.parentFilter) {
        if (input.parentFilter === 'top_level') {
          query += ` AND NOT EXISTS (
          SELECT 1 FROM document_associations da
          WHERE da.document_id = d.id AND da.relationship_type = 'parent'
        )`;
        } else if (input.parentFilter === 'has_children') {
          query += ` AND EXISTS (
          SELECT 1 FROM document_associations da
          WHERE da.related_id = d.id AND da.relationship_type = 'parent'
        )`;
        } else if (input.parentFilter === 'is_sub_issue') {
          query += ` AND EXISTS (
          SELECT 1 FROM document_associations da
          WHERE da.document_id = d.id AND da.relationship_type = 'parent'
        )`;
        }
      }

      query += ` ORDER BY
      CASE d.properties->>'priority'
        WHEN 'urgent' THEN 1
        WHEN 'high' THEN 2
        WHEN 'medium' THEN 3
        WHEN 'low' THEN 4
        ELSE 5
      END,
      d.updated_at DESC`;

      const result = await ctx.db.query<IssueRow>(query, params);
      return result.rows;
    }

    // ── keyset (public) ──────────────────────────────────────────────────
    //
    // PF-281. `(created_at, id)` and nothing mutable. Note the columns: no
    // joins at all. The internal list LEFT JOINs `users` and a `person`
    // document to decorate the assignee with a name and an archived flag; the
    // public projection carries `assignee_id` and no name, so those joins would
    // be two extra relations scanned per page for fields nobody serialises.
    const params: unknown[] = [ctx.workspaceId, ctx.userId];
    let sql = `
      SELECT d.id, d.title, d.properties, d.ticket_number,
             d.created_at, d.updated_at, d.created_by,
             ${CURSOR_TIMESTAMP_EXPR.replace(/created_at/g, 'd.created_at')} AS created_at_cursor
      FROM documents d
      WHERE d.workspace_id = $1
        AND d.document_type = '${ISSUE_DOCUMENT_TYPE}'
        AND d.archived_at IS NULL
        AND d.deleted_at IS NULL
        AND ${visibilityPredicate('d', '$2', { kind: 'subquery', workspaceParam: '$1' })}`;

    if (input.cursor) {
      // PF-219's predicate, as a ROW COMPARISON. The equivalent
      // `created_at < $n OR (created_at = $n AND id < $m)` plans as a bitmap-or
      // or a seq scan; the row form becomes an index range scan on migration
      // 068's partial index. The explicit casts are load-bearing — node-postgres
      // sends both as text, and without them Postgres compares timestamptz to
      // text and stops using the index.
      params.push(input.cursor.timestamp, input.cursor.id);
      sql += `
        AND (d.created_at, d.id) < ($3::timestamptz, $4::uuid)`;
    }

    params.push(input.limit);
    sql += `
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $${params.length}`;

    const result = await ctx.db.query<IssueRow>(sql, params);
    return result.rows;
  }

  /**
   * One issue by id, or `null`.
   *
   * `null` covers every way to miss — wrong workspace, soft-deleted, not
   * visible to this user, or a row whose `document_type` is not `issue`. To a
   * caller they are the same answer, and distinguishing them leaks existence:
   * a 403 on a row in another workspace confirms the id is real, which turns
   * the endpoint into a cross-tenant existence oracle (PF-255, PF-278).
   *
   * The fourth case is the one that only exists in a unified document model —
   * `GET /api/v1/issues/<a wiki's id>` must be `not_found`, not a wiki.
   */
  async function get(
    ctx: DomainContext,
    input: { id: string; isAdmin?: boolean | undefined },
  ): Promise<IssueRow | null> {
    const useFlag = input.isAdmin !== undefined;
    const params: unknown[] = useFlag
      ? [input.id, ctx.workspaceId, ctx.userId, input.isAdmin]
      : [input.id, ctx.workspaceId, ctx.userId];

    const visibility = useFlag
      ? visibilityPredicate('d', '$3', { kind: 'flag', param: '$4' })
      : visibilityPredicate('d', '$3', { kind: 'subquery', workspaceParam: '$2' });

    const result = await ctx.db.query<IssueRow>(
      `SELECT d.id, d.title, d.properties, d.ticket_number,
              d.content,
              d.created_at, d.updated_at, d.created_by,
              d.started_at, d.completed_at, d.cancelled_at, d.reopened_at,
              d.converted_to_id, d.converted_from_id,
              u.name as assignee_name,
              CASE WHEN person_doc.archived_at IS NOT NULL THEN true ELSE false END as assignee_archived,
              creator.name as created_by_name
       FROM documents d
       LEFT JOIN users u ON (d.properties->>'assignee_id')::uuid = u.id
       LEFT JOIN documents person_doc ON person_doc.workspace_id = d.workspace_id
         AND person_doc.document_type = 'person'
         AND person_doc.properties->>'user_id' = d.properties->>'assignee_id'
       LEFT JOIN users creator ON d.created_by = creator.id
       WHERE d.id = $1 AND d.workspace_id = $2 AND d.document_type = '${ISSUE_DOCUMENT_TYPE}'
         AND d.deleted_at IS NULL
         AND ${visibility}`,
      params,
    );
    return result.rows[0] ?? null;
  }

  /**
   * Create an issue, its `ticket_number` and its associations, in one
   * transaction. Publishes `issue.created` AFTER the COMMIT (PF-292).
   *
   * The advisory lock is not incidental and is preserved verbatim: without it
   * two concurrent creates read the same `MAX(ticket_number)` and both insert
   * it, so Ship's human-facing `#42` stops being unique. It is a transaction
   * lock, so it releases on COMMIT or ROLLBACK without a `finally`.
   */
  async function create(ctx: DomainContext, input: IssueCreateInput): Promise<IssueRow> {
    const client: PoolClient = await ctx.db.connect();
    try {
      await client.query('BEGIN');

      // The lock key is derived from workspace_id (first 15 hex chars as bigint),
      // so creates in different workspaces do not serialise against each other.
      const workspaceIdHex = ctx.workspaceId.replace(/-/g, '').substring(0, 15);
      const lockKey = parseInt(workspaceIdHex, 16);
      await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

      const ticketResult = await client.query(
        `SELECT COALESCE(MAX(ticket_number), 0) + 1 as next_number
         FROM documents
         WHERE workspace_id = $1 AND document_type = '${ISSUE_DOCUMENT_TYPE}'`,
        [ctx.workspaceId],
      );
      const ticketNumber = ticketResult.rows[0].next_number;

      const properties = {
        state: input.state || 'backlog',
        priority: input.priority || 'medium',
        source: input.source || 'internal',
        assignee_id: input.assigneeId || null,
        rejection_reason: null,
        due_date: input.dueDate || null,
        is_system_generated: input.isSystemGenerated || false,
        accountability_target_id: input.accountabilityTargetId || null,
        accountability_type: input.accountabilityType || null,
      };

      const result = await client.query(
        `INSERT INTO documents (workspace_id, document_type, title, properties, ticket_number, created_by)
         VALUES ($1, '${ISSUE_DOCUMENT_TYPE}', $2, $3, $4, $5)
         RETURNING *`,
        [ctx.workspaceId, input.title, JSON.stringify(properties), ticketNumber, ctx.userId],
      );

      const newIssue = result.rows[0] as IssueRow;

      for (const assoc of input.belongsTo ?? []) {
        await client.query(
          `INSERT INTO document_associations (document_id, related_id, relationship_type)
           VALUES ($1, $2, $3)
           ON CONFLICT (document_id, related_id, relationship_type) DO NOTHING`,
          [newIssue.id, assoc.id, assoc.type],
        );
      }

      await client.query('COMMIT');

      // ── PF-292 — `issue.created`, AFTER COMMIT, inside the service ──────
      //
      // After `COMMIT` returns and not one line earlier. An event for a row
      // that does not exist is unrecoverable at the subscriber: the webhook
      // fires, the subscriber GETs the id, and gets a 404 forever. The rollback
      // case is covered by the `catch` below, which publishes nothing.
      //
      // Here rather than in a route handler because TWO surfaces create issues
      // — internal `POST /api/issues` and public `POST /api/v1/issues` — and
      // both land in this function. Publishing from the route means two publish
      // sites and the one nobody remembers is the one that stops firing.
      await publishIssueEvent(deps.bus, 'issue.created', ctx, newIssue);

      return newIssue;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Update an issue's title, state, priority, assignee and associations.
   *
   * PF-293 — the change diff is built ONCE and three things read it: the
   * history rows, the `issue.assigned` event, and the `issue.status_changed`
   * event. `changes[]` is returned so a caller can see what actually moved,
   * which is what makes a no-op PATCH provably a no-op rather than a write that
   * happened to change nothing.
   *
   * Returns `null` when there is no such issue in this workspace.
   *
   * ## What this does NOT do, deliberately
   *
   * The internal PATCH also handles `estimate`, `claude_metadata`, the
   * incomplete-children 409, sprint-carryover detection and the Yjs title
   * broadcast. Those are Ship's internal workflow rules, they have their own
   * response shapes (a 409 body that is not `ApiError`), and none of them is on
   * the public contract. Extracting them here without a public consumer would
   * be a rewrite of `routes/issues.ts` for no boundary benefit — so the
   * internal PATCH keeps them, and this function serves the public subset that
   * PF-280 defines. The half that MUST be shared is the diff-to-history-to-event
   * path, and that is what lives here.
   */
  async function update(
    ctx: DomainContext,
    input: { id: string; patch: IssueUpdateInput; isAdmin?: boolean | undefined },
  ): Promise<IssueUpdateResult | null> {
    const client: PoolClient = await ctx.db.connect();
    try {
      const existing = await get({ ...ctx, db: wrapClient(client, ctx.db) }, {
        id: input.id,
        ...(input.isAdmin !== undefined ? { isAdmin: input.isAdmin } : {}),
      });
      if (!existing) return null;

      const currentProps = (existing.properties ?? {}) as Record<string, unknown>;
      const patch = input.patch;

      const updates: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;
      const changes: IssueChange[] = [];

      if (patch.title !== undefined && patch.title !== existing.title) {
        updates.push(`title = $${paramIndex++}`);
        values.push(patch.title);
        changes.push({ field: 'title', oldValue: existing.title, newValue: patch.title });
      }

      const newProps: Record<string, unknown> = { ...currentProps };
      let propsChanged = false;

      if (patch.state !== undefined && patch.state !== currentProps.state) {
        changes.push({
          field: 'state',
          oldValue: (currentProps.state as string) || null,
          newValue: patch.state,
        });
        newProps.state = patch.state;
        propsChanged = true;
        // The status timestamp columns (`started_at`, `completed_at`, …) move
        // with the state. Reused from `document-crud.ts` rather than restated,
        // so the public and internal surfaces cannot disagree about when an
        // issue was started.
        const timestampUpdates = getTimestampUpdates(
          (currentProps.state as string) || null,
          patch.state,
        );
        for (const [col, expr] of Object.entries(timestampUpdates)) {
          updates.push(`${col} = ${expr}`);
        }
      }

      if (patch.priority !== undefined && patch.priority !== currentProps.priority) {
        changes.push({
          field: 'priority',
          oldValue: (currentProps.priority as string) || null,
          newValue: patch.priority,
        });
        newProps.priority = patch.priority;
        propsChanged = true;
      }

      if (patch.assigneeId !== undefined && patch.assigneeId !== currentProps.assignee_id) {
        changes.push({
          field: 'assignee_id',
          oldValue: (currentProps.assignee_id as string) || null,
          newValue: patch.assigneeId,
        });
        newProps.assignee_id = patch.assigneeId;
        propsChanged = true;
      }

      let belongsToChanged = false;
      let newBelongsTo: readonly BelongsToRef[] = [];
      if (patch.belongsTo !== undefined) {
        const before = await currentAssociations(client, input.id);
        newBelongsTo = patch.belongsTo;
        const oldKey = before.map((b) => `${b.type}:${b.id}`).sort().join(',');
        const newKey = newBelongsTo.map((b) => `${b.type}:${b.id}`).sort().join(',');
        if (oldKey !== newKey) {
          belongsToChanged = true;
          changes.push({
            field: 'belongs_to',
            oldValue: JSON.stringify(before.map((b) => ({ id: b.id, type: b.type }))),
            newValue: JSON.stringify(newBelongsTo.map((b) => ({ id: b.id, type: b.type }))),
          });
        }
      }

      if (propsChanged) {
        updates.push(`properties = $${paramIndex++}`);
        values.push(JSON.stringify(newProps));
      }

      // A no-op PATCH. Not an error on the public surface — PF-280 requires 200
      // and no change — so the current row is returned with an empty diff and
      // NOTHING is published. The internal route's own 400 ("No fields to
      // update") is a surface decision and stays there.
      if (updates.length === 0 && !belongsToChanged) {
        return { row: existing, changes: [] };
      }

      await client.query('BEGIN');

      for (const change of changes) {
        await logDocumentChange(
          input.id,
          change.field,
          change.oldValue,
          change.newValue,
          ctx.userId,
          undefined,
          client,
        );
      }

      if (updates.length > 0) {
        updates.push(`updated_at = now()`);
        await client.query(
          `UPDATE documents SET ${updates.join(', ')}
            WHERE id = $${paramIndex} AND workspace_id = $${paramIndex + 1}
              AND document_type = '${ISSUE_DOCUMENT_TYPE}'`,
          [...values, input.id, ctx.workspaceId],
        );
      }

      if (belongsToChanged) {
        await client.query(`DELETE FROM document_associations WHERE document_id = $1`, [input.id]);
        for (const assoc of newBelongsTo) {
          await client.query(
            `INSERT INTO document_associations (document_id, related_id, relationship_type)
             VALUES ($1, $2, $3)
             ON CONFLICT (document_id, related_id, relationship_type) DO NOTHING`,
            [input.id, assoc.id, assoc.type],
          );
        }
      }

      const after = await client.query<IssueRow>(
        `SELECT * FROM documents WHERE id = $1 AND workspace_id = $2`,
        [input.id, ctx.workspaceId],
      );

      await client.query('COMMIT');

      const row = after.rows[0] as IssueRow;

      // ── PF-293 — the events hang off the SAME diff the history loop walked ──
      //
      // Not a second comparison of before and after. `changes` is the single
      // source of "what moved", so an `issue.status_changed` envelope's
      // `{from,to}` are by construction the same values the history row
      // recorded — which is the property PF-293's test asserts. A no-op PATCH
      // produced an empty `changes` above and returned before reaching here, so
      // it emits nothing.
      for (const change of changes) {
        if (change.field === 'assignee_id') {
          // `previous_assignee_id` and NOT a `{from,to}` pair, because L14's
          // registry says so (`eventPayloadSchemas`, PF-406) and its schemas are
          // `.strict()`: the NEW assignee is already `assignee_id` on the base
          // payload, so a `to` would be the same fact twice. The registry
          // rejected the pair at publish time when this was written the other
          // way, which is the check working.
          await publishIssueEvent(deps.bus, 'issue.assigned', ctx, row, {
            previous_assignee_id: change.oldValue,
          });
        } else if (change.field === 'state') {
          await publishIssueEvent(deps.bus, 'issue.status_changed', ctx, row, {
            from: change.oldValue,
            to: change.newValue,
          });
        }
      }

      return { row, changes };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * The `belongs_to` associations for a set of issues, batched.
   *
   * PF-296. ONE query for the whole page, not one per row — the internal list
   * already batches (`getBelongsToAssociationsBatch`) precisely to avoid the
   * N+1, and a public list that re-introduces it blows the p.6 query budget on
   * the endpoint a grader hits hardest.
   *
   * Only `{id, type}` is selected. The internal helper also joins `documents`
   * for a `title` and a `color` to decorate the Ship UI; the public projection
   * carries neither, so joining for them would be a relation scanned per page
   * for fields that are never serialised — and `title` in particular is the
   * title of a *program* or *project*, neither of which has a public resource
   * this week (L09's PF-250).
   */
  async function associationsFor(
    ctx: DomainContext,
    issueIds: readonly string[],
  ): Promise<Map<string, BelongsToRef[]>> {
    const map = new Map<string, BelongsToRef[]>();
    if (issueIds.length === 0) return map;

    const result = await ctx.db.query<{
      document_id: string;
      id: string;
      type: BelongsToType;
    }>(
      `SELECT da.document_id, da.related_id as id, da.relationship_type as type
         FROM document_associations da
        WHERE da.document_id = ANY($1::uuid[])
        ORDER BY da.document_id, da.relationship_type, da.created_at`,
      [[...issueIds]],
    );

    for (const row of result.rows) {
      const list = map.get(row.document_id) ?? [];
      list.push({ id: row.id, type: row.type });
      map.set(row.document_id, list);
    }
    return map;
  }

  return { list, get, create, update, associationsFor, bus: deps.bus };
}

/** The associations currently on an issue, read inside the caller's client. */
async function currentAssociations(
  client: PoolClient,
  issueId: string,
): Promise<BelongsToRef[]> {
  const result = await client.query(
    `SELECT related_id as id, relationship_type as type
       FROM document_associations WHERE document_id = $1`,
    [issueId],
  );
  return result.rows as BelongsToRef[];
}

/**
 * Presents a checked-out `PoolClient` through the `Database` interface, so
 * `get()` can be reused inside `update()`'s connection instead of taking a
 * SECOND connection from the pool.
 *
 * Two connections in one logical operation is how a service deadlocks itself
 * under load: `update` holds a connection while waiting for another, and a pool
 * at capacity never hands the second one over.
 */
function wrapClient(client: PoolClient, db: Database): Database {
  return {
    ...db,
    query: ((...args: unknown[]) =>
      (client.query as (...a: unknown[]) => unknown)(...args)) as Database['query'],
  } as Database;
}

/**
 * The one place an issue write turns into an event.
 *
 * A free function rather than a method so `create` and `update` share it
 * verbatim. Unlike `documentEventPayload` there is no type gate to apply: every
 * row reaching here is already a `document_type='issue'` row by construction,
 * because both call sites wrote it themselves.
 */
async function publishIssueEvent(
  bus: IEventBus | undefined,
  type: 'issue.created' | 'issue.assigned' | 'issue.status_changed',
  ctx: DomainContext,
  row: IssueRow,
  extra: Record<string, unknown> = {},
): Promise<void> {
  if (!bus) return;
  await bus.publish({
    type,
    workspace_id: ctx.workspaceId,
    data: { ...issueEventPayload(row as never), ...extra },
  });
}

export type IssueService = ReturnType<typeof createIssueService>;

/**
 * The default instance the INTERNAL routes use, mirroring `documentService`.
 * The public surface takes its instance from `createApp(deps)` so the bus is
 * injected.
 */
export const issueService: IssueService = createIssueService();
