/**
 * `documentService` — the shared domain service for documents (PF-241, PF-242).
 *
 * ## Why this file exists
 *
 * `docs/architecture.md`'s Public/Internal Boundary diagram — the deliverable
 * PRD p.12 asks for, *"how /api/v1/ routes call the same domain services as
 * internal routes"* — names `documentService (utils/document-crud.ts)`. That was
 * a claim about a thing that did not exist. `api/src/utils/document-crud.ts` is
 * association and history helpers (`logDocumentChange`, `syncBelongsToAssociations`,
 * `getUserInfoBatch`, …) with no create, no update, no delete and no list, and
 * `api/src/routes/documents.ts` never imported it. The write SQL was inline in
 * the route handler and the list query was a module-level statement builder
 * beside it. So the boundary was drawn, not true. This file is the seam being
 * cut for real; it is finding F8.
 *
 * ## The rule this file obeys, and why it is worth the awkwardness
 *
 * **Nothing here knows what HTTP is.** No `express` import, no `req`, no `res`,
 * no `res.locals`, no `requireAuth(req)` (which throws `MissingAuthContextError`
 * off `req.userId` — `api/src/middleware/auth.ts:73`). The caller passes a
 * `DomainContext` of plain values.
 *
 * That is what makes the boundary diagram checkable rather than decorative: a
 * service that reaches for `req` can only ever be called from an Express
 * handler, so "both surfaces call the same domain service" would be false the
 * moment the public surface had a different auth model — which it does, because
 * bearer tokens are not sessions. `documents.service.test.ts` proves it by
 * creating a document in a bare Node context with no HTTP stack at all, and by
 * grepping this file for `express` and `../middleware/`.
 *
 * ## Two list shapes, deliberately
 *
 * `list()` takes a discriminated union rather than splitting into two exported
 * functions, because they are the same question asked with a different sort:
 *
 *   mode:'internal'  `ORDER BY position ASC, created_at DESC` — what the Ship
 *                    sidebar has always shown, drag-reorder and all. Preserved
 *                    byte-for-byte, named prepared statements and folded admin
 *                    subquery included (PF-264: that folding is a deliberate
 *                    optimisation and re-issuing `isWorkspaceAdmin()` per request
 *                    would undo it).
 *   mode:'keyset'    `ORDER BY created_at DESC, id DESC` — the public sort, on
 *                    columns nothing rewrites. `position` is mutable and a walk
 *                    paginating on it corrupts under a concurrent drag-reorder,
 *                    which is exactly what PRD p.3's "cursors are stable across
 *                    reordering operations" forbids.
 *
 * The two sorts are a real divergence and it is intentional. The internal list's
 * order is unchanged by this lane; `list-endpoints-regression.test.ts` is what
 * holds that.
 *
 * ## The visibility predicate is written ONCE
 *
 * `VISIBILITY_PREDICATE` below is shared by both modes and by `get()`. A public
 * caller acts *for a user* — the token carries a consenting `userId` — so it
 * sees exactly what that user sees and never the app's own view (PF-261). A
 * second copy of this predicate in the platform tree is the bug PF-244's grep
 * exists to catch: copy-pasted SQL satisfies every lint rule and still breaks
 * the boundary.
 */
import type { PoolClient } from 'pg';
import type { Database } from '../db/client.js';
import type { IEventBus } from '../platform/webhooks/bus.js';

/**
 * Everything the domain needs to know about who is asking. Plain values only.
 *
 * `userId` is nullable because a machine-to-machine token has no consenting user
 * (`PlatformAuthContext.userId: string | null`). A null user is not an error and
 * not an admin: the visibility predicate simply matches no private rows, which
 * is the correct reading of "an app with no user sees what any member sees".
 */
export interface DomainContext {
  workspaceId: string;
  userId: string | null;
  db: Database;
}

/**
 * The `documents` columns the internal list has always returned. Unchanged —
 * the internal surface's response body is a Part 1 contract (PF-243/PF-264).
 */
const DOCUMENTS_LIST_COLUMNS = `id, workspace_id, document_type, title, parent_id, position,
             ticket_number, properties,
             created_at, updated_at, created_by, visibility`;

/**
 * Row-level visibility, in one place.
 *
 * `$1` is the workspace and `$2` is the user, in both modes, so the fragment
 * composes without renumbering. The admin check is an uncorrelated scalar
 * subquery rather than a separate `isWorkspaceAdmin()` round trip: PostgreSQL
 * evaluates it once as an InitPlan, costing one index probe inside a query we
 * were already issuing instead of a second pool checkout on the request's
 * critical path. PF-264 asserts the query budget did not change, and this is the
 * line that would have changed it.
 */
