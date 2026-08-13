/**
 * PF-533 – PF-535 · async-iterator pagination.
 *
 * The four termination cases are the reason this file exists. L99 F21 recorded
 * a VERIFIED defect: `while (cursor !== null)` re-requested page 1 forever when
 * a response omitted `next_cursor`, because `undefined !== null`. Every case
 * below asserts a BOUNDED request count, because "it terminated" and "it
 * terminated after the right number of requests" are different claims and only
 * the second one catches a walk that restarted.
 *
 * No `setTimeout` anywhere (p.11, PF-513) — nothing here waits.
 */
import { describe, expect, it } from 'vitest';
import { paginate, PaginationStalledError, type Page } from './pagination.js';
import { ShipClient } from './client.js';
import { DocumentsClient } from './resources/documents.js';
import { IssuesClient } from './resources/issues.js';
import { SprintsClient } from './resources/sprints.js';
import { WebhooksClient } from './resources/webhookSubscriptions.js';
import type { Transport } from './transport.js';

/** A `fetchPage` that answers from a script and counts how often it was asked. */
function scriptedPages<T>(pages: Page<T>[]): {
  fetch: (cursor: string | null) => Promise<Page<T>>;
  cursors: (string | null)[];
} {
  const cursors: (string | null)[] = [];
  let index = 0;
  return {
    cursors,
    fetch: (cursor) => {
      cursors.push(cursor);
      // Past the end of the script the LAST page repeats — which is what a
      // buggy generator would spin on, so a runaway walk shows up as a large
      // `cursors.length` rather than as a hang.
      const page = pages[Math.min(index, pages.length - 1)] as Page<T>;
      index += 1;
      if (cursors.length > 50) throw new Error('runaway pagination: over 50 requests');
      return Promise.resolve(page);
    },
  };
}

async function collect<T>(iterator: AsyncGenerator<T, void, undefined>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterator) items.push(item);
  return items;
}

describe('PF-533 · the happy path — three pages, concatenated', () => {
  it('yields every row across three pages and stops', async () => {
    const script = scriptedPages<number>([
      { data: [1, 2], next_cursor: 'c1' },
      { data: [3, 4], next_cursor: 'c2' },
      { data: [5], next_cursor: null },
    ]);

    expect(await collect(paginate(script.fetch))).toEqual([1, 2, 3, 4, 5]);
    // Exactly three requests, and each carried the previous page's cursor.
    expect(script.cursors).toEqual([null, 'c1', 'c2']);
  });
});

describe('PF-535 · four termination cases, each with a bounded request count', () => {
  it('1 · `next_cursor: null` stops', async () => {
    const script = scriptedPages<number>([{ data: [1], next_cursor: null }]);
    expect(await collect(paginate(script.fetch))).toEqual([1]);
    expect(script.cursors).toHaveLength(1);
  });

  it('2 · `next_cursor` ABSENT stops — this is L99 F21, the infinite loop', async () => {
    // The defect verbatim: the key is missing, so the old `cursor = undefined`
    // and `undefined !== null` sent the walk back to page 1 forever.
    const script = scriptedPages<number>([
      { data: [1, 2], next_cursor: 'c1' },
      { data: [3] } as Page<number>,
    ]);

    expect(await collect(paginate(script.fetch))).toEqual([1, 2, 3]);
    expect(script.cursors, 'the walk restarted — F21 has regressed').toEqual([null, 'c1']);
  });

  it('2b · an EMPTY-STRING cursor also stops', async () => {
    // A proxy that rewrites a null to `""` is the same class of failure as one
    // that drops the key, and `"" !== null` too.
    const script = scriptedPages<number>([{ data: [1], next_cursor: '' }]);
    expect(await collect(paginate(script.fetch))).toEqual([1]);
    expect(script.cursors).toHaveLength(1);
  });

  it('3 · an EMPTY page stops even when a cursor is offered', async () => {
    const script = scriptedPages<number>([
      { data: [1], next_cursor: 'c1' },
      { data: [], next_cursor: 'c2' },
    ]);
    expect(await collect(paginate(script.fetch))).toEqual([1]);
    expect(script.cursors).toEqual([null, 'c1']);
  });

  it('4 · the SAME cursor returned twice throws by name, after exactly two requests', async () => {
    const script = scriptedPages<number>([
      { data: [1], next_cursor: 'stuck' },
      { data: [2], next_cursor: 'stuck' },
    ]);

    const error = await collect(paginate(script.fetch)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaginationStalledError);
    expect((error as PaginationStalledError).cursor).toBe('stuck');
    expect((error as PaginationStalledError).pagesRead).toBe(2);
    expect(script.cursors).toEqual([null, 'stuck']);
  });

  it('and a stall is NOT reported as a ShipError — a retry would not fix it', async () => {
    const script = scriptedPages<number>([{ data: [1], next_cursor: 'x' }, { data: [2], next_cursor: 'x' }]);
    const error = (await collect(paginate(script.fetch)).catch((e: unknown) => e)) as Error;
    expect(error.name).toBe('PaginationStalledError');
    expect(error.message).toContain('same next_cursor twice');
  });
});

