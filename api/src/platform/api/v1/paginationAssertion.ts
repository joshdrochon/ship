/**
 * Testing Scenario 4 **clause (d)** — L08's clause, registered through L07's
 * public seam (PF-202) exactly as `envelopeAssertion.ts` does.
 *
 * PRD p.5, clause (d): *"supports cursor pagination if it's a list endpoint."*
 *
 * Tickets: PF-229 (register through the seam, don't write a second enumerator),
 * PF-230 (positive, over live requests), PF-231 (negative, so `'none'` is not a
 * rubber stamp).
 *
 * ## Why this is not a second route walk
 *
 * Three enumerators would be three different answers to "every route", and the
 * subtly wrong one is the one that passes. `registerRouteAssertion` means this
 * clause runs against whatever `enumerateV1Routes` finds — including routes added
 * by lanes that do not exist yet — with no edit here.
 *
 * ## Why "if it's a list endpoint" is read from metadata, not from the path
 *
 * The obvious implementation guesses: a path with no `:param` at the end is
 * probably a list. That heuristic is wrong for `/api/v1/scopes` (a collection
 * that must NOT paginate) and for `/api/v1/documents/:id/children` (a collection
 * that must), and — worse — it is wrong SILENTLY. `routeMetadata` makes the
 * question decidable, and `assertEveryRouteDeclaresList` makes an undeclared
 * route a boot failure rather than a route this clause skips.
 */