const VISIBILITY_PREDICATE = `(visibility = 'workspace' OR created_by = $2
             OR (SELECT wm.role FROM workspace_memberships wm
                  WHERE wm.workspace_id = $1 AND wm.user_id = $2) = 'admin')`;

const DOCUMENTS_LIST_SELECT = `
      SELECT ${DOCUMENTS_LIST_COLUMNS}
      FROM documents
      WHERE workspace_id = $1
        AND archived_at IS NULL
        AND deleted_at IS NULL
        AND ${VISIBILITY_PREDICATE}`;

const DOCUMENTS_LIST_ORDER = ` ORDER BY position ASC, created_at DESC`;

/**
 * The timestamp a CURSOR is minted from — rendered by Postgres, at microsecond
 * precision, and never by JavaScript.
 *
 * This is not a stylistic preference; it is a row-loss bug found by the tie test
 * in `documents.pagination.test.ts`. `timestamptz` stores MICROseconds.
 * node-postgres parses it into a JS `Date`, which holds MILLIseconds, so
 * `row.created_at.toISOString()` silently truncates `…:00.123456Z` to
 * `…:00.123Z`. Feed that back as the keyset bound and
 *
 *     (created_at, id) < ('…:00.123Z', id)
 *
 * excludes every row between `.123000` and `.123456` — rows strictly OLDER than
 * the cursor's own row, which the consumer should have received next. They are
 * skipped, on every page boundary, with no error. With rows one second apart it
 * never fires; with rows created in the same millisecond — a bulk import, a
 * seeded fixture, a busy second — the walk can end after one page.
 *
 * Rendering the bound in SQL keeps the full precision end to end: this string
 * goes into the cursor and comes back as `$n::timestamptz`, which Postgres
 * parses at the same precision it wrote. `Date.parse` accepts the extra digits
 * (it truncates for its own purposes), so L08's `bad-timestamp` validation is
 * satisfied without the value passing through a lossy `Date` on the way.
 */
const CURSOR_TIMESTAMP_EXPR = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export type ParentFilter = 'any' | 'null' | 'value';

// Statement text must be stable for a given name, so it is derived from the
// shape and memoised rather than rebuilt per request. Moved here verbatim from
// `routes/documents.ts`; the names are unchanged, which matters because a
// pooled connection caches by name and a renamed statement re-plans everywhere.
const documentsListStatements = new Map<string, string>();

function documentsListStatement(
  hasType: boolean,
  parentFilter: ParentFilter,
): { name: string; text: string } {
  const name = `documents_list_${hasType ? 't' : 'x'}_${parentFilter}`;
  let text = documentsListStatements.get(name);
  if (text === undefined) {
    // $1 and $2 are always workspace id and user id, so the optional filters
    // take $3 and $4 in the order the caller pushes them.
    const parentParam = hasType ? '$4' : '$3';
    let sql = DOCUMENTS_LIST_SELECT;
    if (hasType) sql += ` AND document_type = $3`;
    if (parentFilter === 'null') sql += ` AND parent_id IS NULL`;
    else if (parentFilter === 'value') sql += ` AND parent_id = ${parentParam}`;
    text = sql + DOCUMENTS_LIST_ORDER;
    documentsListStatements.set(name, text);
  }
  return { name, text };
}

/** A document row as the domain hands it back. Deliberately `unknown`-free but wide. */
export interface DocumentRow {
  id: string;
  workspace_id: string;
  document_type: string;
  title: string;
  parent_id: string | null;
  position?: number | null;
  ticket_number?: number | null;
  properties?: Record<string, unknown> | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
  created_by: string | null;
  visibility?: string;
  [column: string]: unknown;
}

/** The keyset cursor position a public page resumes from. */
export interface KeysetCursor {
  timestamp: string;
  id: string;
}

export type ListInput =
  | {
      mode: 'internal';
      /** `?type=` — absent means every type, which is the internal behaviour. */
      type?: string | undefined;
      /**
       * `undefined` = no parent filter at all.
       * `null`, `'null'` or `''` = top-level documents only.
       * any other string = that parent's children.
       *
       * The string `'null'` is a sentinel and not an accident: `?parent_id=null`
       * is what the Ship frontend sends to ask for roots, so the value arrives
       * as the four characters `n-u-l-l`. Treating it as a UUID is a `500`
       * (`invalid input syntax for type uuid`), which is how this was caught —
       * `list-endpoints-regression.test.ts` covers both spellings.
       */
      parentId?: string | null | undefined;
    }
  | {
      mode: 'keyset';
      /**
       * The document types this surface is allowed to return. REQUIRED, and
       * there is no "all types" value — see `PUBLIC_DOCUMENT_TYPES` (PF-250).
       * An unfiltered public list serves issues and sprints under
       * `documents:read`, which makes `issues:read` decorative (finding F16).
       */
      documentTypes: readonly string[];
      /** Rows to fetch. Callers pass `limit + 1` to detect the last page. */
      limit: number;
      cursor: KeysetCursor | null;
    };

