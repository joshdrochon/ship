/**
 * `sprintService` — the sprint lifecycle transition, and the only place
 * `sprint.started` and `sprint.completed` are published.
 *
 * Tickets: PF-396, PF-403, PF-407. Finding: F9.
 *
 * ## F9, corrected
 *
 * F9 is recorded as *"`sprint.completed` has no producer. Nothing sets
 * `properties.status = 'completed'`; the value exists only in a PATCH schema
 * enum (`weeks.ts:174`)."* **The second half of that is wrong**, and it was
 * checked before building on it: the sprint PATCH handler does persist status,
 * including `'completed'` — it assigns `newProps.status = data.status` and
 * writes `properties` back. `db:seed` also inserts sprints with
 * `status: 'completed'` for past weeks. So a write path existed; the finding
 * mis-read the route.
 *
 * What was actually true, and is the real defect:
 *
 *   1. **No event.** Neither transition published anything, because nothing in
 *      the repo published anything — `.publish(` had zero call sites.
 *   2. **No state machine.** `POST /:id/start` guards its transition
 *      (`planning` only). The PATCH did not guard at all: it would write
 *      `active → planning`, or `completed → planning`, stranding the
 *      `planned_issue_ids` snapshot a previous start had taken. "Completed" was
 *      reachable but was not a *transition*; it was an arbitrary property write.
 *   3. **Two unreconciled notions of status.** The server stores
 *      `planning|active|completed` in `properties`, while the frontend DERIVES
 *      `active|upcoming|completed` from `sprint_number` + the workspace start
 *      date. Only the derived one ever produced "completed" in practice, and a
 *      derived value cannot fire an event because nothing observes it changing.
 *
 * So the fix is not "add a write path" — it is to make the existing write a
 * guarded transition and hang the event on it. That is what this module is.
 *
 * ## Why the guard is part of the ticket and not scope creep
 *
 * An event means "this happened, once". Publishing `sprint.completed` from an
 * unguarded property write would emit it every time anyone PATCHed a sprint
 * that was already completed — a subscriber would see N completions of one
 * sprint and have no way to tell which was real. The transition check is what
 * makes the event's at-most-once-per-transition meaning true, and it is why the
 * publish lives behind this function rather than beside the UPDATE.
 */
import type { PoolClient } from 'pg';
import type { Database } from '../db/client.js';
import type { IEventBus } from '../platform/webhooks/bus.js';
import { sprintEventPayload } from '../platform/webhooks/payloads.js';

/** Same shape as `documentService`'s — plain values, no HTTP. */
export interface DomainContext {
  workspaceId: string;
  userId: string | null;
  db: Database;
}

export type SprintStatus = 'planning' | 'active' | 'completed';

/** The stored default. A sprint with no `status` key has not started. */
export const DEFAULT_SPRINT_STATUS: SprintStatus = 'planning';

/**
 * The legal transitions.
 *
 * As DATA rather than a chain of `if`s, for the same reason the event types are:
 * the set is the thing being asserted, and a test reads it instead of restating
 * it. `planning → completed` is permitted deliberately — a week that ends
 * without anyone pressing start is still a week that ended, and forcing a
 * pointless `active` hop would make the honest case the awkward one.
 */
export const SPRINT_TRANSITIONS: Readonly<Record<SprintStatus, readonly SprintStatus[]>> =
  Object.freeze({
    planning: ['active', 'completed'],
    active: ['completed'],
    completed: [],
  });

/** The event each terminal status publishes. `planning` is not an event. */
const TRANSITION_EVENT: Readonly<Record<SprintStatus, string | null>> = Object.freeze({
  planning: null,
  active: 'sprint.started',
  completed: 'sprint.completed',
});

export class InvalidSprintTransitionError extends Error {
  readonly from: SprintStatus;
  readonly to: SprintStatus;

  constructor(from: SprintStatus, to: SprintStatus) {
    super(
      `Cannot move a week from "${from}" to "${to}". Legal transitions from ` +
        `"${from}": ${SPRINT_TRANSITIONS[from].join(', ') || '(none — it is terminal)'}.`,
    );
    this.name = 'InvalidSprintTransitionError';
    this.from = from;
    this.to = to;
  }
}

