/**
 * Request and response Zod for `/api/v1/documents`, adjacent to the handler.
 *
 * Tickets: PF-250 (`PUBLIC_DOCUMENT_TYPES`), PF-251 (adjacency), PF-252 (one
 * projection, an allowlist), PF-253 (`.strict()` requests), PF-254 (the Zod →
 * `details.fields[]` mapping).
 *
 * PRD p.11: *"Every public route's request/response schema lives in Zod adjacent
 * to the handler; the generator walks them."* This file is that adjacency —
 * a sibling of `routes.ts` in the same directory, deliberately NOT
 * `api/src/openapi/schemas/`. That tree is 22 files and ~130 detached
 * `registerPath()` calls, i.e. a hand-written spec that drifts from the routes it
 * describes, and it is the failure mode L13's generator exists to keep out.
 * `documents.fitness.test.ts` greps for exactly that import.
 */
import { z } from 'zod';

/**
 * PF-250 — WHICH `document_type` VALUES THE PUBLIC `documents` RESOURCE SERVES.
 * This is finding F16, and it is the largest decision in the lane.
 *
 * ## The problem, stated exactly
 *
 * Ship's unified document model puts everything in one table: the enum at
 * `api/src/db/schema.sql:100` is ten values, from `wiki` to `person`. The PRD's
 * public contract (p.3) registers `documents:*`, `issues:*` and `sprints:*` as
 * three resources with three scope pairs. Those two facts cannot both be
 * honoured without deciding which types the `documents` resource exposes —
 * because the internal list filters on `document_type` only when `?type=` is
 * supplied (`api/src/routes/documents.ts:146`), so an unfiltered public list
 * returns issues and sprints under `documents:read` and makes `issues:read`
 * decorative. `POST` was the same defect in the other direction: the internal
 * create schema accepts `document_type: 'issue'`, so `documents:write` could
 * mint issues.
 *
 * ## The decision and what it costs
 *
 * The narrative types, and nothing else. `issue` and `sprint` belong to their
 * own scoped resources (L10). `program`, `project` and `person` are excluded
 * entirely, because p.3 registers no scope that would name them and inventing
 * one would break PF-062's exactly-seven assertion.
 *
 * **The consequence is real and is not hidden: three of Ship's ten document
 * types — `program`, `project`, `person` — are unreachable through the public
 * API this week.** The defensible alternative is "everything except issue and
 * sprint", which keeps the surface complete at the cost of making
 * `documents:read` a near-superuser read scope. If that is preferred, the change
 * is this constant and the tests that read it; nothing else moves, which is the
 * point of enforcing it as data.
 */
export const PUBLIC_DOCUMENT_TYPES = [
  'wiki',
  'weekly_plan',
  'weekly_retro',
  'standup',
  'weekly_review',
] as const;

export type PublicDocumentType = (typeof PUBLIC_DOCUMENT_TYPES)[number];

/** Types deliberately NOT on this resource. Exported so tests name them, not guess. */
export const NON_PUBLIC_DOCUMENT_TYPES = ['issue', 'sprint', 'program', 'project', 'person'] as const;

/**
 * PF-252 — THE response projection. An allowlist, and the only one.
 *
 * The internal create returns `RETURNING *` (`api/src/routes/documents.ts`,
 * inside `documentService.create`): `content` JSONB, `yjs_state` BYTEA,
 * `position`, `deleted_at`, `converted_from_id`, `conversion_count` — every
 * column. Passing that through would publish Ship's internal schema as the
 * public contract, which is finding F17.
 *
 * An ALLOWLIST rather than an exclusion list, and the difference is the whole
 * ticket. An exclusion list is correct only for the columns that existed on the
 * day it was written; the next migration adds a column and it ships to every
 * external consumer with nobody deciding that it should. An allowlist's default
 * for a new column is "absent", which is the safe default and the reversible one.
 *
 * The SAME schema object serialises the list item, the by-id body and the create
 * body. One schema means `client.documents.create()` and
 * `client.documents.iterate()` yield ONE type in the SDK (p.4) rather than three
 * near-identical ones a consumer has to reconcile.
 */
