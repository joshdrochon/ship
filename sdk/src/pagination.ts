/**
 * Async-iterator pagination: consumers never see a cursor.
 *
 *   for await (const doc of client.documents.iterate()) { ... }
 *
 * ── PF-535: the walk has to TERMINATE, and it used not to ───────────────────
 * The previous implementation was `do { … } while (cursor !== null)`. A response
 * that OMITS `next_cursor` sets `cursor = undefined`, and `undefined !== null`
 * is true — so the SDK re-requested page 1 forever, at full speed, with no error
 * and no way for a consumer to notice except a hung process. Recorded as L99 F21
 * and reproduced by `pagination.test.ts` against the old expression.
 *
 * L08's PF-224 requires Ship's server to send `next_cursor` present-and-null on
 * the last page, and it does. That is not enough for a PUBLISHED SDK: between
 * the server and the consumer sit reverse proxies, response transformers, edge
 * workers and API gateways, and a stripped key must not hang the client of an
 * otherwise-working API. A library terminates on what it RECEIVES.
 *
 * Four end conditions, and every one of them is a test:
 *
 *   1. `next_cursor: null`          the normal end
 *   2. `next_cursor` absent         a proxy stripped it — end, do not spin
 *   3. `data: []`                   nothing left to yield — end, whatever the cursor says
 *   4. the same cursor twice        the server is not advancing — THROW, by name
 *
 * (4) is the only one that is an error rather than an end, and deliberately so:
 * an empty page is an ambiguous-but-survivable answer, while a server repeating
 * a cursor is a defect that silently produces duplicate rows for as long as the
 * consumer keeps reading. Ending quietly there would hand the consumer a
 * truncated result set they had no way to detect.
 */

export interface Page<T> {
  data: T[];
  /**
   * The next page's cursor, or `null` on the last page.
   *
   * Typed as possibly `undefined` because that is what arrives when something
   * between here and Ship drops the key, and a type that lies about it is how
   * the infinite loop above got written in the first place.
   */
  next_cursor?: string | null;
}

/**
 * Thrown when a server returns the same `next_cursor` twice in a row.
 *
 * A named class rather than a bare `Error` so a consumer can `instanceof` it,
 * and so a CLI can print something better than a stack trace. It is NOT a
 * `ShipError`: nothing about the HTTP exchange failed — each response was a
 * valid 200 — and reporting it as `kind: 'server'` would put it in the same
 * `catch` branch as a 503 that a retry would fix.
 */
export class PaginationStalledError extends Error {
  readonly cursor: string;
  readonly pagesRead: number;

  constructor(cursor: string, pagesRead: number) {
    super(
      `Pagination stalled: the server returned the same next_cursor twice in a row after ` +
        `${pagesRead} page(s). Continuing would yield the same rows forever, so the walk ` +
        `stopped. This is a server-side defect, not a usage error.`,
    );
    this.name = 'PaginationStalledError';
    this.cursor = cursor;
    this.pagesRead = pagesRead;
  }
}

export async function* paginate<T>(
  fetchPage: (cursor: string | null) => Promise<Page<T>>,
): AsyncGenerator<T, void, undefined> {
  let cursor: string | null = null;
  let pagesRead = 0;

  for (;;) {
    const page: Page<T> = await fetchPage(cursor);
    pagesRead += 1;

    for (const item of page.data) yield item;

    // (3) — an empty page ends the walk whatever the cursor says. A server that
    // hands back no rows and a cursor is asking to be polled, and a `for await`
    // is not a poller.
    if (page.data.length === 0) return;

    const next = page.next_cursor;

    // (1) and (2) together: `null` and `undefined` both mean stop. Written as a
    // positive test for a non-empty string rather than as `!== null`, which is
    // the exact expression that produced L99 F21.
    if (typeof next !== 'string' || next === '') return;

    // (4) — the server handed back the cursor we just sent it, so the next
    // request would be byte-identical to this one. Detected on the SECOND
    // response rather than the third, which is what keeps the request count
    // bounded at 2 in the test rather than "eventually".
    if (next === cursor) throw new PaginationStalledError(next, pagesRead);

    cursor = next;
  }
}