describe('PF-533 · iterate() exists on all four clients and delegates to the one generator', () => {
  /** Answers three pages of `{id}` rows for any collection path. */
  class PagingTransport implements Transport {
    readonly paths: string[] = [];
    constructor(private readonly prefix: string) {}
    request<T>(_m: string, path: string, options: { query?: Record<string, string> } = {}): Promise<T> {
      this.paths.push(path);
      const cursor = options.query?.cursor ?? null;
      const pages: Record<string, Page<{ id: string }>> = {
        'null': { data: [{ id: `${this.prefix}-1` }], next_cursor: 'p2' },
        p2: { data: [{ id: `${this.prefix}-2` }], next_cursor: 'p3' },
        p3: { data: [{ id: `${this.prefix}-3` }], next_cursor: null },
      };
      return Promise.resolve(pages[cursor ?? 'null'] as T);
    }
  }

  const cases = [
    ['documents', (t: Transport) => new DocumentsClient(t)],
    ['issues', (t: Transport) => new IssuesClient(t)],
    ['sprints', (t: Transport) => new SprintsClient(t)],
    ['webhooks', (t: Transport) => new WebhooksClient(t)],
  ] as const;

  for (const [name, make] of cases) {
    it(`${name}.iterate() walks three pages and equals the concatenation`, async () => {
      const transport = new PagingTransport(name);
      const client = make(transport);

      const walked: string[] = [];
      for await (const row of client.iterate()) walked.push((row as { id: string }).id);

      expect(walked).toEqual([`${name}-1`, `${name}-2`, `${name}-3`]);
      // Three requests, all to the same collection — no cursor arithmetic in the
      // resource client.
      expect(transport.paths).toHaveLength(3);
      expect(new Set(transport.paths).size).toBe(1);
    });
  }

  it('a page size passes through to every underlying request', async () => {
    const seen: (string | undefined)[] = [];
    const transport: Transport = {
      request: <T,>(_m: string, _p: string, o: { query?: Record<string, string> } = {}) => {
        seen.push(o.query?.limit);
        const page: Page<{ id: string }> =
          seen.length === 1 ? { data: [{ id: 'a' }], next_cursor: 'n' } : { data: [{ id: 'b' }], next_cursor: null };
        return Promise.resolve(page as T);
      },
    };

    const walked: string[] = [];
    for await (const row of new DocumentsClient(transport).iterate({ limit: 5 })) {
      walked.push(row.id);
    }

    expect(walked).toEqual(['a', 'b']);
    expect(seen).toEqual(['5', '5']);
  });
});

describe('PF-536 · both surfaces exist, and the raw one is the only one with a cursor', () => {
  it('list() returns the page envelope; iterate() yields bare items', async () => {
    const transport: Transport = {
      request: <T,>() => Promise.resolve({ data: [{ id: 'x' }], next_cursor: 'more' } as T),
    };
    const documents = new DocumentsClient(transport);

    const page = await documents.list();
    expect(page).toHaveProperty('next_cursor', 'more');

    // and nothing in `iterate()`'s yielded value carries one.
    const first = await documents.iterate().next();
    expect(first.value).toEqual({ id: 'x' });
    expect(first.value).not.toHaveProperty('next_cursor');
  });

  it('ShipClient wires all four to the same shared generator', () => {
    const client = new ShipClient({ token: 't', baseUrl: 'https://ship.test' });
    // One implementation, inherited — not four copies. `iterate` is an own
    // property of exactly ONE prototype in the chain.
    const owners = (['documents', 'issues', 'sprints', 'webhooks'] as const).map((name) => {
      let proto: object | null = Object.getPrototypeOf(client[name]) as object | null;
      while (proto !== null && !Object.prototype.hasOwnProperty.call(proto, 'iterate')) {
        proto = Object.getPrototypeOf(proto) as object | null;
      }
      return proto;
    });
    expect(new Set(owners).size, 'iterate is implemented more than once').toBe(1);
  });
});
