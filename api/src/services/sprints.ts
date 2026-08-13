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

  return { transition, start, complete, bus: deps.bus };
}

export type SprintService = ReturnType<typeof createSprintService>;

/** The instance the internal routes use, mirroring `documentService`. */
export const sprintService: SprintService = createSprintService();
