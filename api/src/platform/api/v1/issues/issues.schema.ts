/**
 * Request and response Zod for `/api/v1/issues`, adjacent to the handler.
 *
 * Tickets: PF-279 (`.strict()` create request), PF-280 (the patch request),
 * PF-282 (one projection, JSONB flattened and named). Decision D13 is settled
 * here — see `belongs_to` below.
 *
 * PRD p.11: *"Every public route's request/response schema lives in Zod adjacent
 * to the handler; the generator walks them."* This file is that adjacency — a
 * sibling of `routes.ts`, deliberately NOT `api/src/openapi/schemas/`, which is
 * the detached hand-written spec L13's generator exists to keep out.
 */
import { z } from 'zod';
import {
  ISSUE_STATES,
  ISSUE_PRIORITIES,
  BELONGS_TO_TYPES,
} from '../../../../services/issues.js';

/**
 * PF-282 — the association reference, and the answer to decision D13.
 *
 * ## What D13 asked for, and why the shape changed
 *
 * L23 (`agent-rewire`) found that three of its five detectors and two graph
 * fetch nodes read `document_associations` and `document_history`, neither of
 * which has a public route or a scope on p.3. Its option (a) was: *"flatten
 * `sprint_id`/`project_id` onto `issueSchema` — one field, rescues
 * loadImbalance + sprintMissRisk."*
 *
 * **The substance is accepted; the shape is not, and the reason is measurable
 * rather than aesthetic.**
 *
 * 1. **The cardinality is wrong.** `document_associations`'s only uniqueness
 *    constraint is `UNIQUE (document_id, related_id, relationship_type)`
 *    (`api/src/db/schema.sql:218`). That forbids the SAME pair twice; it does
 *    not forbid an issue associated with two different sprints. A flat
 *    `sprint_id` would have to pick one arbitrarily and would publish a
 *    one-to-one relationship the schema does not enforce — a lie in the
 *    OpenAPI document, and the kind that is only discovered by the consumer
 *    whose data is dropped.
 *
 * 2. **`sprint_id` is a name the schema deliberately deleted.** Migration 027
 *    dropped the `sprint_id` column; associations went to the junction table.
 *    Re-introducing the identifier as a public contract field would make the
 *    name permanent on the public surface at the exact moment the internal
 *    model has finished removing it.
 *
 * 3. **It rescues the same detectors either way.** `belongs_to` carries strictly
 *    MORE than option (a) asked for: `.find(b => b.type === 'sprint')?.id` is
 *    the sprint, `.filter(b => b.type === 'project')` is the projects, and
 *    `parent` — which option (a) did not offer at all — comes free. So L23's
 *    exception list shrinks by two entries as it hoped, without publishing a
 *    field the database cannot back.
 *
 * **What D13 does NOT get from this lane:** `reworkChurn` reads
 * `document_history` and is untouched — option (b)'s `GET /api/v1/issues/:id/history`
 * invents a route the PRD never asks for and a scope p.3 does not register, so
 * it stays on option (c) (named SQL, counted). L23's exception list goes from
 * three entries to one, not to zero.
 *
 * Only `{id, type}` is projected. The internal helper also returns a `title` and
 * a `color` for the Ship sidebar; those are the title of a `program` or
 * `project`, neither of which has a public resource this week (L09's PF-250),
 * so serialising them would leak a document a `documents:read` token is
 * explicitly not allowed to fetch.
 */
export const belongsToRefSchema = z
  .object({
    id: z.string().uuid(),
    type: z.enum(BELONGS_TO_TYPES),
  })
  .strict();

