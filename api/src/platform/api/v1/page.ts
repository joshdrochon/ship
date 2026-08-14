/**
 * `Page<T> = { data, next_cursor }` — the ONE list-response shape, and the query
 * validation that produces it.
 *
 * Tickets: PF-223 (the strict schema), PF-224 (`next_cursor` present-and-null),
 * PF-225 (`limit` rejected not clamped), PF-226 (strict query-param allowlist).
 *
 * The schema below is THE definition of the wire shape. The serializer, the
 * route-fitness clause and any OpenAPI generation all import it — same discipline
 * as `apiErrorBodySchema` in `errors.ts`, and `grep -rn "pageSchema"` is the
 * proof there is one. A second copy of a response shape is a second answer to
 * "what does a list return", and the wrong one is always the one in production.
 */
import { z } from 'zod';
import { ApiError, type ApiErrorCode } from './errors.js';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  PAGE_SIZE_PARAM,
  CURSOR_PARAM,
  decodeCursor,
  CURSOR_REJECTION_MESSAGE,
  type CursorPayload,
} from './pagination.js';

/**
 * PF-223 — a list response, and nothing else.
 *
 * `.strict()` rejects an unknown top-level key. That is what stops a route
 * quietly adding `total`, `page`, `has_more` or `meta`: each of those is a
 * second, undocumented pagination protocol, and a consumer that finds one starts
 * depending on it. A handler returning a bare array fails too, because an array
 * is not an object.
 *
 * `data` is `.array()` with no `.nullable()` and no `.optional()`: always an
 * array, `[]` on an empty result, never `null` and never absent. A consumer
 * writing `for (const x of body.data)` must never need a guard.
 */
export function pageSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z
    .object({
      data: z.array(itemSchema),
      // `.nullable()` and NOT `.optional()`. The key must be PRESENT and null on
      // the last page — see `assertLastPageShape` below for why the difference
      // is load-bearing to a typed SDK consumer.
      next_cursor: z.string().nullable(),
    })
    .strict();
}

/** The shape with no opinion about the items — for the fitness clause. */
export const anyPageSchema = pageSchema(z.unknown());

// `Page<T>` is declared once, in pagination.ts, beside the codec that produces
// the cursor inside it. Re-exported rather than redeclared — two structurally
// identical interfaces are two things to keep in step.
export type { Page } from './pagination.js';

/**
 * PF-224 — the assertion that `next_cursor` is present-and-null, not absent.
 *
 * `body.next_cursor == null` is true for BOTH an explicit null and a missing
 * key, which is exactly why it is the wrong check. To a typed SDK consumer the
 * two are different: `{ data, next_cursor: null }` deserialises into a field the
 * iterator can read and stop on, while `{ data }` deserialises into `undefined`
 * in TypeScript, `KeyError` in Python and a nil-pointer in Go. Zod's `.nullable()`
 * enforces presence; this function is the runtime check the fitness clause uses.
 */
