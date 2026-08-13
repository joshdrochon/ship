/**
 * `/api/v1/sprints` — list, by-id, create, and the status transition.
 *
 * Tickets: PF-284 (list), PF-285 (by id), PF-286 (create), PF-287 (resolves
 * through L03's resource map), PF-288 (the `(created_at, id)` keyset), PF-289
 * (the projection), PF-291 (`sprint.completed` gets a public producer).
 *
 * ## PF-287 — this module contains no internal vocabulary
 *
 * The public contract name is `sprints`; Ship's internal HTTP path for the same
 * data is spelled differently. **This lane does not re-decide that mapping.**
 * L03 owns it and it lives in `platform/api/v1/resource-map.ts`, which this
 * module resolves through — `documentTypeFor('sprints')` rather than a
 * `'sprint'` literal, and nowhere in this directory does the internal spelling
 * appear at all, comments included. `sprints.fitness.test.ts` asserts that by
 * grep, deriving its needle FROM the map so the test is not itself a second
 * copy of the name; that is the assertion PF-078 asked for from this side.
 *
 * ## What this file may not contain
 *
 * No SQL, no import from `api/src/routes/**` or `api/src/middleware/**`, and no
 * `.publish(`. The last one matters more here than on any other resource: the
 * sprint transitions are the ONLY two events with an existing producer
 * (`services/sprints.ts`, L14's PF-407), so a publish added here would be a
 * SECOND producer for `sprint.completed` and a subscriber would see two.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import { parsePageRequest, pageSchema } from '../page.js';
import { sliceToPage } from '../pagination.js';
import { declareV1Route } from '../declareV1Route.js';
import { getPlatformAuth } from '../../../scopes/require-scope.js';
import { documentTypeFor } from '../resource-map.js';
import type { Database } from '../../../../db/client.js';
import {
  createSprintService,
  DuplicateSprintNumberError,
  InvalidSprintTransitionError,
  UnknownSprintReferenceError,
  type SprintService,
  type DomainContext,
} from '../../../../services/sprints.js';
import {
  createSprintRequestSchema,
  patchSprintRequestSchema,
  sprintIdParamSchema,
  sprintSchema,
  toPublicSprint,
} from './sprints.schema.js';

/** The cursor's resource binding. A `/documents` cursor is rejected here. */
export const SPRINTS_RESOURCE = 'sprints';

/**
 * PF-287 — the `document_type` comes from L03's map, not from a literal.
 *
 * Read once at module load. The map is the sanctioned place to know that a
 * public contract name and an internal name differ, and a handler that reaches
 * for the internal one directly has copied a fact that now exists twice.
 */
const SPRINT_DOCUMENT_TYPE = documentTypeFor(SPRINTS_RESOURCE);

export interface SprintsRouteDeps {
  db: Database;
  service: SprintService;
}

// ─────────────────────────────────────────────────────────────────────────────
// The four declarations, made ONCE at module load.
// ─────────────────────────────────────────────────────────────────────────────

const listGuard = declareV1Route({
  method: 'get',
  path: '/sprints',
  scope: 'sprints:read',
  list: 'cursor',
  resource: SPRINTS_RESOURCE,
  response: pageSchema(sprintSchema),
  summary: 'List sprints, newest first.',
  description:
    'Ordered by `(created_at, id)` descending — creation order, NOT sprint-number order. ' +
    '`sprint_number` is a mutable value inside an unindexed JSONB field, so a cursor over ' +
    'it could not be stable across reordering (PRD p.3). `sprint_number` is on every item, ' +
    'so a consumer that wants sprint order can sort a page itself.',
});

const getGuard = declareV1Route({
  method: 'get',
  path: '/sprints/:id',
  scope: 'sprints:read',
  list: false,
  params: sprintIdParamSchema,
  response: sprintSchema,
  summary: 'Fetch one sprint by id.',
});

const createGuard = declareV1Route({
  method: 'post',
  path: '/sprints',
  scope: 'sprints:write',
  list: false,
  request: createSprintRequestSchema,
  response: sprintSchema,
  summary: 'Create a sprint.',
  description:
    '`start_date`, `end_date` and `status` are derived and are rejected if sent — the ' +
    'server stores only `sprint_number` and the owner, and computes the rest.',
});

