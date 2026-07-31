# Discovery Write-up

Three things in this codebase I did not know before.

Required by the ShipShape brief, p.9 (*"Find 3 things in this codebase that you did not know
before"*) and listed as its own submission deliverable on p.11 (*"Discovery Write-up — 3 things
you learned, with codebase references and reflection"*). Each entry answers the brief's four
questions in order.

Everything below was read in the codebase and verified against a running instance. Every file
reference and every quoted block was re-opened and re-checked at commit `c432768`, the head of
`main` after Phase 2 merged, and the line ranges below are the ones that hold there.

That re-check mattered. This write-up was first drafted at `002a18e`, 108 commits earlier, and
Phase 2's own type-safety work then rewrote one of the lines it quoted. Discovery 1 records both
the original code and what replaced it, because the replacement is the more interesting half.

---

## 1. `pg_advisory_xact_lock` — application-level mutexes inside Postgres

**Where:** `api/src/routes/issues.ts:580-595`. Same pattern at
`api/src/routes/documents.ts:842-844`, `:1270-1272`, and `:1452-1454`.

### What it does

Issues get a per-workspace sequential ticket number (SHIP-1, SHIP-2, …). The obvious
implementation is `SELECT MAX(ticket_number) + 1`, which is a textbook race: two concurrent
creates both read 41 and both write 42.

A `UNIQUE` constraint would catch that but produces a user-visible error, and a Postgres
`SEQUENCE` can't be scoped per workspace without creating one sequence per workspace. This code
takes a third route:

`api/src/routes/issues.ts:580-595`, verbatim at `c432768`:

```typescript
    await client.query('BEGIN');

    // Use advisory lock to serialize ticket number generation per workspace
    // This prevents race conditions where concurrent requests get the same MAX value
    // The lock key is derived from workspace_id (first 15 hex chars as bigint)
    const workspaceIdHex = requireAuth(req).workspaceId.replace(/-/g, '').substring(0, 15);
    const lockKey = parseInt(workspaceIdHex, 16);
    await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

    // Now safely get next ticket number - we hold the lock until transaction ends
    const ticketResult = await client.query(
      `SELECT COALESCE(MAX(ticket_number), 0) + 1 as next_number
       FROM documents
       WHERE workspace_id = $1 AND document_type = 'issue'`,
      [req.workspaceId]
    );
```

An advisory lock is a named mutex that Postgres will hold for you on any `bigint` you choose.
The number means nothing to the database — it's a coordination token. Two things make this work:

**It locks a concept, not a row.** The thing being protected is "the next ticket number for
workspace X," which is not a row that exists yet. `SELECT … FOR UPDATE` has nothing to grab.
Advisory locks let you lock the *idea* of a value.

**The `_xact_` variant releases at transaction end**, on commit or rollback, with no unlock call
and no `finally` block. The non-transactional `pg_advisory_lock` is session-scoped and leaks the
lock forever if the process dies while holding it — with a pooled connection, that poisons a
connection other requests will reuse. Choosing the transactional variant here is the correct
call and easy to get wrong.

### Why it matters

Serialization is scoped to one workspace. Two workspaces creating issues at the same instant
derive different lock keys and never contend, so throughput doesn't collapse the way a global
lock or a table-level lock would. Gapless per-tenant numbering with per-tenant contention only.

One caveat I noticed reading it: `parseInt` on 15 hex chars yields up to 2^60, past
`Number.MAX_SAFE_INTEGER` (2^53), so the key is silently rounded. It's *deterministic* rounding
— the same workspace always derives the same key — so correctness holds, but the effective key
space is smaller than intended and unrelated workspaces can collide onto one lock. The cost of a
collision is a little false contention, not a wrong number. `BigInt` would remove it.

### What changed under me, and why it sharpened the point

When I first read this handler the lock key came off `req.workspaceId!` — a non-null assertion.
Category 1's type-safety work deleted it, so the line now reads `requireAuth(req).workspaceId`.
The lock itself is untouched; what changed is how the handler gets the value it locks on.

`requireAuth` is at `api/src/middleware/auth.ts:73-80`, over a type guard at `:58-62`:

```typescript
export function isAuthenticated<P, ResBody, ReqBody, ReqQuery>(
  req: Request<P, ResBody, ReqBody, ReqQuery>
): req is AuthenticatedRequest<P, ResBody, ReqBody, ReqQuery> {
  return typeof req.userId === 'string' && typeof req.workspaceId === 'string';
}

export function requireAuth<P, ResBody, ReqBody, ReqQuery>(
  req: Request<P, ResBody, ReqBody, ReqQuery>
): AuthenticatedRequest<P, ResBody, ReqBody, ReqQuery> {
  if (!isAuthenticated(req)) {
    throw new MissingAuthContextError();
  }
  return req;
}
```

The doc comment above it (`:64-72`) states the failure mode, and it is specific to this handler:
an assertion that is wrong yields `undefined`, and `undefined` reaching a SQL parameter reads as
"no rows" rather than as an error. Follow that through the advisory-lock code and it is worse
than a wrong row count. `undefined.replace()` throws, so the crash is loud here — but had the
value merely been an empty or wrong string, `parseInt` would have produced `NaN` or a shared key,
every workspace would have serialized on the same lock, and the symptom would have been a slow
endpoint rather than an error. A correctness mechanism whose input is unvalidated silently
degrades into a performance bug.

`MissingAuthContextError` (`api/src/middleware/auth.ts:45-50`) names the actual cause — a route
mounted without `authMiddleware` — instead of surfacing a `TypeError` from string manipulation.
The migration is not uniform: `documents.ts` reaches the same three lock sites through
`String(req.workspaceId)` (`:630`, `:1180`, `:1380`), which removes the assertion without
checking the invariant. `issues.ts` is the version that actually fails loudly.

The lesson I did not have before: the guard around a synchronization primitive's key is part of
the primitive. Getting `pg_advisory_xact_lock` right buys nothing if the key can be garbage.

### How I would apply it

Reach for an advisory lock whenever the resource I need to serialize on isn't a row I can lock:
generating the next value in a per-tenant series, guarding a "run this migration once" step
across several booting app instances, or making a scheduled job single-flight without adding
Redis. The rule I'm taking away — if the thing to lock has no primary key, `FOR UPDATE` is the
wrong tool. And always the `_xact_` variant unless there's a specific reason to outlive the
transaction, because pooled connections make session-scoped locks a liability.

---

## 2. Worker-scoped Playwright fixtures over ephemeral Docker containers

**Where:** `e2e/fixtures/isolated-env.ts:108-149` (`dbContainer`, Postgres), `:153-201`
(`apiServer`), `:208-265` (`webServer`, the Vite preview server). Import at `:18`.

### What it does

Playwright fixtures are usually per-test. This file uses the second element of the fixture tuple
to change the lifetime. `:108-149`, with the `if (debug) console.log(...)` lines elided and
nothing else changed:

```typescript
  dbContainer: [
    async ({}, use, workerInfo) => {
      const workerTag = `[Worker ${workerInfo.workerIndex}]`;
      const debug = process.env.DEBUG === '1';
      …
      // Retry container startup to handle intermittent Docker port binding failures
      // Under parallel load, Docker's port allocation can get congested
      let container!: StartedPostgreSqlContainer;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          container = await new PostgreSqlContainer('postgres:15')
            .withDatabase('ship_test')
            .withUsername('test')
            .withPassword('test')
            .withStartupTimeout(120000)
            .start();
          break;
        } catch (err) {
          …
          if (attempt === 3) throw err;
          await new Promise(r => setTimeout(r, 2000 * attempt));
        }
      }

      try {
        const dbUrl = container.getConnectionUri();
        …
        // Run schema and migrations
        await runMigrations(dbUrl);
        …
        await use(container);
      } finally {
        …
        await container.stop();
      }
    },
    { scope: 'worker' },
  ],
```

`{ scope: 'worker' }` means the container starts once per parallel worker and is shared by every
test that worker runs. `apiServer` then declares `dbContainer` as a dependency and Playwright
wires the graph, so each worker ends up with its own Postgres container on a Docker-assigned
port, its own API process on a port derived from `workerInfo.workerIndex`, and its own preview
server. Full stack per worker, nothing shared.

Two details are load-bearing. `await use(container)` sits inside a `try` whose `finally` stops
the container — a fixture is a coroutine that suspends at `use`, and cleanup has to be in
`finally` or a thrown test leaks a container. And container startup retries three times with
increasing backoff, because Docker's port allocator does actually fail under parallel load.

### Why it matters

This is the difference between tests that are independent and tests that merely appear to be.
Sharing one database across workers means test A's writes are visible to test B, so ordering
becomes load-dependent and you get flake that only reproduces at high worker counts. Isolating
at the worker rather than the test is the right granularity: per-test containers would be
correct but pay a container boot per test.

It also gave me the contrast that produced a real audit finding. The E2E suite has this
carefully isolated environment, while the unit test suite at `api/src/test/setup.ts:14` runs
`TRUNCATE … CASCADE` over 15 tables against whatever `DATABASE_URL` resolves to. `api/src/db/
client.ts:11-12` loads `.env.local` then `.env` and nothing else; there is no `.env.test` in the
repo, so that is the developer's own database. Same repo, same team, opposite philosophies.
Seeing the good version first is what made the bad version obvious.

It is not hypothetical. `docs/audit/raw/lane5-verification-gate.txt` records a `pnpm test` run
that came back 450/451 purely because an earlier E2E session had truncated the dev database out
from under it; two runs after `pnpm db:seed` were 451/451. The suite reported a source defect
that did not exist.

### How I would apply it

Two things. First, whenever a test suite needs a real dependency, spin the real thing in a
container rather than mocking it or sharing a long-lived instance — the fidelity is worth the
boot cost, and worker scope amortizes it. Second, and more general: fixture scope is a design
decision, not a default. Before writing a fixture I now ask what the *cheapest* level of sharing
is that still guarantees isolation, and set the scope deliberately. Also stealing the retry
loop — infrastructure that boots reliably alone will not boot reliably eight at a time.

---

## 3. Partial expression index on a JSONB path

**Where:** `api/src/db/schema.sql:358`, introduced by
`api/src/db/migrations/002_person_membership_decoupling.sql:29-31`.

### What it does

One line combining three Postgres features I'd never stacked together:

```sql
CREATE INDEX IF NOT EXISTS idx_documents_person_user_id
ON documents ((properties->>'user_id'))
WHERE document_type = 'person';
```

- **Expression index** — indexes the computed result of `properties->>'user_id'`, not a column.
  Postgres stores the extracted value and uses the index for any query whose `WHERE` clause
  contains that exact expression.
- **JSONB path extraction as the indexed expression** — `->>'user_id'` reaches into a schemaless
  blob and makes one key inside it indexable, without promoting it to a real column.
- **Partial index** (`WHERE document_type = 'person'`) — only rows of that type get an entry. Of
  the ten members of the `DocumentType` union (`shared/src/types/document.ts:34-45`), one is
  indexed.

The line above it, `schema.sql:357`, is a GIN index on the whole `properties` column. The
migration comment says why both exist: *"The GIN index on properties already exists from
migration 001, but this is more specific."* GIN handles arbitrary containment queries across
every key; this one makes a single hot lookup path cheap.

### Why it matters

It resolves what looked to me like the central tension in this architecture. Everything lives in
one `documents` table with a `document_type` discriminator and a schemaless `properties` JSONB
bag — `properties: Record<string, unknown>` on the base `Document` interface
(`shared/src/types/document.ts:236-265`, the field itself at `:247`), narrowed per type by the
variants that extend it at `:268-317`. The schema flexibility is the whole point of the design,
and my assumption was that it costs you indexability — that you can't index what has no declared
shape.

You can. This is the escape hatch that makes the tradeoff survivable: keep the flexible bag,
then promote individual hot keys into indexes as access patterns emerge, without a migration
that adds a column and backfills it. The partial predicate is what keeps it cheap — index size
tracks the person documents only, and it stays that way as issues grow.

That reframed the JSONB-vs-columns decision for me. It isn't a one-time either/or made at design
time. It's a spectrum you can move along later, per key, as you learn which keys are hot.

### How I would apply it

When I next design a schema with a mix of stable and evolving fields, I'll stop treating "column
or JSONB" as a decision I have to get right upfront. Stable fields become columns; everything
else goes in a JSONB bag; and the moment a query on some JSONB key shows up in slow logs, it
gets an expression index — with a partial predicate if only one subtype of row is ever queried
that way. No migration, no backfill, no downtime.

The narrower habit worth keeping: a partial predicate is nearly free to add and often cuts index
size by an order of magnitude. If a query always carries a constant filter, that filter belongs
in the index definition.