export interface SprintServiceDeps {
  bus?: IEventBus | undefined;
}

/** Reads the stored status off a properties blob, defaulting to `planning`. */
export function statusOf(properties: Record<string, unknown> | null | undefined): SprintStatus {
  const raw = (properties ?? {})['status'];
  return raw === 'active' || raw === 'completed' || raw === 'planning'
    ? raw
    : DEFAULT_SPRINT_STATUS;
}

// ─────────────────────────────────────────────────────────────────────────────
// L10 S3 — the public sprints resource (PF-284, PF-285, PF-286, PF-288, PF-289)
//
// Added to L14's module rather than beside it. One domain service per resource
// is the whole point of the seam: a second `sprintReadService` would mean two
// places that know how a sprint's status is decided, and the two would disagree
// the first time either changed.
// ─────────────────────────────────────────────────────────────────────────────

/** A week is seven days. Ship's own constant, restated nowhere else in this file. */
export const SPRINT_DURATION_DAYS = 7;

/**
 * PF-289 — the sprint calendar, computed in ONE place.
 *
 * `extractSprintFromRow` in `routes/weeks.ts` carries the comment *"Dates and
 * status are computed on frontend from sprint_number + workspace.sprint_start_date"*,
 * and the create route repeats it. So `start_date` and `end_date` are genuinely
 * derived — there are no columns holding them — and a public API that leaves the
 * derivation to the client is not a contract, it is a suggestion. Two clients
 * would compute two answers and both would be entitled to.
 *
 * Dates are UTC calendar dates (`YYYY-MM-DD`), not timestamps. A sprint boundary
 * is a day, and rendering it as an instant invites a consumer to apply a timezone
 * to something that does not have one.
 */
export function sprintWindow(
  sprintNumber: number,
  workspaceStartDate: Date | string | null | undefined,
): { start_date: string; end_date: string } | null {
  const start = toUtcMidnight(workspaceStartDate);
  if (!start) return null;

  const startDate = new Date(start);
  startDate.setUTCDate(startDate.getUTCDate() + (sprintNumber - 1) * SPRINT_DURATION_DAYS);
  const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + SPRINT_DURATION_DAYS - 1);

  return {
    start_date: startDate.toISOString().slice(0, 10),
    end_date: endDate.toISOString().slice(0, 10),
  };
}

