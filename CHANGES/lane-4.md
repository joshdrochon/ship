# Lane 4 — Database Query Efficiency

Category 4. Target (p.5), verbatim:

> 20% reduction in total query count on at least one user flow, or 50% improvement on the
> slowest query. Provide before/after `EXPLAIN ANALYZE` output. Document what was
> inefficient and why your change fixes it.

## Result

All five flows p.5 names clear the 20% bar. The lane's absolute threshold — 38 queries on
"view a document" — also clears, at 37.

| flow | before | after | change |
|---|---:|---:|---:|
| load_main_page | 32 | 24 | −25.0% |
| **view_a_document** | **50** | **37** | **−26.0%** |
| list_issues | 23 | 16 | −30.4% |
| load_sprint_board | 14 | 10 | −28.6% |
| search_content | 16 | 11 | −31.3% |

Zero `UPDATE sessions SET last_activity` statements remain on any flow. Before: 13 of the
50 queries on "view a document" were that one statement — more occurrences than any other
statement in the flow.

Raw output: `docs/audit/raw/cat4-lane4-before.json`, `cat4-lane4-after.json`,
`cat4-explain-before.txt`, `cat4-explain-after.txt`.

## What was inefficient

Two places authenticated a caller, and both ended the same way:

```sql
UPDATE sessions SET last_activity = $1 WHERE id = $2
```

- `api/src/middleware/auth.ts` ran it on **every authenticated HTTP request**, immediately
  after the `SELECT` that had just read the row.
- `api/src/collaboration/index.ts` ran it on **every WebSocket handshake**. Opening a
  document opens a Yjs collaboration socket and an events socket, so that is two more.

That turns every read request into a write: a row lock on the session, a heap update, a WAL
record, and eventually vacuum work — all to move a timestamp forward by a few milliseconds.
It also serialises concurrent requests from the same user behind one row lock, and on a
document view a browser fires many requests at once.

The `EXPLAIN ANALYZE` for the statement itself (section B in the capture) is not the
problem. It is a primary-key index scan, 0.14 ms, five buffers. Nothing is wrong with the
plan — the waste is that a cheap write ran 13 times to accomplish what one write
accomplishes.

Both places had also copied the same session rules inline: the 12-hour absolute timeout and
the 15-minute idle timeout existed twice, in two files, with no shared constant tying them
together.

## What changed and why it fixes it

`api/src/db/sessions.ts` (new) owns the session activity rules:

- `shouldWriteSessionActivity(inactivityMs)` — is the stored timestamp stale enough to be
  worth a write?
- `touchSessionActivity(sessionId, now, inactivityMs)` — write, or skip.
- `validateSessionForConnection(sessionId)` — the whole WebSocket-handshake check: load,
  both timeout rules, throttled touch.

The write now happens only once the stored value is already stale by more than
`SESSION_ACTIVITY_WRITE_INTERVAL_MS` (60 s). A timeout measured in minutes does not need a
timestamp accurate to the millisecond.

Two properties are deliberate:

1. **The decision comes from the row that was just read**, not from an in-process cache.
   Multiple API processes, or a restart, cannot disagree about whether a write is due, and
   there is no cache to invalidate. It costs nothing extra — the `SELECT` was already
   happening and already returned `last_activity`.
2. **It can only expire a session early, never late.** The stored value lags real activity
   by at most one interval, so the idle timeout fires at 15 minutes minus up to 60 seconds.

Lifting the WebSocket path into the same module was what removed the last three writes, and
it collapsed the duplicated timeout rules into one implementation.

### Why 60 seconds

The interval is the whole safety argument, so it is worth being explicit.

Session timeout is 15 minutes idle / 12 hours absolute. A throttle that is too coarse would
let a session expire while the user is still active — the failure mode is logging out
someone who is working.

That cannot happen here, because the lag is bounded by the interval and the error runs in
the safe direction. Worst case: the last write lands at T, the user makes a final request at
T+59 s that does not trigger a write, then goes idle. The session expires at T+15:00 rather
than T+15:59 — up to 59 seconds early, never late. At 60 s against a 15-minute window that
is under 7% of the idle budget. For a security control, expiring early is the direction to
err in.

60 s specifically, rather than 30 or 120, because the sliding-cookie refresh a few lines
below in the same middleware had **already** adopted a 60-second threshold for exactly this
reason. The cookie `maxAge` and the stored `last_activity` are the two halves of one sliding
window; letting them drift apart would mean the browser and the database disagree about when
the session dies. They now share one constant. A test asserts the interval stays ≤ 1/10 of
`SESSION_TIMEOUT_MS`, so raising it later trips a failure rather than quietly eroding the
idle timeout.

## Tradeoffs accepted