const patchGuard = declareV1Route({
  method: 'patch',
  path: '/sprints/:id',
  scope: 'sprints:write',
  list: false,
  params: sprintIdParamSchema,
  request: patchSprintRequestSchema,
  response: sprintSchema,
  summary: 'Move a sprint through its lifecycle.',
  description:
    'The only public writer of sprint status, and therefore the only way a platform ' +
    'consumer can cause `sprint.started` or `sprint.completed`. Legal moves are ' +
    'planning → active, planning → completed and active → completed; anything else is a ' +
    '422. Re-asserting the current status is a 200 that publishes nothing.',
});

/** A `ZodError` becomes `details.fields[]`, per L07's PF-198 policy. */
export function zodIssuesToFields(error: z.ZodError): { field: string; message: string }[] {
  const fields: { field: string; message: string }[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        fields.push({
          field: key,
          message:
            `Unknown field. It is not part of the public sprint representation. ` +
            `\`start_date\`, \`end_date\` and \`status\` in particular are DERIVED from ` +
            `\`sprint_number\` and the workspace's sprint start date — the server stores ` +
            `no such columns, so accepting them would document a field it discards.`,
        });
      }
      continue;
    }
    fields.push({
      field: issue.path.length > 0 ? issue.path.join('.') : '(body)',
      message: issue.message,
    });
  }
  return fields;
}

function validationFailed(error: z.ZodError): ApiError {
  return new ApiError('validation_failed', 'The request body is not valid.', {
    details: { fields: zodIssuesToFields(error) },
  });
}

/** One `not_found`, four ways to arrive at it, and no `details` (PF-285). */
function notFound(): ApiError {
  return new ApiError('not_found', 'No sprint with that id.');
}

/** The domain context, built from the TOKEN and nothing else (PF-260). */
function domainContext(res: Response, db: Database): DomainContext {
  const auth = getPlatformAuth(res);
  if (!auth) {
    throw new ApiError('unauthorized', 'This endpoint requires an access token.');
  }
  return { workspaceId: auth.workspaceId, userId: auth.userId, db };
}