function toUtcMidnight(value: Date | string | null | undefined): Date | null {
  if (value instanceof Date) {
    // node-postgres parses a `date` column into a LOCAL midnight `Date`. Reading
    // the local Y/M/D back out and rebuilding in UTC is what stops a workspace
    // west of Greenwich shifting every sprint boundary by a day.
    return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = new Date(`${value.slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * PF-289 — the public `status`, derived honestly.
 *
 * There are TWO notions of sprint status in this repo and they have never been
 * reconciled (finding F9's third point):
 *
 *   stored   `properties.status` — `planning | active | completed`, written only
 *            by `transition()` above, so it is present only on sprints someone
 *            actually started or completed.
 *   derived  the frontend computes `active | upcoming | completed` from
 *            `sprint_number` + `workspaces.sprint_start_date`
 *            (`web/src/components/week/WeekTimeline.tsx`).
 *
 * The public contract cannot expose both and must not expose neither. The rule
 * is: **an explicit transition wins; the calendar answers when nobody has
 * transitioned.** That is the honest reading — a stored value means a human or
 * an app asserted something, and asserting beats inferring; its absence means
 * nobody asserted anything, and the calendar is then the only information there
 * is.
 *
 * The frontend's `upcoming` is mapped to `planning` rather than added to the
 * enum, because `upcoming` describes the calendar and `planning` describes the
 * sprint, and the public enum is the one `sprintService.transition` can actually
 * move between. An enum member no transition can produce is a value a consumer
 * can receive and never cause.
 */
export function publicSprintStatus(
  properties: Record<string, unknown> | null | undefined,
  sprintNumber: number,
  workspaceStartDate: Date | string | null | undefined,
  now: Date = new Date(),
): SprintStatus {
  const stored = (properties ?? {})['status'];
  if (stored === 'planning' || stored === 'active' || stored === 'completed') return stored;

  const window = sprintWindow(sprintNumber, workspaceStartDate);
  if (!window) return DEFAULT_SPRINT_STATUS;

  const today = now.toISOString().slice(0, 10);
  if (today < window.start_date) return 'planning';
  if (today > window.end_date) return 'completed';
  return 'active';
}

/**
 * The timestamp a CURSOR is minted from — rendered by POSTGRES at microsecond
 * precision. Identical to the documents and issues services, for the identical
 * reason: a JS `Date` truncates to milliseconds and the resulting keyset bound
 * silently skips rows at every page boundary.
 */
const CURSOR_TIMESTAMP_EXPR = `to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Row-level visibility for the public surface.
 *
 * The uncorrelated scalar subquery form, not the `isAdmin` flag the internal
 * routes thread in from their own `getVisibilityContext()` round trip: Postgres
 * evaluates it once as an InitPlan, so it costs one index probe inside a query
 * we were already issuing rather than a second pool checkout per request.
 */
const PUBLIC_VISIBILITY = `(d.visibility = 'workspace' OR d.created_by = $2
             OR (SELECT wm.role FROM workspace_memberships wm
                  WHERE wm.workspace_id = $1 AND wm.user_id = $2) = 'admin')`;

/** A sprint row as the domain hands it back, plus the workspace calendar anchor. */
export interface SprintRow {
  id: string;
  title: string;
  properties: Record<string, unknown> | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
  created_by: string | null;
  /** `workspaces.sprint_start_date`, joined in so the calendar needs no second query. */
  workspace_sprint_start_date?: Date | string | null;
  [column: string]: unknown;
}

export interface SprintKeysetCursor {
  timestamp: string;
  id: string;
}

export interface SprintCreateInput {
  sprintNumber: number;
  title?: string | undefined;
  ownerId?: string | null | undefined;
  programId?: string | null | undefined;
}

/** Raised when a sprint number is already taken in the scope it must be unique in. */
export class DuplicateSprintNumberError extends Error {
  constructor(sprintNumber: number, scope: 'program' | 'workspace') {
    super(
      scope === 'program'
        ? `Sprint ${sprintNumber} already exists for this program.`
        : `Sprint ${sprintNumber} already exists in this workspace without a program.`,
    );
    this.name = 'DuplicateSprintNumberError';
  }
}

/** Raised when `program_id` or `owner_id` names something this workspace does not have. */
export class UnknownSprintReferenceError extends Error {
  readonly field: 'program_id' | 'owner_id';
  constructor(field: 'program_id' | 'owner_id') {
    super(`No ${field === 'program_id' ? 'program' : 'workspace member'} with that id.`);
    this.name = 'UnknownSprintReferenceError';
    this.field = field;
  }
}

export function createSprintService(deps: SprintServiceDeps = {}) {
  /**
   * Move a sprint to `to`, merging `extraProperties`, and publish the event.
   *
   * Returns the updated row, or `null` when the sprint does not exist in this
   * workspace — the route maps that to its own 404 and keeps its own visibility
   * checks, which are a surface concern.
   *
   * Throws `InvalidSprintTransitionError` when the move is not legal. The route
   * turns that into its existing 400; the domain does not know what a status
   * code is.
   */
  async function transition(
    ctx: DomainContext,
    input: {
      id: string;
      to: SprintStatus;
      extraProperties?: Record<string, unknown> | undefined;
    },
  ): Promise<{ row: Record<string, unknown>; from: SprintStatus } | null> {
    const current = await ctx.db.query<{
      id: string;
      title: string;
      properties: Record<string, unknown> | null;
      created_at: Date | string | null;
      updated_at: Date | string | null;
      created_by: string | null;
      visibility: string | null;
    }>(
      `SELECT id, title, properties, created_at, updated_at, created_by, visibility
         FROM documents
        WHERE id = $1 AND workspace_id = $2 AND document_type = 'sprint'`,
      [input.id, ctx.workspaceId],
    );

    const existing = current.rows[0];
    if (!existing) return null;

    const from = statusOf(existing.properties);
    if (from === input.to) {
      // Not an error and not an event. Re-asserting the current status is a
      // no-op write; emitting here is what would give a subscriber N
      // "completions" of one sprint.
      return { row: existing as unknown as Record<string, unknown>, from };
    }
    if (!SPRINT_TRANSITIONS[from].includes(input.to)) {
      throw new InvalidSprintTransitionError(from, input.to);
    }

    const newProps = {
      ...(existing.properties ?? {}),
      ...(input.extraProperties ?? {}),
      status: input.to,
    };

    // Scoped by workspace AND document_type, unlike the bare `WHERE id = $2`
    // the start route used. The prior SELECT made that safe, but a write whose
    // own predicate is narrower does not depend on a caller getting the read
    // right first.
    const updated = await ctx.db.query<Record<string, unknown>>(
      `UPDATE documents SET properties = $1, updated_at = now()
        WHERE id = $2 AND workspace_id = $3 AND document_type = 'sprint'
        RETURNING *`,
      [JSON.stringify(newProps), input.id, ctx.workspaceId],
    );

    const row = updated.rows[0];
    if (!row) return null;

    // After the write, like every other publish in this codebase.
    const eventType = TRANSITION_EVENT[input.to];
    if (deps.bus && eventType) {
      await deps.bus.publish({
        type: eventType,
        workspace_id: ctx.workspaceId,
        data: sprintEventPayload(row as never, input.to),
      });
    }

    return { row, from };
  }

  /** The start transition — `planning → active`. Publishes `sprint.started`. */
  async function start(
    ctx: DomainContext,
    input: { id: string; extraProperties?: Record<string, unknown> | undefined },
  ) {
    return transition(ctx, { id: input.id, to: 'active', ...(input.extraProperties ? { extraProperties: input.extraProperties } : {}) });
  }

  /**
   * The completion transition. Publishes `sprint.completed`.
   *
   * This is the function whose EXISTENCE closes F9: before it, `completed` was
   * a value the PATCH schema accepted and wrote, with nothing observing it.
   */
  async function complete(ctx: DomainContext, input: { id: string }) {
    return transition(ctx, { id: input.id, to: 'completed' });
  }

  /**
   * PF-284 — list sprints. NEW WORK, not an extraction, and the ticket is right
   * about why.
   *
   * `GET /api/weeks/` (`routes/weeks.ts`) is not a sprint list. It derives the
   * CURRENT sprint number from `workspaces.sprint_start_date` and filters
   * `(d.properties->>'sprint_number')::int = $2`, so a workspace with sprints
   * 1–5 gets back one row and a `days_remaining`. There is no internal route
   * that answers "what sprints are there", so there was nothing to extract.
   *
   * ## PF-288 — ordered by `(created_at, id)`, and the cost is stated
   *
   * The internal ordering is `(d.properties->>'sprint_number')::int` — a
   * computed expression over an unindexed JSONB field, so every internal list is
   * a sort over a sequential scan, and a keyset over it is not expressible as a
   * row comparison at all (you cannot range-scan an expression that has no
   * index, and `sprint_number` is mutable besides — `updateSprintSchema` accepts
   * it).
   *
   * **So the public sprint list comes back in CREATION order, not sprint-number
   * order, and that is a real product regression chosen deliberately.** p.3
   * requires cursors "stable across reordering operations", and no cursor over a
   * mutable unindexed JSONB expression can be. The alternatives were: an
   * offset-paginated `?sort=sprint_number` mode (breaks the one-envelope rule),
   * or promoting `sprint_number` to a real indexed column (a migration against
   * Part 1's schema during MVP week). `sprint_number` IS on the projection, so a
   * consumer that wants sprint order can sort a page itself.
   *
   * The workspace's `sprint_start_date` is JOINed rather than fetched
   * separately, because every row's `start_date`, `end_date` and derived
   * `status` need it and a second query would be one extra round trip per
   * request for a single date.
   */
  async function list(
    ctx: DomainContext,
    input: { limit: number; cursor: SprintKeysetCursor | null },
  ): Promise<SprintRow[]> {
    const params: unknown[] = [ctx.workspaceId, ctx.userId];
    let sql = `
      SELECT d.id, d.title, d.properties,
             d.created_at, d.updated_at, d.created_by,
             w.sprint_start_date AS workspace_sprint_start_date,
             ${CURSOR_TIMESTAMP_EXPR} AS created_at_cursor
      FROM documents d
      JOIN workspaces w ON w.id = d.workspace_id
      WHERE d.workspace_id = $1
        AND d.document_type = 'sprint'
        AND d.archived_at IS NULL
        AND d.deleted_at IS NULL
        AND ${PUBLIC_VISIBILITY}`;

    if (input.cursor) {
      params.push(input.cursor.timestamp, input.cursor.id);
      sql += `
        AND (d.created_at, d.id) < ($3::timestamptz, $4::uuid)`;
    }

    params.push(input.limit);
    sql += `
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $${params.length}`;

    const result = await ctx.db.query<SprintRow>(sql, params);
    return result.rows;
  }

  /**
   * PF-285 — one sprint by id, or `null`.
   *
   * `null` covers every way to miss — unknown id, another workspace, soft
   * deleted, or a row whose `document_type` is not `sprint`. The route maps all
   * four to one `not_found`, because distinguishing them leaks existence.
   *
   * The internal handler returns a heavily denormalised object: issue counts,
   * completed counts, retro presence and id, a program join, an owner join,
   * `owner_reports_to`. **None of it is here.** Those are the Ship week
   * dashboard's needs, and a public projection that carried them would be
   * publishing an internal screen's data requirements as a contract — and would
   * cost six correlated subqueries on a by-id read. The public projection is
   * PF-289's decision, not a pass-through.
   */
  async function get(ctx: DomainContext, input: { id: string }): Promise<SprintRow | null> {
    const result = await ctx.db.query<SprintRow>(
      `SELECT d.id, d.title, d.properties,
              d.created_at, d.updated_at, d.created_by,
              w.sprint_start_date AS workspace_sprint_start_date
       FROM documents d
       JOIN workspaces w ON w.id = d.workspace_id
       WHERE d.id = $3::uuid
         AND d.workspace_id = $1
         AND d.document_type = 'sprint'
         AND d.deleted_at IS NULL
         AND ${PUBLIC_VISIBILITY}`,
      [ctx.workspaceId, ctx.userId, input.id],
    );
    return result.rows[0] ?? null;
  }

  /**
   * PF-286 — create a sprint.
   *
   * The uniqueness rules are the internal route's, preserved because they are
   * real invariants rather than UI validation: a sprint number must be unique
   * within its program, and programless sprints must be unique within the
   * workspace. Two sprint 3s in one program would make every
   * `sprint_number`-keyed query in Part 1 ambiguous.
   *
   * ## What the public request schema does NOT accept, and why it would be a lie
   *
   * `start_date` / `end_date`. The internal create route's own comment says only
   * `sprint_number` and `owner_id` are stored and *"dates and status are
   * computed"* — so a public schema accepting them would document fields the
   * server silently discards. An OpenAPI document that advertises a writable
   * field the server ignores is worse than one that omits it: the consumer sends
   * it, gets a 201, and believes it took.
   *
   * `plan`, `success_criteria`, `confidence` and the TipTap `content` default
   * are also absent. They are Ship's weekly-planning workflow, they have no
   * scope on p.3, and the `hypothesisBlock` content the internal route seeds is
   * a CRDT editor structure that no third-party consumer can meaningfully
   * author.
   */
  async function create(ctx: DomainContext, input: SprintCreateInput): Promise<SprintRow> {
    const client: PoolClient = await ctx.db.connect();
    try {
      await client.query('BEGIN');

      if (input.programId) {
        const program = await client.query(
          `SELECT id FROM documents
            WHERE id = $1 AND workspace_id = $2 AND document_type = 'program'
              AND deleted_at IS NULL`,
          [input.programId, ctx.workspaceId],
        );
        if (program.rows.length === 0) throw new UnknownSprintReferenceError('program_id');

        const clash = await client.query(
          `SELECT d.id FROM documents d
             JOIN document_associations da ON da.document_id = d.id
            WHERE da.related_id = $1 AND da.relationship_type = 'program'
              AND d.document_type = 'sprint'
              AND (d.properties->>'sprint_number')::int = $2`,
          [input.programId, input.sprintNumber],
        );
        if (clash.rows.length > 0) {
          throw new DuplicateSprintNumberError(input.sprintNumber, 'program');
        }
      } else {
        const clash = await client.query(
          `SELECT d.id FROM documents d
            WHERE d.workspace_id = $1
              AND d.document_type = 'sprint'
              AND (d.properties->>'sprint_number')::int = $2
              AND NOT EXISTS (
                SELECT 1 FROM document_associations da
                 WHERE da.document_id = d.id AND da.relationship_type = 'program'
              )`,
          [ctx.workspaceId, input.sprintNumber],
        );
        if (clash.rows.length > 0) {
          throw new DuplicateSprintNumberError(input.sprintNumber, 'workspace');
        }
      }

      if (input.ownerId) {
        // A member of THIS workspace. Without the membership join a caller could
        // name any user id in the system as a sprint owner, which is a
        // cross-tenant reference written through a field nobody thinks of as one.
        const owner = await client.query(
          `SELECT u.id FROM users u
             JOIN workspace_memberships wm ON wm.user_id = u.id
            WHERE u.id = $1 AND wm.workspace_id = $2`,
          [input.ownerId, ctx.workspaceId],
        );
        if (owner.rows.length === 0) throw new UnknownSprintReferenceError('owner_id');
      }

      // `assignee_ids` mirrors `owner_id` because Part 1 reads the owner out of
      // `properties->'assignee_ids'->>0` in several places while the create
      // route also writes `owner_id`. Writing one and not the other produces a
      // sprint whose owner is visible on one screen and null on another.
      const properties: Record<string, unknown> = {
        sprint_number: input.sprintNumber,
        assignee_ids: input.ownerId ? [input.ownerId] : [],
      };
      if (input.ownerId) properties.owner_id = input.ownerId;

      const inserted = await client.query<SprintRow>(
        `INSERT INTO documents (workspace_id, document_type, title, properties, created_by)
         VALUES ($1, 'sprint', $2, $3, $4)
         RETURNING id, title, properties, created_at, updated_at, created_by`,
        [ctx.workspaceId, input.title ?? 'Untitled', JSON.stringify(properties), ctx.userId],
      );
      const row = inserted.rows[0] as SprintRow;

      if (input.programId) {
        await client.query(
          `INSERT INTO document_associations (document_id, related_id, relationship_type)
           VALUES ($1, $2, 'program')
           ON CONFLICT (document_id, related_id, relationship_type) DO NOTHING`,
          [row.id, input.programId],
        );
      }

      const anchor = await client.query<{ sprint_start_date: Date | string | null }>(
        `SELECT sprint_start_date FROM workspaces WHERE id = $1`,
        [ctx.workspaceId],
      );

      await client.query('COMMIT');

      // No event. p.3 registers `sprint.started` and `sprint.completed` and
      // nothing for creation — a sprint that exists has not happened yet, and
      // inventing a ninth event type to be symmetrical would break PF-397's
      // closed-set assertion.
      row.workspace_sprint_start_date = anchor.rows[0]?.sprint_start_date ?? null;
      return row;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return { transition, start, complete, list, get, create, bus: deps.bus };
}

export type SprintService = ReturnType<typeof createSprintService>;

/** The instance the internal routes use, mirroring `documentService`. */
export const sprintService: SprintService = createSprintService();
