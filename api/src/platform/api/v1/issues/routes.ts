/**
 * `/api/v1/issues` — list, by-id, create, patch.
 *
 * Tickets: PF-277 (list), PF-278 (by id), PF-279 (create), PF-280 (patch),
 * PF-281 (the `(created_at, id)` keyset), PF-282 (the projection), PF-283
 * (bidirectional resource/scope isolation).
 *
 * Built to L09's `documents/routes.ts` shape deliberately and almost line for
 * line. Two resources that answer the same questions with different code is two
 * places for the pagination contract, the not-found policy and the tenancy rule
 * to diverge, and the divergence would be invisible until a consumer hit it.
 *
 * ## What this file may not contain, and why a lint rule is not enough
 *
 * No SQL, and no import from `api/src/routes/**` or `api/src/middleware/**`.
 * The ESLint fence (PF-009/PF-010) catches the import half at build time.
 * `issues.fitness.test.ts` catches the COPY-PASTE half, which lint cannot see:
 * a handler that re-implements the query rather than calling the service
 * satisfies every lint rule and still breaks the p.3 boundary.
 *
 * ## The publish site is NOT here (PF-292)
 *
 * PRD p.3: *"Domain layer publishes on writes — never the route layer."*
 * `issue.created`, `issue.assigned` and `issue.status_changed` all fire inside
 * `services/issues.ts`. This module imports no events module and contains no
 * `.publish(`; the fitness test greps for both.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import { parsePageRequest, pageSchema } from '../page.js';
import { sliceToPage } from '../pagination.js';
import { declareV1Route } from '../declareV1Route.js';
import { getPlatformAuth } from '../../../scopes/require-scope.js';
import type { Database } from '../../../../db/client.js';
import {
  createIssueService,
  type IssueService,
  type DomainContext,
} from '../../../../services/issues.js';
import {
  createIssueRequestSchema,
  issueIdParamSchema,
  issueSchema,
  patchIssueRequestSchema,
  toPublicIssue,
} from './issues.schema.js';

/**
 * The cursor's resource binding. A cursor minted by `/documents` is REJECTED
 * here (PF-218) — it would decode perfectly, since its `id` is a real UUID and
 * its timestamp is a real timestamp, and would return a wrong-but-plausible page
 * that nobody ever notices.
 */
export const ISSUES_RESOURCE = 'issues';

export interface IssuesRouteDeps {
  db: Database;
  service: IssueService;
}

// ─────────────────────────────────────────────────────────────────────────────
// The four declarations, made ONCE at module load.
//
// `routeMetadata.declare()` throws on a duplicate key and a test suite mounts
// these routes into many apps, so declaration happens when this module is first
// imported and `mountIssues` only mounts. The guards close over nothing
// per-request and are therefore safe to share across every app in the process.
// ─────────────────────────────────────────────────────────────────────────────

const listGuard = declareV1Route({
  method: 'get',
  path: '/issues',
  scope: 'issues:read',
  list: 'cursor',
  resource: ISSUES_RESOURCE,
  response: pageSchema(issueSchema),
  summary: 'List issues, newest first.',
  description:
    'Ordered by `(created_at, id)` descending — NOT by priority or `updated_at`, which ' +
    'the issue board sorts on internally. Both of those are mutable by any update, so a ' +
    'cursor over them would skip and repeat rows; PRD p.3 requires cursors stable across ' +
    'reordering operations.',
});

const getGuard = declareV1Route({
  method: 'get',
  path: '/issues/:id',
  scope: 'issues:read',
  // Not a collection. `false` and `'none'` are different claims and neither is
  // a default — see routeMetadata.ts.
  list: false,
  params: issueIdParamSchema,
  response: issueSchema,
  summary: 'Fetch one issue by id.',
});

const createGuard = declareV1Route({
  method: 'post',
  path: '/issues',
  scope: 'issues:write',
  list: false,
  request: createIssueRequestSchema,
  response: issueSchema,
  summary: 'Create an issue.',
});

const patchGuard = declareV1Route({
  method: 'patch',
  path: '/issues/:id',
  scope: 'issues:write',
  list: false,
  params: issueIdParamSchema,
  request: patchIssueRequestSchema,
  response: issueSchema,
  summary: 'Update an issue’s title, state, priority, assignee or associations.',
  description:
    'A patch that changes nothing returns 200 and writes nothing — no history row and no ' +
    'event. `state` and `assignee_id` changes are what produce `issue.status_changed` and ' +
    '`issue.assigned`.',
});