export const documentSchema = z
  .object({
    id: z.string().uuid(),
    document_type: z.enum(PUBLIC_DOCUMENT_TYPES),
    title: z.string(),
    parent_id: z.string().uuid().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    created_by: z.string().uuid().nullable(),
  })
  .strict();

export type PublicDocument = z.infer<typeof documentSchema>;

/** The exact key set of the projection, for the fitness test to read as data. */
export const DOCUMENT_PROJECTION_FIELDS = Object.keys(documentSchema.shape) as (keyof PublicDocument)[];

/**
 * Project a domain row onto the public representation.
 *
 * Written as an explicit field-by-field construction rather than a `pick` over
 * the row, so that a column the domain starts returning cannot arrive here by
 * accident. Timestamps are ISO-8601 strings: `Date` objects serialise to that
 * anyway through `res.json`, and doing it here means the Zod schema describes
 * what a consumer actually receives rather than what the server holds.
 */
export function toPublicDocument(row: {
  id: string;
  document_type: string;
  title: string;
  parent_id: string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
  created_by: string | null;
  [k: string]: unknown;
}): PublicDocument {
  return {
    id: row.id,
    document_type: row.document_type as PublicDocumentType,
    title: row.title,
    parent_id: row.parent_id ?? null,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    created_by: row.created_by ?? null,
  };
}

function toIso(value: Date | string | null): string {
  // `created_at` is NOT NULL after migration 060, so a null here would be a
  // domain bug rather than a data condition. Throwing beats emitting `""`,
  // which would parse as a string and fail only in the consumer.
  if (value === null || value === undefined) {
    throw new Error(
      'A document row reached the public projection with a null timestamp. ' +
        '`documents.created_at`/`updated_at` are NOT NULL as of migration 060 (F15); ' +
        'a null here means the row predates it or the query selected the wrong column.',
    );
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * PF-253 — the create request. `.strict()`, and that is load-bearing.
 *
 * `position`, `workspace_id`, `created_by`, `yjs_state`, `ticket_number`,
 * `converted_to_id` and `deleted_at` are internal-only and are REJECTED by name
 * rather than silently ignored. Ignoring them is how a caller comes to believe
 * they set a field they did not — the request succeeds, the response omits the
 * field (it is not in the projection), and the caller concludes the API is
 * eventually consistent rather than that they were wrong.
 *
 * `workspace_id` in particular must be a rejection and not an override: the
 * workspace comes from the token (PF-260), and a body that could name one would
 * be a cross-tenant write.
 *
 * `parent_id` and `belongs_to` stay accepted — they are the association surface
 * the internal route already exposes and the only way to build a hierarchy.
 *
 * The title default is `'Untitled'`, asserted rather than assumed, so the public
 * API cannot introduce a second default alongside the repo-wide convention in
 * `docs/document-model-conventions.md`.
 */
export const DEFAULT_DOCUMENT_TITLE = 'Untitled';

export const createDocumentRequestSchema = z
  .object({
    title: z.string().min(1).max(255).optional().default(DEFAULT_DOCUMENT_TITLE),
    document_type: z.enum(PUBLIC_DOCUMENT_TYPES).optional().default('wiki'),
    parent_id: z.string().uuid().nullable().optional(),
    belongs_to: z
      .array(
        z.object({
          id: z.string().uuid(),
          type: z.enum(['program', 'project', 'sprint', 'parent']),
        }),
      )
      .optional(),
    properties: z.record(z.unknown()).optional(),
    visibility: z.enum(['private', 'workspace']).optional(),
  })
  .strict();

export type CreateDocumentRequest = z.infer<typeof createDocumentRequestSchema>;

/** The path parameter, validated as a UUID before it reaches Postgres (PF-246). */
export const documentIdParamSchema = z.object({ id: z.string().uuid() }).strict();

/**
 * Fields a caller might plausibly send that are internal-only. Exported as data
 * so PF-253's test enumerates them instead of restating a list that can drift.
 */
export const REJECTED_INTERNAL_FIELDS = [
  'position',
  'workspace_id',
  'created_by',
  'yjs_state',
  'ticket_number',
  'converted_to_id',
  'deleted_at',
] as const;