export interface GetInput {
  id: string;
  /**
   * Restrict to these types. A row outside the list is reported as absent
   * rather than forbidden — PF-255: a 403 here would confirm the id exists,
   * which is a cross-tenant existence oracle.
   */
  documentTypes?: readonly string[] | undefined;
}

export interface CreateInput {
  title: string;
  documentType: string;
  parentId?: string | null | undefined;
  programId?: string | null | undefined;
  sprintId?: string | null | undefined;
  properties?: Record<string, unknown> | undefined;
  visibility?: 'private' | 'workspace' | undefined;
  content?: unknown;
  belongsTo?: readonly { id: string; type: string }[] | undefined;
}

export interface DocumentServiceDeps {
  /**
   * PF-262 — the bus the domain publishes writes on, injected from
   * `createApp(deps)` rather than imported.
   *
   * L14's PF-404 adds `document.created` INSIDE `create()` below, with no route
   * file touched, because PRD p.3 is explicit: *"Domain layer publishes on
   * writes — never the route layer."* The signature carries the bus today so
   * that lands as an added call and not a re-plumbing. It is optional so the
   * internal route — which predates the bus and must stay byte-for-byte — can
   * keep calling the service without one.
   */
  bus?: IEventBus | undefined;
}

/**
 * Builds the service. A factory rather than a module-level object so the bus is
 * injected at the composition root (`api/src/deps.ts`) instead of reached for,
 * which is the same Dependency Inversion discipline every other platform
 * concrete follows.
 */
