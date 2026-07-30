import type { QueryResult, QueryResultRow } from 'pg';

/**
 * Build a `pg` QueryResult for a mocked `pool.query`.
 *
 * Why this exists. A test that only cares about `rows` still has to satisfy the whole
 * QueryResult shape — `command`, `oid`, `fields`, `rowCount` — so the shortest thing
 * that compiles is `{ rows: [...] } as any`, and that is what every mock in this suite
 * reached for. Twenty-nine of them.
 *
 * `as any` in a test is not harmless. It disables checking on the very value the code
 * under test consumes, so a handler that starts reading `result.rowCount` keeps
 * compiling against mocks that never had one, and the suite goes green on a shape the
 * database would never return. That is the failure mode this helper removes: the rows
 * are checked against R, and the rest of the shape is supplied rather than asserted away.
 *
 * Deliberately not generic over the column names — `queryResult([{ id: 1 }])` infers R
 * from the literal, so a typo in a mocked column is a compile error at the call site.
 */
export function queryResult<R extends QueryResultRow>(
  rows: R[],
  overrides: Partial<Omit<QueryResult<R>, 'rows'>> = {}
): QueryResult<R> {
  return {
    rows,
    // node-postgres reports rowCount as null for statements that return no row count;
    // defaulting to rows.length matches what a SELECT actually returns.
    rowCount: rows.length,
    command: 'SELECT',
    oid: 0,
    fields: [],
    ...overrides,
  };
}
