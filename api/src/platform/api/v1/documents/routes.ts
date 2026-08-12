/**
 * `/api/v1/documents` — list, by-id, create.
 *
 * Tickets: PF-245 (list), PF-246 (by id), PF-247 (create), PF-248 (metadata),
 * PF-250 (`PUBLIC_DOCUMENT_TYPES`), PF-252 (projection), PF-254
 * (`validation_failed`), PF-255 (`not_found`), PF-256/257 (keyset list),
 * PF-260/261 (tenancy and visibility).
 *
 * MVP gate item 4 (PRD p.2): *"At least one resource (documents) implements GET
 * list, GET by id, and POST. Each route declares its required scope via a
 * require(scope) middleware factory."* These are those three routes.
 *
 * ## What this file may not contain, and why a lint rule is not enough
 *
 * No SQL, and no import from `api/src/routes/**` or `api/src/middleware/**`.
 * The ESLint fence (PF-009/PF-010) catches the import half at build time.
 * `documents.fitness.test.ts` catches the COPY-PASTE half, which lint cannot
 * see: a handler that re-implements the query rather than importing the service
 * satisfies every lint rule and still breaks the p.3 boundary, and it is the
 * likelier mistake — inlining one small `SELECT` never feels like an
 * architectural decision at the moment it is made.
 *
 * Every read and write goes through `documentService` (PF-241), which is the
 * same function `api/src/routes/documents.ts` calls. That is what makes
 * `docs/architecture.md`'s Public/Internal Boundary diagram a fact.
 *
 * ## The publish site is NOT here
 *
 * PRD p.3: *"Domain layer publishes on writes — never the route layer."* L14's
 * `document.created` goes inside `documentService.create`, which already takes
 * an injected bus (PF-262). This module imports no events module and contains no
 * `.publish(`; the fitness test greps for both.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import { parsePageRequest } from '../page.js';
import { sliceToPage, cursorForRow } from '../pagination.js';
import { declareV1Route } from '../declareV1Route.js';
import { getPlatformAuth } from '../../../scopes/require-scope.js';
import type { Database } from '../../../../db/client.js';
import {
  createDocumentService,
  type DocumentService,
  type DomainContext,
} from '../../../../services/documents.js';
import {
  PUBLIC_DOCUMENT_TYPES,
  createDocumentRequestSchema,
  documentIdParamSchema,
  documentSchema,
  toPublicDocument,
} from './documents.schema.js';
import { pageSchema } from '../page.js';

/** The cursor's resource binding. A cursor minted here is rejected elsewhere (PF-218). */
export const DOCUMENTS_RESOURCE = 'documents';

export interface DocumentsRouteDeps {
  db: Database;
  service: DocumentService;
}

// ─────────────────────────────────────────────────────────────────────────────
// PF-248 — the three declarations, made ONCE at module load.
//
// `routeMetadata.declare()` throws on a duplicate key, and a test suite mounts
// these routes into many apps. Declaring at import time means one record per
// route for the life of the process, which is what the registry is for. The
// guards are built here too and shared across mounts: they close over the
// registry definition resolved at wiring time and nothing per-request.
// ─────────────────────────────────────────────────────────────────────────────

const listGuard = declareV1Route({
  method: 'get',
  path: '/documents',
  scope: 'documents:read',
  list: 'cursor',
  resource: DOCUMENTS_RESOURCE,
  response: pageSchema(documentSchema),
});

const getGuard = declareV1Route({
  method: 'get',
  path: '/documents/:id',
  scope: 'documents:read',
  // Not a collection. `false` and `'none'` are different claims and neither is a
  // default — see routeMetadata.ts.
  list: false,
  response: documentSchema,
});

const createGuard = declareV1Route({
  method: 'post',
  path: '/documents',
  scope: 'documents:write',
  list: false,
  request: createDocumentRequestSchema,
  response: documentSchema,
});

/**
 * PF-254 — a `ZodError` becomes `details.fields[]`, per L07's PF-198 policy.
 *
 * NOT `z.ZodError.errors` passed through, which is what the internal route does
 * (`api/src/routes/documents.ts`, `details: parsed.error.errors`). Zod's issue
 * objects carry `code`, `expected`, `received` and a `path` array — that is
 * Zod's internal vocabulary, and publishing it makes the validation library a
 * part of the public contract that cannot be changed without a breaking change.
 *
 * `unrecognized_keys` is special-cased because its `path` is EMPTY: Zod reports
 * the offending keys in `issue.keys` and points the path at the object itself.
 * Mapping it naively yields `field: ''` for every rejected internal field, which
 * is precisely the case PF-253 needs named — a caller who sent `position` has to
 * be told `position`.
 */