export function createDocumentService(deps: DocumentServiceDeps = {}) {
  /**
   * List documents.
   *
   * Returns raw rows. Projection is the caller's job on purpose: the internal
   * surface flattens `properties` into legacy top-level fields and the public
   * surface applies an allowlist (PF-252). Doing either here would force the
   * other to undo it.
   */
  async function list(ctx: DomainContext, input: ListInput): Promise<DocumentRow[]> {
    if (input.mode === 'internal') {
      const parentFilter: ParentFilter =
        input.parentId === undefined
          ? 'any'
          : input.parentId === null || input.parentId === 'null' || input.parentId === ''
            ? 'null'
            : 'value';

      const { name, text } = documentsListStatement(Boolean(input.type), parentFilter);
      const params: (string | null)[] = [ctx.workspaceId, ctx.userId];
      if (input.type) params.push(input.type);
      if (parentFilter === 'value') params.push(input.parentId as string);

      const result = await ctx.db.query<DocumentRow>({ name, text, values: params });
      return result.rows;
    }

    // ── keyset (public) ──────────────────────────────────────────────────
    //
    // `$3::document_type[]` and not `document_type::text = ANY(...)`: casting the
    // COLUMN would make the type filter unindexable, while casting the parameter
    // leaves the column bare. `document_type` is a real Postgres enum
    // (`schema.sql:100`), so the array literal has to be cast to it explicitly.
    const params: unknown[] = [ctx.workspaceId, ctx.userId, [...input.documentTypes]];
    let sql = `
      SELECT ${DOCUMENTS_LIST_COLUMNS},
             ${CURSOR_TIMESTAMP_EXPR} AS created_at_cursor
      FROM documents
      WHERE workspace_id = $1
        AND archived_at IS NULL
        AND deleted_at IS NULL
        AND ${VISIBILITY_PREDICATE}
        AND document_type = ANY($3::document_type[])`;

    if (input.cursor) {
      // PF-219's predicate, as a ROW COMPARISON. The equivalent
      // `created_at < $4 OR (created_at = $4 AND id < $5)` plans as a bitmap-or
      // or a seq scan; the row form becomes an index range scan. The explicit
      // casts are load-bearing — node-postgres sends both as text, and without
      // them Postgres compares timestamptz to text and stops using the index.
      params.push(input.cursor.timestamp, input.cursor.id);
      sql += `
        AND (created_at, id) < ($4::timestamptz, $5::uuid)`;
    }

    params.push(input.limit);
    sql += `
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`;

    const result = await ctx.db.query<DocumentRow>(sql, params);
    return result.rows;
  }

  /**
   * One document by id, or `null`.
   *
   * `null` covers every way to miss — wrong workspace, soft-deleted, not
   * visible to this user, type outside the allowed set — because to a caller
   * they are the same answer and distinguishing them leaks existence (PF-255).
   */
  async function get(ctx: DomainContext, input: GetInput): Promise<DocumentRow | null> {
    const params: unknown[] = [ctx.workspaceId, ctx.userId, input.id];
    let sql = `
      SELECT ${DOCUMENTS_LIST_COLUMNS}
      FROM documents
      WHERE workspace_id = $1
        AND deleted_at IS NULL
        AND ${VISIBILITY_PREDICATE}
        AND id = $3::uuid`;

    if (input.documentTypes) {
      params.push([...input.documentTypes]);
      sql += `
        AND document_type = ANY($4::document_type[])`;
    }

    const result = await ctx.db.query<DocumentRow>(sql, params);
    return result.rows[0] ?? null;
  }

  /**
   * Create a document and its associations, in one transaction.
   *
   * `RETURNING *` is kept HERE and is correct here: the internal route's 201
   * body is every column and that is a Part 1 contract this lane must not
   * change (PF-243). What must never happen is that row reaching an external
   * consumer — `yjs_state`, `deleted_at`, `position`, `converted_from_id` are
   * Ship's internal schema, and shipping them would make it the public
   * contract (finding F17). The public surface therefore projects through an
   * explicit allowlist (PF-252) rather than trimming this. An allowlist is the
   * only form that stays correct when a column is added.
   */
  async function create(ctx: DomainContext, input: CreateInput): Promise<DocumentRow> {
    const client: PoolClient = await ctx.db.connect();
    try {
      let visibility = input.visibility;

      // Inherit the parent's visibility when the caller did not choose one.
      // Preserved from the internal handler: a child of a private page that
      // silently defaults to workspace-visible is a disclosure.
      if (input.parentId && !visibility) {
        const parentResult = await client.query(
          'SELECT visibility FROM documents WHERE id = $1 AND workspace_id = $2',
          [input.parentId, ctx.workspaceId],
        );
        if (parentResult.rows[0]) {
          visibility = parentResult.rows[0].visibility;
        }
      }

      visibility = visibility || 'workspace';

      await client.query('BEGIN');

      const result = await client.query(
        `INSERT INTO documents (workspace_id, document_type, title, parent_id, properties, created_by, visibility, content)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
        [
          ctx.workspaceId,
          input.documentType,
          input.title,
          input.parentId || null,
          JSON.stringify(input.properties || {}),
          ctx.userId,
          visibility,
          input.content ? JSON.stringify(input.content) : null,
        ],
      );

      const newDoc = result.rows[0] as DocumentRow;

      // `belongs_to` associations (document_associations rows).
      if (input.belongsTo && input.belongsTo.length > 0) {
        for (const assoc of input.belongsTo) {
          await client.query(
            `INSERT INTO document_associations (document_id, related_id, relationship_type)
           VALUES ($1, $2, $3)
           ON CONFLICT (document_id, related_id, relationship_type) DO NOTHING`,
            [newDoc.id, assoc.id, assoc.type],
          );
        }
      }

      // sprint_id via document_associations (backward compatibility).
      if (input.sprintId) {
        await client.query(
          `INSERT INTO document_associations (document_id, related_id, relationship_type)
           VALUES ($1, $2, 'sprint')
           ON CONFLICT (document_id, related_id, relationship_type) DO NOTHING`,
          [newDoc.id, input.sprintId],
        );
      }

      // program_id via document_associations (mirrors column for junction queries).
      if (input.programId) {
        await client.query(
          `INSERT INTO document_associations (document_id, related_id, relationship_type)
           VALUES ($1, $2, 'program')
           ON CONFLICT (document_id, related_id, relationship_type) DO NOTHING`,
          [newDoc.id, input.programId],
        );
      }

      await client.query('COMMIT');

      // PF-262 / L14's PF-404 lands HERE — after COMMIT, inside the service,
      // with `deps.bus`. Not in a route handler: two surfaces creating documents
      // means two publish sites, and the one nobody remembers is the one that
      // stops firing. Deliberately not implemented by this lane; the seam is.

      return newDoc;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  return { list, get, create, bus: deps.bus };
}

export type DocumentService = ReturnType<typeof createDocumentService>;

/**
 * The default instance the INTERNAL routes use.
 *
 * The internal surface predates dependency injection and its handlers are
 * module-level; giving it a service instance here keeps PF-241's extraction from
 * turning into a rewrite of `routes/documents.ts`'s wiring. The public surface
 * takes its instance from `createApp(deps)` so the bus is injected (PF-262).
 */
export const documentService: DocumentService = createDocumentService();