export function assertLastPageShape(body: unknown): void {
  if (typeof body !== 'object' || body === null) {
    throw new Error(`expected an object, got ${typeof body}`);
  }
  if (!('next_cursor' in body)) {
    throw new Error(
      'the `next_cursor` key is ABSENT. On the last page it must be present and null — ' +
        'an omitted key and an explicit null are different to every typed SDK consumer.',
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PF-225 / PF-226 — query validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The query parameters EVERY cursor-paginated list accepts. A route adds its own
 * filters to this set; anything outside the union is rejected.
 */
export const PAGINATION_PARAMS: readonly string[] = [PAGE_SIZE_PARAM, CURSOR_PARAM];

/**
 * PF-362 — the same two parameters, as Zod, for the generator to walk.
 *
 * Lives HERE rather than in `platform/openapi/` deliberately. The spec module
 * restating "a list endpoint takes `limit` and `cursor`" would be a second
 * definition of the pagination protocol, in the one directory this lane exists
 * to keep free of hand-written contract — and it would be the copy that goes
 * stale, because the runtime never reads it.
 *
 * `cursor` is `z.string()`, and that is the load-bearing part. The cursors are
 * opaque base64url over `{id, timestamp, resource}`; a spec that typed the
 * parameter `integer` would tell every SDK generator and every reader that this
 * is an offset API, which is the exact misunderstanding `POINTED_REJECTIONS`
 * exists to correct at runtime.
 *
 * `limit` is `.coerce`d because query strings are strings on the wire. The
 * runtime validator is `parseLimit`, which is stricter than this (it rejects
 * `'1.5'`, `'0x10'` and repeated keys); this schema's job is to describe the
 * parameter to a reader, not to replace that check.
 */
export const paginationQuerySchema = z.object({
  [PAGE_SIZE_PARAM]: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .optional()
    .describe(
      `Page size. Default ${DEFAULT_PAGE_SIZE}, maximum ${MAX_PAGE_SIZE}. ` +
        `Values above the maximum are rejected with 422, not clamped.`,
    ),
  [CURSOR_PARAM]: z
    .string()
    .optional()
    .describe(
      'Opaque cursor from the previous response\'s `next_cursor`. Not an offset — ' +
        'it is base64url and is bound to the collection that minted it.',
    ),
});

/**
 * Parameters that are rejected with a POINTED message rather than a generic
 * "unknown parameter".
 *
 * Each one is a thing a consumer plausibly tries, and each silent success would
 * be its own bug:
 *
 *   `offset`/`page`  a consumer porting from an offset API. Ignored silently,
 *                    every request returns page 1 and their loop never advances.
 *   `per_page`/`page_size`  the two other common spellings of `limit`. Ignored,
 *                    and they silently get 25 rows while believing they asked
 *                    for 100.
 *   `fields`         sparse fieldsets. NOT IMPLEMENTED this week — and this
 *                    allowlist is what makes that verifiable rather than a note
 *                    in a document nobody reads.
 *   `sort`/`order`   the sort key is `(created_at, id)` and is not negotiable:
 *                    a caller-chosen sort has no cursor stability guarantee.
 */
export const POINTED_REJECTIONS: Record<string, string> = {
  offset: `This API paginates by cursor, not offset. Use \`${CURSOR_PARAM}\` from the previous response's \`next_cursor\`.`,
  page: `This API paginates by cursor, not page number. Use \`${CURSOR_PARAM}\` from the previous response's \`next_cursor\`.`,
  per_page: `Unknown parameter. The page-size parameter is \`${PAGE_SIZE_PARAM}\`.`,
  page_size: `Unknown parameter. The page-size parameter is \`${PAGE_SIZE_PARAM}\`.`,
  fields: 'Sparse fieldsets are not supported. Every response returns the full representation.',
  sort: 'The sort order is fixed at newest-first and cannot be chosen. Cursor stability depends on it.',
  order: 'The sort order is fixed at newest-first and cannot be chosen. Cursor stability depends on it.',
};

export interface ValidationField {
  field: string;
  message: string;
}

/** Raises the `validation_failed` envelope with a fields array. */
function validationFailed(fields: ValidationField[]): ApiError {
  const code: ApiErrorCode = 'validation_failed';
  return new ApiError(code, 'The request query is not valid.', { details: { fields } });
}

/**
 * PF-226 — the strict allowlist.
 *
 * DECISION, and it is a strong one: any parameter not explicitly allowed is a
 * 422, not an ignored key. The cost is real — a future optional parameter is a
 * breaking change for a caller who was already sending it under that name — and
 * it is worth paying, because the alternative is that every consumer mistake
 * (`?offset=10`, `?per_page=50`, a typo'd `?limt=5`) succeeds with the wrong
 * data and no signal. Ignoring unknown parameters means the API cannot tell a
 * consumer they are wrong, and the consumer finds out from a user.
 *
 * It is also the only cheap way to make "sparse fieldsets are out of scope"
 * checkable instead of asserted.
 */
export function assertAllowedQueryParams(
  query: Record<string, unknown>,
  extraAllowed: readonly string[] = [],
): void {
  const allowed = new Set([...PAGINATION_PARAMS, ...extraAllowed]);
  const unknown = Object.keys(query).filter((key) => !allowed.has(key));
  if (unknown.length === 0) return;

  throw validationFailed(
    unknown.map((field) => ({
      field,
      message:
        POINTED_REJECTIONS[field] ??
        `Unknown query parameter. This endpoint accepts: ${[...allowed].sort().join(', ')}.`,
    })),
  );
}

/**
 * PF-225 — `limit`, rejected rather than clamped.
 *
 * DECISION: an out-of-range `limit` is a 422. GitHub and most large APIs clamp,
 * and clamping is the more common industry choice — it is rejected here because
 * a clamp breaks the loop a CLI author actually writes:
 *
 *     while (data.length === limit) { … fetch the next page … }
 *
 * With `?limit=500` clamped to 100, `data.length` is 100 forever, the condition
 * is never false, and the loop runs until the process is killed. The failure
 * appears as a hang in the consumer's code, miles from its cause. A 422 naming
 * `limit` and the maximum is one line in a changelog and zero debugging.
 *
 * `1.5` and `abc` are rejected for the same reason: `parseInt('1.5')` is 1 and
 * `parseInt('abc')` is NaN, and both silently become a page size the caller did
 * not ask for.
 */
export function parseLimit(raw: unknown): number {
  if (raw === undefined) return DEFAULT_PAGE_SIZE;

  if (typeof raw !== 'string') {
    // `?limit=1&limit=2` arrives as an array. Two values is not a page size.
    throw validationFailed([
      {
        field: PAGE_SIZE_PARAM,
        message: `Expected a single integer value between 1 and ${MAX_PAGE_SIZE}.`,
      },
    ]);
  }

  // Deliberately strict: `Number()` accepts '', ' 5 ', '0x10', '1e2' and Infinity.
  if (!/^\d+$/.test(raw)) {
    throw validationFailed([
      {
        field: PAGE_SIZE_PARAM,
        message: `Expected an integer between 1 and ${MAX_PAGE_SIZE}, got "${raw}".`,
      },
    ]);
  }

  const value = Number.parseInt(raw, 10);
  if (value < 1 || value > MAX_PAGE_SIZE) {
    throw validationFailed([
      {
        field: PAGE_SIZE_PARAM,
        message:
          `Expected an integer between 1 and ${MAX_PAGE_SIZE}, got ${value}. ` +
          `Values above the maximum are rejected rather than clamped, so a consumer ` +
          `paginating with \`while (data.length === limit)\` cannot loop forever.`,
      },
    ]);
  }
  return value;
}

/** PF-218's HTTP half — a bad cursor becomes the envelope naming `cursor`. */
export function parseCursor(raw: unknown, resource: string): CursorPayload | null {
  if (raw === undefined) return null;

  if (typeof raw !== 'string') {
    throw validationFailed([
      { field: CURSOR_PARAM, message: 'Expected a single opaque cursor string.' },
    ]);
  }

  const decoded = decodeCursor(raw, resource);
  if (!decoded.ok) {
    throw validationFailed([
      { field: CURSOR_PARAM, message: CURSOR_REJECTION_MESSAGE[decoded.reason] },
    ]);
  }
  return decoded.payload;
}

export interface PageRequest {
  limit: number;
  cursor: CursorPayload | null;
}

/**
 * The one call a list handler makes. Validates the allowlist FIRST, so a request
 * carrying both `?offset=10` and a bad `limit` is told about the offset — the
 * error a consumer porting from an offset API needs to see.
 */
export function parsePageRequest(
  query: Record<string, unknown>,
  resource: string,
  extraAllowed: readonly string[] = [],
): PageRequest {
  assertAllowedQueryParams(query, extraAllowed);
  return {
    limit: parseLimit(query[PAGE_SIZE_PARAM]),
    cursor: parseCursor(query[CURSOR_PARAM], resource),
  };
}