export function zodIssuesToFields(error: z.ZodError): { field: string; message: string }[] {
  const fields: { field: string; message: string }[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        fields.push({
          field: key,
          message:
            `Unknown field. It is not part of the public document representation — ` +
            `internal-only columns are rejected rather than ignored, so a caller is ` +
            `never left believing they set one.`,
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
 * PF-255 — one `not_found`, four ways to arrive at it, and NO `details`.
 *
 * (a) a well-formed UUID matching no row; (b) a UUID in another workspace;
 * (c) a soft-deleted row; (d) a row whose type is outside PUBLIC_DOCUMENT_TYPES.
 *
 * (b) and (d) must not be 403. A 403 confirms the id EXISTS, which turns the
 * endpoint into a cross-tenant existence oracle: a caller iterating UUIDs learns
 * which ones are real in workspaces they cannot read. The four cases are
 * indistinguishable on the wire on purpose, and `CODES_WITHOUT_DETAILS` in
 * `errors.ts` already lists `not_found` — anything in `details` here would be
 * the leak arriving by another route.
 */
function notFound(): ApiError {
  return new ApiError('not_found', 'No document with that id.');
}

/**
 * PF-260 — the domain context, built from the TOKEN and nothing else.
 *
 * `workspaceId` comes from the bearer token's `PlatformAuthContext`, never from
 * a body, a query parameter or a header. `POST` with an explicit `workspace_id`
 * is a `validation_failed` (PF-253's `.strict()`), not an override — which is
 * the difference between a multi-tenant API and a multi-tenant API with a hole
 * in it.
 *
 * `userId` may be null for a machine-to-machine token. That is not an error: the
 * visibility predicate simply matches no private rows, so an app acting without
 * a user sees what any member sees and no more (PF-261).
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
 * Mounts the three routes. Called through `createPublicRouter`'s `mountResources`
 * hook so they land ABOVE the unknown-path catch-all — a resource router added
 * after `createPublicRouter` returns would sit below it and be permanently
 * unreachable, which looks exactly like "my route 404s for no reason".
 */
export function mountDocuments(router: Router, deps: DocumentsRouteDeps): void {
  const service = deps.service;

  // ── GET /api/v1/documents ────────────────────────────────────────────────
  router.get(
    '/documents',
    listGuard,
    handler(async (req, res) => {
      // PF-226's strict allowlist: `?offset=`, `?per_page=`, `?sort=` and a
      // typo'd `?limt=` are all 422s naming the parameter, rather than ignored
      // keys that succeed with the wrong data and no signal.
      const page = parsePageRequest(
        req.query as Record<string, unknown>,
        DOCUMENTS_RESOURCE,
      );

      // `limit + 1` — one extra row answers "is there more?" without a second
      // COUNT(*), which would double the query load on every page and be racy
      // besides. PF-224.
      const rows = await service.list(domainContext(res, deps.db), {
        mode: 'keyset',
        documentTypes: PUBLIC_DOCUMENT_TYPES,
        limit: page.limit + 1,
        cursor: page.cursor
          ? { timestamp: page.cursor.timestamp, id: page.cursor.id }
          : null,
      });

      // The cursor is minted from `created_at_cursor` — the timestamp rendered by
      // POSTGRES at microsecond precision — and never from the `Date` that
      // node-postgres parsed. A JS `Date` holds milliseconds, so
      // `created_at.toISOString()` truncates `…00.123456Z` to `…00.123Z`, and the
      // resulting bound silently SKIPS every row between those two instants on
      // every page boundary. See CURSOR_TIMESTAMP_EXPR in the service.
      const sliced = sliceToPage(
        rows.map((row) => ({ ...row, created_at: row.created_at_cursor as string })),
        page.limit,
        DOCUMENTS_RESOURCE,
      );

      res.json({
        data: sliced.data.map(toPublicDocument),
        // Present and NULL on the last page, never absent (PF-224). To a typed
        // SDK consumer `{data}` and `{data, next_cursor: null}` are different:
        // the first deserialises to `undefined` in TS, `KeyError` in Python and
        // a nil-pointer in Go.
        next_cursor: sliced.next_cursor,
      });
    }),
  );

  // ── GET /api/v1/documents/:id ────────────────────────────────────────────
  router.get(
    '/documents/:id',
    getGuard,
    handler(async (req, res) => {
      // PF-246 — the id is validated as a UUID HERE, so `/documents/not-a-uuid`
      // is `validation_failed` and never a Postgres `invalid input syntax for
      // type uuid` surfacing as `server_error`. The internal equivalent has no
      // such guard: `canAccessDocument` passes `$1` straight through.
      const params = documentIdParamSchema.safeParse(req.params);
      if (!params.success) throw validationFailed(params.error);

      const row = await service.get(domainContext(res, deps.db), {
        id: params.data.id,
        documentTypes: PUBLIC_DOCUMENT_TYPES,
      });
      if (!row) throw notFound();

      res.json(toPublicDocument(row));
    }),
  );

  // ── POST /api/v1/documents ───────────────────────────────────────────────
  router.post(
    '/documents',
    createGuard,
    handler(async (req, res) => {
      const parsed = createDocumentRequestSchema.safeParse(req.body);
      if (!parsed.success) throw validationFailed(parsed.error);

      const input = parsed.data;
      const row = await service.create(domainContext(res, deps.db), {
        title: input.title,
        documentType: input.document_type,
        parentId: input.parent_id,
        properties: input.properties,
        visibility: input.visibility,
        belongsTo: input.belongs_to,
      });

      // `Location` points at the PF-246 route, so a consumer that wants the
      // canonical representation does not have to construct the URL itself.
      res.status(201).location(`/api/v1/documents/${row.id}`).json(toPublicDocument(row));
    }),
  );
}

/**
 * The `mountResources` callback `createApp` passes to `createPublicRouter`.
 *
 * Takes the db and builds the service with the injected bus, so the composition
 * root stays the only place a concrete is chosen (PF-014/PF-015).
 */
export function documentsResources(deps: {
  db: Database;
  bus?: unknown;
}): (router: Router) => void {
  const service = createDocumentService({ bus: deps.bus as never });
  return (router: Router) => mountDocuments(router, { db: deps.db, service });
}

/** Re-exported so a caller does not have to know which sibling file it lives in. */
export { cursorForRow };