/**
 * PF-282 — THE issue projection. An allowlist, and the only one.
 *
 * ## `properties` is never serialised
 *
 * `state`, `priority`, `assignee_id`, `source` and `rejection_reason` live
 * inside a `properties JSONB` blob (`api/src/db/schema.sql`), and the internal
 * routes unpack them ad hoc per handler. Publishing the blob would make Ship's
 * internal property bag the public contract — every key anyone ever adds to it,
 * forever, with nobody deciding that it should ship. It would also generate as
 * `type: object` with no properties in the OpenAPI document, which tells an SDK
 * generator exactly nothing.
 *
 * So the fields are declared as first-class typed columns with REAL enums, read
 * from `services/issues.ts` rather than restated, and the blob itself is absent.
 *
 * ## An allowlist, not an exclusion list
 *
 * Same discipline as `documentSchema` (PF-252, finding F17): the internal create
 * returns `RETURNING *` — `content`, `yjs_state`, `position`, `deleted_at`,
 * `converted_from_id`, `claude_metadata`, the whole accountability block. An
 * exclusion list is correct only for the columns that existed the day it was
 * written; the next migration adds one and it ships to every external consumer.
 * An allowlist's default for a new column is "absent".
 *
 * ## `ticket_number` and `display_id`
 *
 * The S1 audit notes flagged leaving `ticket_number` out as "a visible gap in
 * the demo story — a CLI cannot print `#42` for an issue it just created".
 * That is right, and it is cheap to close: `ticket_number` is a stable
 * server-assigned integer, unique per workspace, allocated under an advisory
 * lock. It is included. `display_id` is NOT — it is `'#' + ticket_number`, a
 * pure presentation concern, and a public API that ships both ships one fact
 * twice and invites a consumer to parse the string form.
 *
 * ## One schema for four responses
 *
 * List item, by-id body, create body and patch body are all this object
 * (PF-252's rule applied here), so `client.issues.create()` and
 * `client.issues.list()` yield ONE type in the SDK rather than three
 * near-identical ones a consumer has to reconcile.
 */
export const issueSchema = z
  .object({
    id: z.string().uuid(),
    document_type: z.literal('issue'),
    title: z.string(),
    ticket_number: z.number().int().nullable(),
    state: z.enum(ISSUE_STATES),
    priority: z.enum(ISSUE_PRIORITIES),
    assignee_id: z.string().uuid().nullable(),
    /** D13. See `belongsToRefSchema`. Always present, `[]` when there are none. */
    belongs_to: z.array(belongsToRefSchema),
    created_at: z.string(),
    updated_at: z.string(),
    created_by: z.string().uuid().nullable(),
  })
  .strict();

export type PublicIssue = z.infer<typeof issueSchema>;

/** The exact key set of the projection, for the fitness test to read as data. */
export const ISSUE_PROJECTION_FIELDS = Object.keys(issueSchema.shape) as (keyof PublicIssue)[];

/**
 * Keys that must NEVER appear in a serialised issue. Data, so the test names
 * them rather than restating a list that drifts.
 */
export const FORBIDDEN_ISSUE_FIELDS = [
  'properties',
  'content',
  'yjs_state',
  'position',
  'deleted_at',
  'archived_at',
  'workspace_id',
  'claude_metadata',
  'is_system_generated',
  'accountability_target_id',
  'accountability_type',
  'rejection_reason',
  'display_id',
  'assignee_name',
  'created_by_name',
] as const;

/**
 * Project a domain row onto the public representation.
 *
 * An explicit field-by-field construction rather than a `pick`, so a column the
 * domain starts returning cannot arrive here by accident. The `properties`
 * unpacking happens HERE and nowhere else — one place decides that a missing
 * `state` reads as `backlog`, which is the same default the internal
 * `extractIssueFromRow` applies.
 */
export function toPublicIssue(
  row: {
    id: string;
    title: string;
    properties?: Record<string, unknown> | null;
    ticket_number?: number | string | null;
    created_at: Date | string | null;
    updated_at: Date | string | null;
    created_by: string | null;
    [k: string]: unknown;
  },
  belongsTo: readonly { id: string; type: string }[] = [],
): PublicIssue {
  const props = (row.properties ?? {}) as Record<string, unknown>;

  return {
    id: row.id,
    document_type: 'issue',
    title: row.title,
    ticket_number: toIntOrNull(row.ticket_number),
    state: enumOr(props.state, ISSUE_STATES, 'backlog'),
    priority: enumOr(props.priority, ISSUE_PRIORITIES, 'medium'),
    assignee_id: uuidOrNull(props.assignee_id),
    belongs_to: belongsTo.map((b) => ({
      id: b.id,
      type: b.type as PublicIssue['belongs_to'][number]['type'],
    })),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    created_by: row.created_by ?? null,
  };
}

/**
 * `ticket_number` arrives as a string from some drivers and as a number from
 * others (`COALESCE(MAX(...)) + 1` comes back as a string on `bigint`-ish
 * paths). Normalised here so the wire type matches the declared `integer` in
 * every code path rather than in most of them.
 */
function toIntOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * A JSONB value coerced onto a declared enum, or the default.
 *
 * The blob is unvalidated storage: a row written by a migration, a seed or an
 * older code path can hold anything. Coercing HERE means the response always
 * satisfies `issueSchema` — without it, one legacy row with
 * `properties.state = 'open'` would make L13's `responseContract` throw a 500 on
 * a read, which is a worse outcome than reporting the repo-wide default the
 * internal surface already shows for the same row.
 */
function enumOr<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number],
): T[number] {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T[number])
    : fallback;
}

/** `properties.assignee_id` is stored as a string and may be `''`. */
function uuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toIso(value: Date | string | null): string {
  if (value === null || value === undefined) {
    throw new Error(
      'An issue row reached the public projection with a null timestamp. ' +
        '`documents.created_at`/`updated_at` are NOT NULL as of migration 060 (F15); ' +
        'a null here means the row predates it or the query selected the wrong column.',
    );
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * PF-279 — the create request. `.strict()`, and that is load-bearing.
 *
 * ## What is deliberately NOT accepted
 *
 * `is_system_generated`, `accountability_target_id` and `accountability_type`
 * are on `createIssueSchema` internally (`api/src/routes/issues.ts`) and are
 * absent here. They drive Ship's accountability machinery — the action-item
 * queue that chases a human for a missing standup — and **a third-party app
 * able to mint `is_system_generated: true` items is a privilege escalation
 * dressed as a field**: it would let any app with `issues:write` fabricate
 * system-authored obligations that Ship's UI presents as its own.
 *
 * `source` is also absent. Its `action_items` value is the same machinery by
 * another name; every issue created through the public API is `internal`, which
 * is the honest description of an issue created by a consenting user's app.
 *
 * `ticket_number`, `workspace_id`, `created_by`, `position`, `properties` and
 * `content` are rejected BY NAME rather than ignored. Ignoring them is how a
 * caller comes to believe they set a field they did not: the request succeeds,
 * the response omits the field, and the caller concludes the API is eventually
 * consistent rather than that they were wrong. `workspace_id` in particular must
 * be a rejection and never an override — the workspace comes from the token
 * (PF-260), and a body that could name one would be a cross-tenant write.
 */
export const createIssueRequestSchema = z
  .object({
    title: z.string().min(1).max(500),
    state: z.enum(ISSUE_STATES).optional(),
    priority: z.enum(ISSUE_PRIORITIES).optional(),
    assignee_id: z.string().uuid().nullable().optional(),
    belongs_to: z.array(belongsToRefSchema).optional(),
  })
  .strict();

export type CreateIssueRequest = z.infer<typeof createIssueRequestSchema>;

/**
 * PF-280 — the patch request.
 *
 * `claude_metadata` and `confirm_orphan_children` are on the internal
 * `updateIssueSchema` and are rejected here by `.strict()`. The first is Ship's
 * Claude Code attribution block — internal telemetry with no meaning to a third
 * party. The second is the confirmation flag for the internal 409
 * `incomplete_children` flow, whose response body is not `ApiError` and whose
 * semantics ("yes, orphan the sub-issues") are a destructive UI confirmation, not
 * an API parameter.
 *
 * `estimate` is also absent: the internal PATCH couples it to a workflow rule
 * ("estimate required before assigning to a week") that returns a bare-400 shape
 * the public envelope does not have.
 *
 * An EMPTY body is accepted, and that is the no-op case PF-280 asks for: 200,
 * nothing written, no event.
 */
export const patchIssueRequestSchema = z
  .object({
    title: z.string().min(1).max(500).optional(),
    state: z.enum(ISSUE_STATES).optional(),
    priority: z.enum(ISSUE_PRIORITIES).optional(),
    assignee_id: z.string().uuid().nullable().optional(),
    belongs_to: z.array(belongsToRefSchema).optional(),
  })
  .strict();

export type PatchIssueRequest = z.infer<typeof patchIssueRequestSchema>;

/** The path parameter, validated as a UUID before it reaches Postgres. */
export const issueIdParamSchema = z.object({ id: z.string().uuid() }).strict();

/**
 * Fields a caller might plausibly send that are internal-only. Exported as data
 * so PF-279's test enumerates them instead of restating a drifting list.
 */
export const REJECTED_INTERNAL_ISSUE_FIELDS = [
  'is_system_generated',
  'accountability_target_id',
  'accountability_type',
  'source',
  'ticket_number',
  'workspace_id',
  'created_by',
  'position',
  'properties',
  'content',
  'claude_metadata',
  'confirm_orphan_children',
  'estimate',
] as const;