/** Wraps an async handler so a rejection reaches `apiErrorMiddleware`. */
function handler(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/**
 * The `program` association for a page of sprints, batched.
 *
 * One query for the whole page, never one per row. The internal list gets this
 * with a `LEFT JOIN document_associations`, which is fine for a single-row read
 * and produces a row multiplication on a list.
 */
async function programIdsFor(
  db: Database,
  sprintIds: readonly string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (sprintIds.length === 0) return map;
  const result = await db.query<{ document_id: string; related_id: string }>(
    `SELECT document_id, related_id FROM document_associations
      WHERE document_id = ANY($1::uuid[]) AND relationship_type = 'program'`,
    [[...sprintIds]],
  );
  for (const row of result.rows) map.set(row.document_id, row.related_id);
  return map;
}

/** Turns the domain's typed failures into the public envelope. */
function toApiError(err: unknown): unknown {
  if (err instanceof DuplicateSprintNumberError) {
    return new ApiError('validation_failed', 'The request body is not valid.', {
      details: { fields: [{ field: 'sprint_number', message: err.message }] },
      cause: err,
    });
  }
  if (err instanceof UnknownSprintReferenceError) {
    // A 422 rather than a 404: the thing that was not found is a value IN THE
    // BODY, so the request is what is wrong. A 404 here would also be a
    // cross-tenant existence oracle — it would distinguish "no such program"
    // from "a program you cannot see".
    return new ApiError('validation_failed', 'The request body is not valid.', {
      details: { fields: [{ field: err.field, message: err.message }] },
      cause: err,
    });
  }
  if (err instanceof InvalidSprintTransitionError) {
    return new ApiError('validation_failed', 'The request body is not valid.', {
      details: { fields: [{ field: 'status', message: err.message }] },
      cause: err,
    });
  }
  return err;
}

/**
 * Mounts the four routes, above the unknown-path catch-all.
 */
export function mountSprints(router: Router, deps: SprintsRouteDeps): void {
  const service = deps.service;

  // ── GET /api/v1/sprints ──────────────────────────────────────────────────
  router.get(
    '/sprints',
    listGuard,
    handler(async (req, res) => {
      const page = parsePageRequest(req.query as Record<string, unknown>, SPRINTS_RESOURCE);
      const ctx = domainContext(res, deps.db);

      const rows = await service.list(ctx, {
        limit: page.limit + 1,
        cursor: page.cursor ? { timestamp: page.cursor.timestamp, id: page.cursor.id } : null,
      });

      // The cursor is minted from the POSTGRES-rendered microsecond timestamp,
      // never from the `Date` node-postgres parsed — see the service.
      const sliced = sliceToPage(
        rows.map((row) => ({ ...row, created_at: row.created_at_cursor as string })),
        page.limit,
        SPRINTS_RESOURCE,
      );

      const programs = await programIdsFor(
        deps.db,
        sliced.data.map((row) => row.id),
      );

      res.json({
        data: sliced.data.map((row) => toPublicSprint(row, programs.get(row.id) ?? null)),
        next_cursor: sliced.next_cursor,
      });
    }),
  );

  // ── GET /api/v1/sprints/:id ──────────────────────────────────────────────
  router.get(
    '/sprints/:id',
    getGuard,
    handler(async (req, res) => {
      const params = sprintIdParamSchema.safeParse(req.params);
      if (!params.success) throw validationFailed(params.error);

      const ctx = domainContext(res, deps.db);
      const row = await service.get(ctx, { id: params.data.id });
      if (!row) throw notFound();

      const programs = await programIdsFor(deps.db, [row.id]);
      res.json(toPublicSprint(row, programs.get(row.id) ?? null));
    }),
  );

  // ── POST /api/v1/sprints ─────────────────────────────────────────────────
  router.post(
    '/sprints',
    createGuard,
    handler(async (req, res) => {
      const parsed = createSprintRequestSchema.safeParse(req.body);
      if (!parsed.success) throw validationFailed(parsed.error);

      const input = parsed.data;
      const ctx = domainContext(res, deps.db);

      let row;
      try {
        row = await service.create(ctx, {
          sprintNumber: input.sprint_number,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.owner_id !== undefined ? { ownerId: input.owner_id } : {}),
          ...(input.program_id !== undefined ? { programId: input.program_id } : {}),
        });
      } catch (err) {
        throw toApiError(err);
      }

      res
        .status(201)
        .location(`/api/v1/sprints/${row.id}`)
        .json(toPublicSprint(row, input.program_id ?? null));
    }),
  );

  // ── PATCH /api/v1/sprints/:id ────────────────────────────────────────────
  //
  // PF-291. The publish is NOT here — `sprintService.transition` owns it, which
  // is why a re-assertion of the current status emits nothing and an illegal
  // move throws before anything is written.
  router.patch(
    '/sprints/:id',
    patchGuard,
    handler(async (req, res) => {
      const params = sprintIdParamSchema.safeParse(req.params);
      if (!params.success) throw validationFailed(params.error);

      const parsed = patchSprintRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw validationFailed(parsed.error);

      const ctx = domainContext(res, deps.db);

      let moved;
      try {
        moved = await service.transition(ctx, { id: params.data.id, to: parsed.data.status });
      } catch (err) {
        throw toApiError(err);
      }
      if (!moved) throw notFound();

      // Re-read through `get` so the response carries the workspace anchor the
      // transition's own `RETURNING *` does not join in. One extra read on a
      // write path, in exchange for the PATCH body being byte-identical to what
      // a following GET returns — which is the property an SDK's
      // `update-then-cache` depends on.
      const row = await service.get(ctx, { id: params.data.id });
      if (!row) throw notFound();

      const programs = await programIdsFor(deps.db, [row.id]);
      res.json(toPublicSprint(row, programs.get(row.id) ?? null));
    }),
  );
}

/**
 * The `mountResources` callback the composition root composes.
 */
export function sprintsResources(deps: {
  db: Database;
  bus?: unknown;
}): (router: Router) => void {
  const service = createSprintService({ bus: deps.bus as never });
  return (router: Router) => mountSprints(router, { db: deps.db, service });
}

/** Re-exported so a test can assert the map was consulted rather than a literal typed. */
export { SPRINT_DOCUMENT_TYPE };