| | |
|---|---|
| **Session freshness** | Stored `last_activity` can be up to 60 s behind reality. Accepted: bounded, and it only ever expires a session early. |
| **`GET /api/auth/session` reporting** | The `lastActivity` field it returns can be up to 60 s stale. No user-visible effect — `web/src/hooks/useSessionTimeout.ts` drives its countdown from client-side `Date.now()` and from `expiresAt`, neither of which this touches. |
| **Idle timeout is now 14:01–15:00, not exactly 15:00** | Accepted. The alternative — an exact timestamp — costs a write on every read request. |
| **Scope** | `api/src/collaboration/index.ts` is outside the lane brief's `api/src/db/` wording but inside "the session/auth middleware write path", and it is where the last 3 of 13 writes lived. Flagged for whoever owns Category 6, since it is the collaboration file. The diff there is an import plus a four-line function body; the logic moved into `api/src/db/`. |

## Rejected

- **Caching the decision in process memory.** Faster still, but two API processes would
  disagree about whether a write is due, and a restart would lose it. The row-derived
  decision is free.
- **Adding an index.** The audit's index theory does not survive `EXPLAIN ANALYZE` — 13
  indexes already exist and the statements in question are primary-key lookups. Section E
  of the capture shows which indexes the planner actually reaches for.
- **Dropping the write entirely** and deriving idle from the cookie. That moves a security
  control to the client.

## How to run it

```bash
# 1. Data volume p.4 requires. `pnpm test` truncates this database — reseed after any run.
pnpm db:seed && node docs/audit/scripts/augment-seed.mjs

# 2. Paired measurement: both halves in one lock window, before half from c398a9c.
docs/audit/scripts/run-cat4-paired.sh
# writes cat4-lane4-{before,after}.json and cat4-explain-{before,after}.txt to docs/audit/raw/
```

The script takes `scripts/measure-lock.sh` before it starts and releases it on exit,
including on failure. It renews the lock between the two halves — a correct paired run is
indistinguishable from an abandoned lock to the 30-minute staleness breaker.

Counting trap, already paid for twice in this repository: `docker logs` returns the entire
history, and `log_statement=all` is cluster-wide, so one container's log interleaves every
lane's database. `measure-queries.mjs` handles both — it resets per `FLOWMARK` rather than
appending, and filters on the `db=` tag in `log_line_prefix`. A count taken any other way
will be wrong by a factor of the number of runs, the number of active lanes, or both.

## How to test it

```bash
pnpm test                                   # 467 passed
pnpm --filter @ship/web exec vitest run     # 152 passed
pnpm type-check && pnpm lint && pnpm build  # all 0
```

Regression tests (Rule 3):

- `api/src/db/__tests__/sessions.test.ts` — 12 tests. The throttle itself, the burst case,
  the interval-vs-timeout bound, and all of `validateSessionForConnection` including both
  timeout rejections and the database-unreachable path.
- `api/src/__tests__/auth.test.ts` — 4 tests in `session activity write throttle`.

Two of them fail against the pre-fix middleware, which is the point:

```
× does NOT write last_activity when the stored value is still fresh
× costs two queries per request in the steady state, not three
```

Verified by restoring `c398a9c`'s `auth.ts` and re-running.

One test-harness fix was needed. `auth.test.ts`'s shared `beforeEach` called
`vi.clearAllMocks()`, which clears recorded calls but **not** the `mockResolvedValueOnce`
queue. Several existing tests queue more responses than the middleware consumes, and the
leftovers were inherited by the next test — invisible only while every test over-queued by
the same amount. Removing one query per request desynchronised it and cascaded into 7
unrelated failures. Added `vi.mocked(pool.query).mockReset()`. No existing assertion was
changed.

## How to roll it back

```bash
git revert 9933a8b ddaa019   # WebSocket half, then HTTP half
```

Either revert stands alone. Reverting only `9933a8b` restores the unconditional write on
WebSocket handshakes and puts "view a document" back to roughly 40; reverting both restores
the original 50. Nothing else depends on `api/src/db/sessions.ts` — no schema change, no
migration, no config, no API contract change. `SESSION_ACTIVITY_WRITE_INTERVAL_MS` in
`api/src/db/sessions.ts` is the single knob if the throttle is wanted but at a different
interval; setting it to `0` restores write-on-every-request behaviour without a revert.

## Commits

| SHA | |
|---|---|
| `ddaa019` | `perf(db): throttle the per-request session last_activity write` |
| `bf37a54` | `test(auth): regression tests for the session activity write throttle` |
| `9933a8b` | `perf(db): throttle the WebSocket handshake's session activity write too` |
| `348b134` | `audit(cat4): before/after query counts and EXPLAIN ANALYZE, one lock window` |
