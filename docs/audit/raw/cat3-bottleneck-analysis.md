# Category 3 — where the time actually goes

Written by the coordinator on a quiet machine after all lanes stalled on a session
limit. Lane 3 never saw its own results; this is the analysis it would have done.

## Lane 3's paired result, compared at matched concurrency

The three values per endpoint are the three VUS levels (10/25/50), NOT repeats. My
first pass compared them as replicates, which was wrong. Like-for-like:

| endpoint | vu10 | vu25 | vu50 |
|---|---:|---:|---:|
| `/api/auth/me` | −4.9% | −10.9% | −8.0% |
| `/api/team/grid` | −9.1% | +1.0% | −9.3% |
| `/api/documents` | +5.2% | +2.7% | +2.5% |
| `/api/projects` | +4.5% | +0.5% | +7.1% |
| `/api/documents/:id/backlinks` | +23.4% | +18.6% | +14.5% |

Three of five endpoints regressed at EVERY concurrency level. Consistent direction
across all three rules out noise. Target is −20% on two endpoints; best achieved is
−10.9% on one.

## The prepared-statement hypothesis was wrong

I predicted the named prepared statements added in `5fcc533` caused a generic-plan
regression (PostgreSQL switches to a generic plan after 5 executions, `plan_cache_mode`
is unset so the default `auto` applies). Tested directly against `ship_lane_3`:

    custom plan (literals):        Planning 0.394 ms  Execution 0.698 ms
    forced generic plan:           Planning 0.119 ms  Execution 0.562 ms

Identical plan shape, and the generic version is marginally FASTER. Hypothesis refuted.

## Why no SQL change could have hit the target

    /health          (no auth, no DB, tiny payload)      1.1 ms
    documents query  (measured with EXPLAIN ANALYZE)     0.56 ms
    session SELECT + last_activity write                 ~2 ms  (2 round trips)
    /api/documents   P95                                 23 ms

The database is roughly 2% of the response time. Lane 3's four rewrites — prepared
statements, grouped CTEs, batched grid queries, three-queries-to-one on /auth/me — are
sound engineering aimed at 2% of the problem. Only /auth/me improved measurably, and
that is the endpoint where the DB round trips were the largest share.

## What the other 98% is

`GET /api/documents` returns **all 600 documents, 246 kB, uncompressed**.

- **No compression middleware exists.** Not configured in `api/src/app.ts`, and
  `compression` is not in `api/package.json` at all. Every response ships raw.
- **No pagination.** No LIMIT/OFFSET on the documents list; the row count is the
  seed volume.
- Every authenticated request pays two DB round trips in `api/src/middleware/auth.ts`
  (SELECT at :33, write at :52) before the handler runs.

## Recommended order of attack

1. **Response compression.** JSON of this shape typically compresses 80–90%; 246 kB
   would fall to roughly 25–40 kB on the wire. It is a genuine product improvement
   rather than a measurement trick, it is a handful of lines, and — critically for
   p.5, which requires two endpoints — it improves EVERY endpoint at once. This is
   the single highest-value change available in this category.
2. **Throttle the `last_activity` write** in auth middleware. Removes one DB round
   trip per request. Note this is also Lane 4's identified Category 4 route, so the
   two lanes must not both claim it.
3. **Pagination or field trimming** on the list endpoint. Higher impact than (2) but
   changes the API contract and may require frontend work.

## Two harness issues found while investigating

- `bench-api.sh:40` pulls its document ID from `ship_dev` via a hardcoded
  `docker exec ship-postgres-1 psql -U ship -d ship_dev`, while the API under test
  points at the lane database. If that ID is absent from the lane DB, the backlinks
  endpoint is benchmarking a 404 path.
- `/api/documents` is registered three times in `app.ts` (:197 documents,
  :198 backlinks, :199 associations). Every backlinks request traverses the documents
  router first. Not proven to be the regression cause, but it is the only structural
  coupling between the endpoint that changed and the endpoint that regressed most.
