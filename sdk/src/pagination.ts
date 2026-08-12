/**
 * Async-iterator pagination: consumers never see a cursor.
 *
 *   for await (const doc of client.documents.iterate()) { ... }
 */

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

export async function* paginate<T>(
  fetchPage: (cursor: string | null) => Promise<Page<T>>,
): AsyncGenerator<T, void, undefined> {
  let cursor: string | null = null;
  do {
    const page: Page<T> = await fetchPage(cursor);
    for (const item of page.data) yield item;
    cursor = page.next_cursor;
  } while (cursor !== null);
}
