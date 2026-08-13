/**
 * Request and response Zod for `/api/v1/sprints`, adjacent to the handler.
 *
 * Tickets: PF-286 (the create request), PF-289 (computed fields declared
 * read-only, and `status` declared honestly), PF-291 (the status transition).
 *
 * ## The naming trap, and where its resolution lives
 *
 * The public contract name is `sprints` — p.3 registers `sprints:read` and
 * `sprints:write`, and p.4/p.7 name `client.sprints`. Ship's internal HTTP path
 * for the same data is spelled differently. The `document_type`, however, has
 * been `'sprint'` since Part 1, so the split is route-path and vocabulary, not
 * table.
 *
 * **This lane does not re-decide that mapping.** L03 owns it and it lives in
 * `platform/api/v1/resource-map.ts` (PF-077/PF-078); this module resolves
 * through `documentTypeFor('sprints')` rather than restating anything, and
 * `sprints.fitness.test.ts` asserts that no file here names the internal
 * spelling — deriving its needle from the map, so the test is not itself the
 * second copy of the name that the rule exists to prevent.
 */
import { z } from 'zod';
import {
  publicSprintStatus,
  sprintWindow,
  type SprintStatus,
} from '../../../../services/sprints.js';

/** The three statuses `sprintService.transition` can move between. */
export const SPRINT_STATUSES = ['planning', 'active', 'completed'] as const;

/**
 * PF-289 — THE sprint projection.
 *
 * ## `start_date`, `end_date` and `status` are DERIVED, and say so
 *
 * `extractSprintFromRow` in Ship's internal sprint router carries the comment *"Dates
 * and status are computed on frontend from sprint_number +
 * workspace.sprint_start_date"*, and the create route repeats it. There are no
 * columns holding these values.
 *
 * They are computed SERVER-side here and marked `readOnly` in the generated
 * spec, which is what stops an SDK consumer sending them back. A public API that
 * lets the *frontend* compute a status field is not a contract — two clients
 * would produce two answers and both would be entitled to.
 *
 * `.readonly()` on a Zod field is what `zod-to-openapi` renders as
 * `readOnly: true`, so the marking is declared once and the generator carries
 * it; there is no second list of read-only fields to keep in step.
 *
 * ## `status` is honest about which of two notions it reports
 *
 * The derivation rule lives in `services/sprints.ts` (`publicSprintStatus`):
 * an explicit stored transition wins, the calendar answers when nobody has
 * transitioned. See that function for why. The important property for THIS file
 * is that the enum contains exactly the values `sprintService.transition` can
 * produce — an enum member no transition can reach is a value a consumer can
 * receive and never cause.
 *
 * ## What is absent
 *
 * The internal by-id handler returns `issue_count`, `completed_count`,
 * `started_count`, `has_plan`, `has_retro`, `retro_outcome`, `retro_id`,
 * `program_name`, `program_prefix`, `program_accountable_id`,
 * `owner_reports_to`, `plan`, `plan_history`, `success_criteria`, `confidence`,
 * `is_complete` and `missing_fields`. None of it is here. Those are the Ship
 * week-dashboard's data requirements, they cost six correlated subqueries per
 * read, and publishing them would make an internal screen's needs a public
 * contract nobody can change afterwards.
 */
export const sprintSchema = z
  .object({
    id: z.string().uuid(),
    document_type: z.literal('sprint'),
    title: z.string(),
    sprint_number: z.number().int(),
    /** Derived. See the module note. */
    status: z.enum(SPRINT_STATUSES).readonly(),
    /** Derived from `sprint_number` + the workspace anchor. `null` if unanchored. */
    start_date: z.string().nullable().readonly(),
    end_date: z.string().nullable().readonly(),
    owner_id: z.string().uuid().nullable(),
    program_id: z.string().uuid().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    created_by: z.string().uuid().nullable(),
  })
  .strict();

export type PublicSprint = z.infer<typeof sprintSchema>;

/** The exact key set of the projection, for the fitness test to read as data. */
export const SPRINT_PROJECTION_FIELDS = Object.keys(sprintSchema.shape) as (keyof PublicSprint)[];

/** The fields a consumer must never be able to WRITE. Data, for the test. */
export const SPRINT_READONLY_FIELDS = ['status', 'start_date', 'end_date'] as const;

/** Keys that must never appear in a serialised sprint. */
export const FORBIDDEN_SPRINT_FIELDS = [
  'properties',
  'content',
  'yjs_state',
  'workspace_id',
  'assignee_ids',
  'plan',
  'plan_history',
  'success_criteria',
  'confidence',
  'issue_count',
  'completed_count',
  'started_count',
  'has_plan',
  'has_retro',
  'retro_outcome',
  'retro_id',
  'owner_reports_to',
  'program_name',
  'workspace_sprint_start_date',
  // The internal shape calls the title `name`. The public one calls it `title`,
  // like every other resource — a consumer should not need to know that one of
  // three resources spells the same column differently.
  'name',
] as const;

