/**
 * The shape every resource client shares — PF-521, PF-533.
 *
 * ── Why a base class and not four copies ────────────────────────────────────
 * PF-533 requires `iterate()` on every list-capable client and requires all of
 * them to delegate to the SINGLE `paginate()` generator. Four hand-rolled loops
 * is the failure mode that ticket names, and four hand-copied `list()` bodies is
 * the same defect one level down: the day `limit` gains a validation rule, three
 * of the four get it.
 *
 * ── and it is still four classes (PF-521) ───────────────────────────────────
 * p.7's sketch is `readonly documents: DocumentsClient; readonly issues:
 * IssuesClient; …` — four named types, which p.12 cites as this SDK's
 * Interface-Segregation evidence. A shared base does not weaken that: each
 * subclass is its own constructor, `client.documents instanceof IssuesClient` is
 * false, and a consumer that needs documents compiles against `DocumentsClient`
 * and sees no issue method. What ISP forbids is one object with every method on
 * it; inheritance of a list/get/iterate implementation is not that.
 */
import { paginate, type Page } from '../pagination.js';
import type { Transport } from '../transport.js';

/**
 * `list()`'s options — PF-536's raw-page half.
 *
 * `cursor` is HERE and deliberately absent from `IterateOptions`. Pre-Search 2.4
 * (p.17) asks whether to expose raw cursors, iterators, or both; the answer is
 * both, because the developer portal and the CLI's `--limit` both need one page
 * without draining a collection. The cost — a consumer *can* hold a cursor — is
 * bounded by the type below.
 */
export interface ListOptions {
  /** Opaque, from a previous response's `next_cursor`. Never construct one. */
  cursor?: string;
  /** Page size. The server's maximum is 100 and it REJECTS above it, not clamps. */
  limit?: number;
}

/**
 * `iterate()`'s options — PF-534, expressed as a type rather than as prose.
 *
 * p.4: *"Cursors handled internally; consumer code never sees them."* There is
 * no `cursor` field, so passing one is a compile error and not a silently
 * ignored argument. `typeProofs/surfaceContracts.ts` pins that with a
 * `@ts-expect-error` fixture.
 *
 * `limit` survives because it is a PAGE SIZE, not a position: it changes how
 * many rows each underlying request fetches and changes nothing a consumer
 * observes about the sequence.
 */
export interface IterateOptions {
  /** Rows per underlying request. Not a cap on the walk. */
  limit?: number;
}

/**
 * `/documents/{id}`, with the id escaped.
 *
 * A module-level function rather than a `protected` method, and the reason is
 * PF-531. `protected` is erased by `tsc`, so a protected method is an ordinary
 * enumerable member of the prototype at runtime — and the reverse-parity walk,
 * which reads the real prototypes, correctly reported it as a public SDK method
 * with no spec operation behind it. The choice was to teach the walk about
 * TypeScript's access modifiers (it cannot see them) or to stop putting
 * non-public members on the prototype. This is the second.
 */
export function resourceItemPath(collectionPath: string, id: string): string {
  return `${collectionPath}/${encodeURIComponent(id)}`;
}

/** Turns `ListOptions` into the transport's flat query record. */
export function listQuery(options: ListOptions): Record<string, string> {
  const query: Record<string, string> = {};
  if (options.cursor !== undefined && options.cursor !== '') query.cursor = options.cursor;
  if (options.limit !== undefined) query.limit = String(options.limit);
  return query;
}

/**
 * A cursor-paginated, fetchable-by-id resource.
 *
 * `create` and any resource-specific verb live on the subclasses, because they
 * differ in request type, response type and (for webhooks) in whether the
 * response carries a secret.
 */
export abstract class ResourceClient<TItem> {
  protected constructor(
    protected readonly transport: Transport,
    /** The `/api/v1`-relative collection path, e.g. `/documents`. */
    protected readonly collectionPath: string,
  ) {}

  /** One page. The cursor for the next one is `next_cursor`, or `null` at the end. */
  list(options: ListOptions = {}): Promise<Page<TItem>> {
    return this.transport.request<Page<TItem>>('GET', this.collectionPath, {
      query: listQuery(options),
    });
  }

  /** One row by id. */
  get(id: string): Promise<TItem> {
    return this.transport.request<TItem>('GET', resourceItemPath(this.collectionPath, id));
  }

  /**
   * `for await (const item of client.<resource>.iterate())` — p.4.
   *
   * One implementation, in `pagination.ts`, for all four clients.
   */
  iterate(options: IterateOptions = {}): AsyncGenerator<TItem, void, undefined> {
    return paginate<TItem>((cursor) =>
      this.list({
        ...(cursor !== null ? { cursor } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      }),
    );
  }
}