import request from 'supertest';
import { anyPageSchema, assertLastPageShape } from './page.js';
import { decodeCursor, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './pagination.js';
import { routeMetadata, RouteMetadataRegistry } from './routeMetadata.js';
import { registerRouteAssertion, type RouteAssertionContext } from './routeFitness.js';
import { concretePath } from './envelopeAssertion.js';

/**
 * How the clause obtains an authenticated request. A list endpoint's real
 * response is behind bearer auth, so the clause cannot assert anything about it
 * without credentials — and a clause that silently degrades to "well, it 401s" is
 * the vacuous pass this whole harness exists to prevent.
 *
 * Injected rather than hard-coded because L06 owns how a token is minted; the
 * fitness spec supplies a header its own test app accepts.
 */
export interface PaginationClauseOptions {
  /** Headers that make a request authenticated. Empty means "the app has no auth". */
  authHeaders?: Record<string, string>;
  /** Registry to read `list` from. Defaults to the process-wide one. */
  registry?: RouteMetadataRegistry;
}

let options: PaginationClauseOptions = {};

/** Configures the clause for a spec run. Called by the fitness spec, not by app code. */
export function configurePaginationClause(next: PaginationClauseOptions): void {
  options = next;
}

function metadataFor(route: { method: string; path: string }) {
  const registry = options.registry ?? routeMetadata;
  return registry.get(route.method, route.path);
}

/**
 * PF-230 — the POSITIVE half. Every `list: 'cursor'` route paginates for real.
 *
 * Two live requests, not a metadata check. A route can declare `'cursor'` and
 * return a bare array; declaring an intention is not the same as having it, and
 * the whole point of a fitness test is to check the second thing.
 *
 * The second request carries the returned `next_cursor` and its page must be
 * DISJOINT from the first. That is the assertion that actually catches a broken
 * predicate: a handler that ignores the cursor and returns page 1 every time
 * passes a schema check, passes a "next_cursor is a string" check, and hangs
 * every consumer that walks it.
 */
export async function assertCursorPagination({
  route,
  app,
}: RouteAssertionContext): Promise<void> {
  const metadata = metadataFor(route);
  if (!metadata || metadata.list !== 'cursor') return;
  if (route.method !== 'GET') {
    throw new Error(`declares list:'cursor' but is a ${route.method} — only GET can be a list`);
  }

  const path = concretePath(route.path);
  const headers = options.authHeaders ?? {};

  const first = await request(app).get(path).set(headers);
  if (first.status !== 200) {
    throw new Error(
      `declares list:'cursor' but an authenticated GET returned ${first.status}. ` +
        `Clause (d) cannot verify pagination on a route it cannot reach; if this route is ` +
        `not meant to be listable, its metadata should not say 'cursor'.`,
    );
  }

  const parsed = anyPageSchema.safeParse(first.body);
  if (!parsed.success) {
    throw new Error(
      `body is not { data, next_cursor }: ${JSON.stringify(first.body).slice(0, 200)} — ` +
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  assertLastPageShape(first.body);

  // `limit` must be honoured. A route that ignores it returns its own page size
  // and every consumer's paging arithmetic is wrong.
  const limited = await request(app).get(`${path}?limit=2`).set(headers);
  if (limited.status !== 200) {
    throw new Error(`?limit=2 returned ${limited.status}; a cursor route must accept \`limit\``);
  }
  if (limited.body.data.length > 2) {
    throw new Error(
      `?limit=2 returned ${limited.body.data.length} rows — \`limit\` is not honoured.`,
    );
  }

  // Out-of-range `limit` is rejected, not clamped (PF-225).
  const over = await request(app).get(`${path}?limit=${MAX_PAGE_SIZE + 1}`).set(headers);
  if (over.status !== 422) {
    throw new Error(
      `?limit=${MAX_PAGE_SIZE + 1} returned ${over.status}, expected 422. Out-of-range page ` +
        `sizes are rejected rather than clamped — a clamp turns a consumer's ` +
        `\`while (data.length === limit)\` loop into an infinite one.`,
    );
  }

  // An unknown query parameter is rejected (PF-226).
  const unknown = await request(app).get(`${path}?offset=10`).set(headers);
  if (unknown.status !== 422) {
    throw new Error(
      `?offset=10 returned ${unknown.status}, expected 422. Unknown query parameters are ` +
        `rejected so a consumer porting from an offset API breaks loudly instead of ` +
        `silently reading page 1 forever.`,
    );
  }

  const cursor = first.body.next_cursor as string | null;
  if (cursor === null) {
    // A single-page collection. Everything above still held; there is no second
    // page to compare against, and demanding one would mean seeding fixtures for
    // every resource in the repo from inside a fitness clause.
    return;
  }

  if (decodeCursor(cursor, metadata.resource ?? '').ok === false) {
    throw new Error(
      `next_cursor does not decode against resource '${metadata.resource}'. A cursor must be ` +
        `bound to the collection that minted it (PF-218).`,
    );
  }

  const second = await request(app).get(`${path}?cursor=${cursor}`).set(headers);
  if (second.status !== 200) {
    throw new Error(`following next_cursor returned ${second.status}, expected 200`);
  }
  if (!anyPageSchema.safeParse(second.body).success) {
    throw new Error(`page 2 is not { data, next_cursor }`);
  }

  const firstIds = new Set((first.body.data as { id?: string }[]).map((r) => r.id));
  const overlap = (second.body.data as { id?: string }[]).filter((r) => firstIds.has(r.id));
  if (overlap.length > 0) {
    throw new Error(
      `page 2 repeats ${overlap.length} row(s) from page 1 — the cursor is not advancing the ` +
        `keyset. A handler that ignores \`cursor\` and returns page 1 every time passes every ` +
        `schema check and hangs every consumer that walks it.`,
    );
  }
}

/**
 * PF-231 — the NEGATIVE half. A `list: 'none'` route must not emit a cursor.
 *
 * Without this the flag is a rubber stamp: every route could self-declare
 * `'none'` and clause (d) would pass over an API with no working pagination at
 * all. The negative case is what makes the positive one mean something.
 */
export async function assertNoCursorOnFixedList({
  route,
  app,
}: RouteAssertionContext): Promise<void> {
  const metadata = metadataFor(route);
  if (!metadata || metadata.list !== 'none') return;

  const path = concretePath(route.path);
  const headers = options.authHeaders ?? {};

  const res = await request(app).get(path).set(headers);
  if (res.status !== 200) {
    throw new Error(`declares list:'none' but an authenticated GET returned ${res.status}`);
  }

  if (typeof res.body === 'object' && res.body !== null && 'next_cursor' in res.body) {
    throw new Error(
      `declares list:'none' but the body carries a \`next_cursor\` key. A fixed-cardinality ` +
        `collection returns { data } and nothing else — an inert next_cursor is a pagination ` +
        `protocol a consumer will start depending on.`,
    );
  }

  if (!Array.isArray((res.body as { data?: unknown }).data)) {
    throw new Error(`declares list:'none' but \`data\` is not an array`);
  }

  // `?limit=1` should have been rejected by the allowlist. If the route instead
  // honoured it, it is paginating in secret and its metadata is a lie.
  const limited = await request(app).get(`${path}?limit=1`).set(headers);
  if (limited.status === 200) {
    const before = (res.body as { data: unknown[] }).data.length;
    const after = (limited.body as { data: unknown[] }).data.length;
    if (after !== before) {
      throw new Error(
        `declares list:'none' but ?limit=1 changed the result size (${before} -> ${after}). ` +
          `Either it paginates and the metadata is wrong, or the query allowlist is not applied.`,
      );
    }
  }
}

/**
 * PF-229 — registers both halves through PF-202's seam.
 *
 * Import this module from any spec that runs `runRouteAssertions`, and clause (d)
 * appears in the same failure report as clause (c).
 */
export function registerPaginationAssertions(): void {
  registerRouteAssertion(
    'L08 (d): list endpoints paginate with an opaque cursor',
    assertCursorPagination,
  );
  registerRouteAssertion(
    "L08 (d, negative): a list:'none' route emits no cursor",
    assertNoCursorOnFixedList,
  );
}

/** Re-exported so a spec asserting the default page size does not restate it. */
export { DEFAULT_PAGE_SIZE };