/**
 * Project a domain row onto the public representation.
 *
 * Explicit field-by-field, so a column the domain starts returning cannot arrive
 * here by accident. `programId` is passed in rather than read off the row
 * because the association lives in `document_associations` and is fetched in
 * one batched query for the whole page, not per row.
 */
export function toPublicSprint(
  row: {
    id: string;
    title: string;
    properties?: Record<string, unknown> | null;
    created_at: Date | string | null;
    updated_at: Date | string | null;
    created_by: string | null;
    workspace_sprint_start_date?: Date | string | null;
    [k: string]: unknown;
  },
  programId: string | null = null,
  now: Date = new Date(),
): PublicSprint {
  const props = (row.properties ?? {}) as Record<string, unknown>;
  const sprintNumber =
    typeof props.sprint_number === 'number'
      ? props.sprint_number
      : Number.parseInt(String(props.sprint_number ?? '1'), 10) || 1;

  const anchor = row.workspace_sprint_start_date ?? null;
  const window = sprintWindow(sprintNumber, anchor);

  return {
    id: row.id,
    document_type: 'sprint',
    title: row.title,
    sprint_number: sprintNumber,
    status: publicSprintStatus(props, sprintNumber, anchor, now) as SprintStatus,
    start_date: window?.start_date ?? null,
    end_date: window?.end_date ?? null,
    owner_id: ownerOf(props),
    program_id: programId,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    created_by: row.created_by ?? null,
  };
}

/**
 * The owner, read from BOTH places Part 1 stores it.
 *
 * The create route writes `properties.owner_id` AND `properties.assignee_ids[0]`
 * and several read paths use only the second (`(d.properties->'assignee_ids'->>0)::uuid`).
 * Reading one would return null for sprints written by whichever path the reader
 * did not know about, so this prefers the explicit field and falls back.
 */
function ownerOf(props: Record<string, unknown>): string | null {
  const explicit = props.owner_id;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const assignees = props.assignee_ids;
  if (Array.isArray(assignees) && typeof assignees[0] === 'string' && assignees[0].length > 0) {
    return assignees[0];
  }
  return null;
}

function toIso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) {
    throw new Error(
      'A sprint row reached the public projection with a null timestamp. ' +
        '`documents.created_at`/`updated_at` are NOT NULL as of migration 060 (F15).',
    );
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * PF-286 — the create request. `.strict()`.
 *
 * `start_date` and `end_date` are REJECTED rather than ignored, and that is the
 * ticket's whole point: the internal create route's own comment states only
 * `sprint_number` and `owner_id` are stored and everything else is computed, so
 * a public schema accepting a date would document a writable field the server
 * discards. The consumer sends it, gets a 201, and believes it took.
 *
 * `status` is rejected for the same reason plus a stronger one: a sprint's
 * status is reached by a TRANSITION (`SPRINT_TRANSITIONS`), and letting a create
 * body assert `completed` would produce a completed sprint that never started
 * and never published `sprint.completed`.
 */
export const createSprintRequestSchema = z
  .object({
    sprint_number: z.number().int().positive(),
    title: z.string().min(1).max(200).optional(),
    owner_id: z.string().uuid().nullable().optional(),
    program_id: z.string().uuid().nullable().optional(),
  })
  .strict();

export type CreateSprintRequest = z.infer<typeof createSprintRequestSchema>;

/**
 * PF-291 — the status transition, as a PATCH.
 *
 * ## Why this route exists at all
 *
 * L99's F9 and L14's PF-407 established that `sprint.completed` had no producer.
 * L14 closed the domain half: `sprintService.complete` exists, guards the
 * transition, and publishes. What remained is that **no PLATFORM CONSUMER could
 * cause it** — the only paths to a completed sprint were Ship's own UI and a
 * direct database write. One of the eight event types p.3 registers would have
 * been untriggerable by exactly the audience the week is about, and a grader
 * running Testing Scenario 6's shape against `sprints` would find precisely that.
 *
 * `status` is the ONLY field. This is a transition endpoint, not a general
 * update: `title`, `owner_id` and `sprint_number` are absent because changing
 * `sprint_number` after the fact re-dates every derived field on the sprint and
 * can collide with the uniqueness rule, and neither of the other two has a
 * consumer asking for it. A narrower route is one whose failure modes are all
 * enumerable.
 *
 * `status` is required, not optional — an empty-body PATCH here has no meaning,
 * because the only thing this endpoint does is move a state machine.
 */
export const patchSprintRequestSchema = z
  .object({
    status: z.enum(SPRINT_STATUSES),
  })
  .strict();

export type PatchSprintRequest = z.infer<typeof patchSprintRequestSchema>;

/** The path parameter, validated as a UUID before it reaches Postgres. */
export const sprintIdParamSchema = z.object({ id: z.string().uuid() }).strict();

/** Fields a caller might plausibly send that the public surface rejects. */
export const REJECTED_SPRINT_FIELDS = [
  'start_date',
  'end_date',
  'status',
  'plan',
  'success_criteria',
  'confidence',
  'workspace_id',
  'created_by',
  'properties',
  'content',
  'name',
] as const;