/**
 * A `ZodError` becomes `details.fields[]`, per L07's PF-198 policy.
 *
 * NOT `error.errors` passed through, which is what the internal route does
 * (`details: parsed.error.errors`): Zod's issue objects carry `code`,
 * `expected`, `received` and a `path` array, and publishing them makes the
 * validation library part of the public contract.
 *
 * `unrecognized_keys` is special-cased because its `path` is EMPTY — Zod reports
 * the offending keys in `issue.keys` and points the path at the object itself.
 * Mapping it naively yields `field: ''` for every rejected internal field, which
 * is precisely the case PF-279 needs named: a caller who sent
 * `is_system_generated` has to be told `is_system_generated`.
 */
export function zodIssuesToFields(error: z.ZodError): { field: string; message: string }[] {
  const fields: { field: string; message: string }[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        fields.push({
          field: key,
          message:
            `Unknown field. It is not part of the public issue representation — ` +
            `internal-only fields are rejected rather than ignored, so a caller is never ` +
            `left believing they set one.`,
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

/**
 * PF-278 — one `not_found`, four ways to arrive at it, and NO `details`.
 *
 * (a) a well-formed UUID matching no row; (b) a UUID in another workspace;
 * (c) a soft-deleted row; (d) a row whose `document_type` is not `issue` —
 * which in a unified document model means **a wiki's id requested through
 * `/issues`**, and is the case that exists here and nowhere in a conventional
 * schema.
 *
 * (b) and (d) must not be 403. A 403 confirms the id EXISTS, which turns the
 * endpoint into a cross-tenant existence oracle: a caller iterating UUIDs learns
 * which ones are real in workspaces they cannot read. The four cases are
 * indistinguishable on the wire on purpose, and `CODES_WITHOUT_DETAILS` in
 * `errors.ts` already lists `not_found`.
 */
function notFound(): ApiError {
  return new ApiError('not_found', 'No issue with that id.');
}

/**
 * The domain context, built from the TOKEN and nothing else (PF-260).
 *
 * `workspaceId` comes from the bearer token's `PlatformAuthContext`, never from
 * a body, a query parameter or a header — `POST` with an explicit
 * `workspace_id` is a `validation_failed` from `.strict()`, not an override.
 *
 * `isAdmin` is deliberately NOT set: leaving it undefined selects the service's
 * subquery binding of the visibility rule, which costs one InitPlan inside a
 * query we were already issuing instead of a second round trip. The internal
 * surface passes its already-computed flag; both read the same predicate.
 */
function domainContext(res: Response, db: Database): DomainContext {
  const auth = getPlatformAuth(res);
  if (!auth) {
    // Unreachable behind the guards, which 401 on a missing context. Kept as a
    // throw rather than a `!` so a future re-order of the middleware stack fails
    // loudly instead of querying with `undefined` as the workspace.
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
 * Mounts the four routes. Called through `createPublicRouter`'s `mountResources`
 * hook so they land ABOVE the unknown-path catch-all — a resource router added
 * after `createPublicRouter` returns would sit below it and be permanently
 * unreachable, which looks exactly like "my route 404s for no reason".
 */
export function mountIssues(router: Router, deps: IssuesRouteDeps): void {
  const service = deps.service;

  // ── GET /api/v1/issues ───────────────────────────────────────────────────
  router.get(
    '/issues',
    listGuard,
    handler(async (req, res) => {
      // PF-226's strict allowlist. Note what is NOT passed as `extraAllowed`:
      // the internal list accepts `?state=`, `?priority=`, `?assignee_id=`,
      // `?program_id=`, `?sprint_id=` and `?parent_filter=`, and none of them is
      // offered publicly this week. Each would be a filter whose interaction
      // with cursor stability needs its own proof — a cursor minted under
      // `?state=todo` and replayed without it describes a different collection.
      // They are rejected with a named 422 rather than silently ignored.
      const page = parsePageRequest(req.query as Record<string, unknown>, ISSUES_RESOURCE);

      const ctx = domainContext(res, deps.db);

      // `limit + 1` — one extra row answers "is there more?" without a second
      // COUNT(*), which would double the query load on every page and be racy
      // besides.
      const rows = await service.list(ctx, {
        mode: 'keyset',
        limit: page.limit + 1,
        cursor: page.cursor ? { timestamp: page.cursor.timestamp, id: page.cursor.id } : null,
      });

      // The cursor is minted from `created_at_cursor` — the timestamp rendered
      // by POSTGRES at microsecond precision — and never from the `Date` that
      // node-postgres parsed. See CURSOR_TIMESTAMP_EXPR in the service: a JS
      // `Date` truncates to milliseconds, and the resulting bound silently skips
      // every row between those two instants on every page boundary.
      const sliced = sliceToPage(
        rows.map((row) => ({ ...row, created_at: row.created_at_cursor as string })),
        page.limit,
        ISSUES_RESOURCE,
      );

      // PF-296 — ONE association query for the whole page, not one per row.
      const associations = await service.associationsFor(
        ctx,
        sliced.data.map((row) => row.id),
      );

      res.json({
        data: sliced.data.map((row) => toPublicIssue(row, associations.get(row.id) ?? [])),
        // Present and NULL on the last page, never absent (PF-224).
        next_cursor: sliced.next_cursor,
      });
    }),
  );

  // ── GET /api/v1/issues/:id ───────────────────────────────────────────────
  router.get(
    '/issues/:id',
    getGuard,
    handler(async (req, res) => {
      // The id is validated as a UUID HERE, so `/issues/not-a-uuid` is
      // `validation_failed` and never a Postgres `invalid input syntax for type
      // uuid` surfacing as `server_error`.
      const params = issueIdParamSchema.safeParse(req.params);
      if (!params.success) throw validationFailed(params.error);

      const ctx = domainContext(res, deps.db);
      const row = await service.get(ctx, { id: params.data.id });
      if (!row) throw notFound();

      const associations = await service.associationsFor(ctx, [row.id]);
      res.json(toPublicIssue(row, associations.get(row.id) ?? []));
    }),
  );

  // ── POST /api/v1/issues ──────────────────────────────────────────────────
  router.post(
    '/issues',
    createGuard,
    handler(async (req, res) => {
      const parsed = createIssueRequestSchema.safeParse(req.body);
      if (!parsed.success) throw validationFailed(parsed.error);

      const input = parsed.data;
      const ctx = domainContext(res, deps.db);

      // `source`, `isSystemGenerated` and the accountability fields are NOT
      // forwarded and are not forwardable — the request schema rejected them.
      // The service defaults `source` to `'internal'`, which is the honest
      // description of an issue created by a consenting user's app.
      const row = await service.create(ctx, {
        title: input.title,
        ...(input.state !== undefined ? { state: input.state } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.assignee_id !== undefined ? { assigneeId: input.assignee_id } : {}),
        ...(input.belongs_to !== undefined ? { belongsTo: input.belongs_to } : {}),
      });

      const associations = await service.associationsFor(ctx, [row.id]);

      // `Location` points at the by-id route, so a consumer that wants the
      // canonical representation does not have to construct the URL itself.
      res
        .status(201)
        .location(`/api/v1/issues/${row.id}`)
        .json(toPublicIssue(row, associations.get(row.id) ?? []));
    }),
  );

  // ── PATCH /api/v1/issues/:id ─────────────────────────────────────────────
  //
  // PF-280 — shipped even though no MVP gate item asks for a public update.
  // Two of the eight registered event types (p.3) — `issue.assigned` and
  // `issue.status_changed` — have NO producer a platform consumer can trigger
  // without this route, which would make a quarter of the event registry
  // decorative for exactly the audience the week is about. The counter-argument
  // is recorded in the lane file's audit notes and is fair.
  router.patch(
    '/issues/:id',
    patchGuard,
    handler(async (req, res) => {
      const params = issueIdParamSchema.safeParse(req.params);
      if (!params.success) throw validationFailed(params.error);

      const parsed = patchIssueRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw validationFailed(parsed.error);

      const patch = parsed.data;
      const ctx = domainContext(res, deps.db);

      const result = await service.update(ctx, {
        id: params.data.id,
        patch: {
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.state !== undefined ? { state: patch.state } : {}),
          ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
          ...(patch.assignee_id !== undefined ? { assigneeId: patch.assignee_id } : {}),
          ...(patch.belongs_to !== undefined ? { belongsTo: patch.belongs_to } : {}),
        },
      });
      if (!result) throw notFound();

      const associations = await service.associationsFor(ctx, [result.row.id]);
      res.json(toPublicIssue(result.row, associations.get(result.row.id) ?? []));
    }),
  );
}

/**
 * The `mountResources` callback the composition root composes.
 *
 * Takes the db and builds the service with the injected bus, so the composition
 * root stays the only place a concrete is chosen (PF-014/PF-015).
 */
export function issuesResources(deps: {
  db: Database;
  bus?: unknown;
}): (router: Router) => void {
  const service = createIssueService({ bus: deps.bus as never });
  return (router: Router) => mountIssues(router, { db: deps.db, service });
}
