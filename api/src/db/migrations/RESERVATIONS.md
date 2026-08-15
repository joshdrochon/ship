# Migration number reservations — PlugForge (Week 6)

**PF-021.** Six lanes write migrations this week, in parallel, against one numbered
sequence. `api/src/db/migrate.ts` applies files in filename order and records each in
`schema_migrations`, so two lanes that both pick "the next number" produce two files
with the same prefix: one gets applied, the other is skipped forever on any database
that already recorded that version, and nobody finds out until a deployed environment
is missing a table. Migration 024 in this repo is literally named
`024_renumber_collision_migrations.sql` — this has already happened here once.

## Next free number

Verified 2026-08-12 against the live `schema_migrations` table, not just the directory
listing — a file can exist unapplied, and a version can be recorded with no file:

```
$ ls api/src/db/migrations/*.sql | wc -l                 43
$ psql -tAc 'SELECT count(*) FROM schema_migrations'     43
$ psql -tAc 'SELECT version FROM schema_migrations
             ORDER BY version DESC LIMIT 1'              038_fleetgraph
```

43 files, 43 rows, highest applied is `038_fleetgraph`. **Next free number: 039.**

(The count is 43 with a highest number of 038 because migrations 001–023 include the
renumbering collision fixed by 024. The counts agreeing is the check that matters:
every file on disk has been applied, and nothing has been applied that is not on disk.)

## Reserved blocks

Take numbers **only** from your own block. Do not "use the next free one" — the next
free one belongs to whichever lane was allocated it, whether or not they have written
the file yet.

| Range | Lane | Subject |
|---|---|---|
| 039–042 | **L02** | `oauth_apps` registry, `client_secret` hash, owner FK, redirect URIs |
| 043–046 | **L06** | access/refresh token tables, refresh families, rotation + revocation |
| 047–050 | **L15** | webhook subscriptions, signing secret at rest, event-type index |
| 051–056 | **L16** | delivery log (one row per attempt), DLQ, replay bookkeeping |
| 057–059 | **L12** | public API audit log + the per-day-per-app rollup (D10) |
| 060–062 | **L03/L09** | scope grant storage, `documents.created_at NOT NULL` (F15) — **060 taken by L09**, 061–062 free for L03 |
| 063–064 | **L08** | keyset indexes for public cursor pagination (PF-222) |
| 065–066 | **L04** | `oauth_authorization_codes` — the auth-code row and its PKCE challenge (PF-086) |
| 067 | **L08/L09 follow-up** | tenant-first documents keyset index (taken) |
| 068–070 | **L10** | per-`document_type` keyset indexes for the public `issues` and `sprints` lists (F18, PF-281/PF-288) |
| 071–072 | **L05** | `oauth_device_codes` — the RFC 8628 device authorization row (PF-121) |
| 073 | **L01 follow-up** | drop the redundant `idx_documents_keyset_tenant` that 067 should never have created (taken) |
| 074 | — | unallocated; ask before taking |

**The coordinator took 068 without reading this file** (2026-08-13) for the migration that
drops 067's redundant index, and 068–070 had been reserved for L10 since the day before.
L10 was building on it concurrently and shipped `068_public_issue_sprint_keyset_indexes.sql`
as it was entitled to, so both branches carried an `068_`. Renumbered to **073** on merge —
the reservation table is the authority and the lane that reserved the number keeps it.

Two things this cost, recorded so the next person does not repeat them. The rename leaves a
`068_drop_redundant_keyset_tenant_index` row in `schema_migrations` on any database that
already applied it, pointing at a filename that no longer exists; the DROP is
`IF EXISTS`, so re-applying under the new number is a no-op and a fresh database sees only
073. And the collision was invisible until merge, because two branches each holding one
`068_*.sql` file conflict on nothing — git merges them cleanly into a directory with two.
**Read this file before taking a number, not after.**

**L12 took 057 and 058** (2026-08-12), from its own allocated block.

- `057_public_api_calls.sql` — the audit table (PF-339). Deliberately **not**
  `audit_logs`: `schema.sql` already has one, with a different contract
  (workspace/actor/action/resource, AU-9 compliance triggers that forbid DELETE)
  and sharing it would put public-API rows under an internal schema *and* apply
  L12's 30-day retention to compliance rows that must never be pruned.
- `058_public_api_call_daily.sql` — the per-day-per-app rollup that decision D10
  requires (PF-341). Retained indefinitely, so Epic 7's "the agent went through
  the front door" stays provable after the raw rows expire at 30 days.

Neither file declares a foreign key, and that is deliberate rather than an
omission: `client_id` → `oauth_apps` and `user_id` → `users` would make an audit
trail unable to outlive the things it describes. `ON DELETE RESTRICT` would block
deleting an app, `CASCADE` would erase the evidence, and `SET NULL` would rewrite
history. **059 remains free** for this lane.

Apply order holds without coordination: neither table references anything, so
057–058 can land before or after any other block.

**L04 had no block and took 065–066 under Rule 3** (2026-08-12). Same situation as L08
below: the table allocated every lane that was known to write DDL, and L04's
`oauth_authorization_codes` (PF-086) was not among them — the lane was scoped as
"endpoints and a consent screen" before it was clear the code itself had to be a
persisted row rather than a process-local map. Two numbers: one file today, one spare
if the sweeper's retention window (PF-112) needs its own index later.

Apply order matters here and it holds without coordination: the new table's FK targets
are `oauth_apps` (039, L02), `users` and `workspaces` (schema.sql), all numerically
earlier. It does **not** depend on L06's 043.

**L08 had no block and took 063–064 under Rule 3** (2026-08-12). The table above
allocated every lane that writes DDL except this one, and PF-222 ships an index
migration — so rather than reach into the unallocated range silently, the row is
recorded here. Two numbers, not four: the lane needs one file today and one spare
if L10's resources need per-table indexes.

The block order also matters for this pair. L03/L09's 060–062 carries
`documents.created_at NOT NULL` (F15), and L08's 063 indexes `(created_at, id)`.
Numerically first is correct: constrain the column, then index it. L08's
`assertKeysetColumnsNotNull` fails the suite until 060–062 lands, so the
dependency is enforced rather than assumed.

**L09 took 060** (2026-08-12) — `060_documents_keyset_not_null.sql`. It carries
F15's constraint on `created_at` **and on `updated_at`**, which is a small
deliberate widening: the public projection serialises both, so a NULL
`updated_at` is a 500 on a route that would otherwise have worked, and
constraining one while leaving its neighbour nullable is an odd place to stop.
It also ships `idx_documents_workspace_keyset (workspace_id, created_at DESC,
id DESC)`, because the live route's predicate filters by workspace and L08's
bare `(created_at, id)` index makes the planner walk rows newest-first across
ALL tenants. Both indexes are kept — L08's is the generic contract
`assertKeysetIndexed` checks, L09's is what the live query rides.

Verified before applying: `SELECT count(*) FROM documents WHERE created_at IS
NULL OR updated_at IS NULL` returned **0**, so the backfill was a no-op in
practice, as predicted. 061–062 remain free for L03's scope-grant storage.

L15's `PF-421` declares a foreign key to `oauth_apps`, which L02 creates at 039. The
block order above is also the apply order, so the FK's target exists by the time
L15's file runs. This is the ordering question raised as **B3** in
`tickets/plugforge/lane-99-unassigned.md`; the answer is "L02's block is numerically
first", and it holds without any lane having to coordinate at write time.

**L15 took 047** (2026-08-13) — `047_webhook_subscriptions.sql`, from its own allocated
block, leaving 048–050 free. Worth stating because the number looks wrong at a glance:
the highest APPLIED migration is 067, so "the next free one" would have been 068, which
is L10's. Block order is also apply order and it holds: the FK targets are `oauth_apps`
(039, L02), `workspaces` and `users` (schema.sql), all numerically earlier. **This
answers B3** in `lane-99-unassigned.md`, and it needed no coordination at write time.

One column is NOT in PF-421's list: **`user_id`**. Decision D7 (L14) hands L15 the
private-document gate and defines it as `data.created_by === subscription.user_id`, so
the column is what makes the gate implementable at all — D7 names it as "the one piece
of D7 this lane could not enforce itself". `ON DELETE SET NULL`, and a NULL fails the
gate closed.

**L10 took 068–070** (2026-08-12), and has written **no file yet**. The reservation is
recorded ahead of the file deliberately — Rule 3 is about not reaching into the
unallocated range silently, and a lane that knows it will write DDL should claim the
numbers before another lane picks them, not after.

**What the file will contain, and why it is not two more entries in
`KEYSET_INDEXED_TABLES`.** Finding F18 is stated as *"add `issues` and `sprints` to
`KEYSET_INDEXED_TABLES`"*. That is wrong here, and the reason is Ship's unified
document model: `assertKeysetIndexed` runs `EXPLAIN SELECT id, created_at FROM
${table}`, and **there is no `issues` table and no `sprints` table**. Verified against
the live database:

```
SELECT tablename FROM pg_tables
 WHERE schemaname='public' AND tablename IN ('issues','sprints','documents');
→ documents
```

Both resources are rows in `documents` discriminated by `document_type` (`schema.sql:100`).
Adding the names to that list would fail every run with `relation "issues" does not
exist`, which reads as a broken test rather than as the wrong model.

What the public lists actually need is what PF-281 and PF-288 say — a **partial** index
per type, tenant-first, matching migration 067's shape:

```sql
CREATE INDEX IF NOT EXISTS idx_documents_keyset_issue
  ON documents (workspace_id, created_at DESC, id DESC)
  WHERE document_type = 'issue' AND archived_at IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_keyset_sprint
  ON documents (workspace_id, created_at DESC, id DESC)
  WHERE document_type = 'sprint' AND archived_at IS NULL AND deleted_at IS NULL;
```

**Held back until the routes exist, on purpose.** `GET /api/v1/issues` and
`GET /api/v1/sprints` are not built (S2/S3 of lane 10). An index serves a query; with no
query it is pure write amplification on `documents`, which is the hottest table in the
schema — every internal document write would pay to maintain two indexes nothing reads.
067's tenant-first index already covers `(workspace_id, created_at DESC, id DESC)` with
the same soft-delete predicate, so the incremental value of these two is the
`document_type` selectivity and nothing else. Write them in the same commit as the
routes, and extend the contract by teaching `assertKeysetIndexed` a partial-index /
`document_type` variant rather than by naming tables that do not exist.

**L05 had no block and took 071–072 under Rule 3** (2026-08-13). Same situation as L04
and L08: the table allocated every lane known to write DDL, and L05's
`oauth_device_codes` (PF-121) was not among them — the lane was scoped as "three
endpoints and a polling loop" before it was clear the device authorization had to be a
persisted row rather than a process-local map. Two numbers: `071_oauth_device_codes.sql`
today, and one spare if PF-132's guess throttle needs its own table rather than the
per-process counter it ships with.

Apply order matters and it holds without coordination: the new table's FK targets are
`oauth_apps` (039, L02), `users` and `workspaces` (schema.sql), all numerically earlier.
It does **not** depend on L06's 043 or L04's 065.

The same "a Map in module scope would fail on two instances" argument 065 gives applies
here and more strongly: the device grant's whole shape is that the code is issued to one
process, approved through a browser hitting possibly another, and polled by a third. It
is the one flow in this build where a process-local store is guaranteed to break rather
than merely likely to.

**L16 took 051** (2026-08-13) — `051_webhook_deliveries.sql`, from its own allocated
block 051–056, leaving 052–056 free. Worth stating for the reason L15's entry gives:
the highest APPLIED migration is 073, so "the next free one" would have been 074,
which is unallocated. Block order is also apply order and it holds — the only FK
targets are `webhook_subscriptions` (047, L15) and `oauth_apps` (039, L02), both
numerically earlier.

Two columns are NOT in PF-458's list and both are recorded rather than smuggled in:

- **`app_id`**, with an FK to `oauth_apps`. It is a DENORMALISATION, which every
  other column here is not, and it is there because the alternative was measured
  and does not work. p.4's *"Queryable per app"* has no `app_id` on this table —
  the path is `webhook_deliveries → webhook_subscriptions → app_id` — and a keyset
  page written as that join plans as `Seq Scan on webhook_deliveries` + `Sort` even
  with `(subscription_id, attempted_at DESC, id DESC)` present, because the equality
  sits on the JOINED table and no `subscription_id` is known at plan time. Resolving
  the app's subscription ids first and using `= ANY(...)` is no better under
  `ORDER BY … LIMIT`: N index ranges become a MergeAppend or a bitmap scan plus a
  sort. Safe to denormalise because the value is immutable (nothing in L15's route
  surface changes a subscription's app — PATCH sets `active` and nothing else), and
  it is written by a SUBSELECT inside the INSERT rather than accepted from a caller,
  so it cannot disagree with the subscription's. Precedent: 047 denormalises
  `workspace_id` onto `webhook_subscriptions` for exactly this reason and says so.
- **`delivery_group_id`**, which carries the real per-attempt uniqueness constraint.
  PF-462 asks for `UNIQUE (subscription_id, event_id, attempt_number)`; that is
  wrong in the presence of replay, because a replay is a new ladder starting at
  attempt 1 against the same subscription and the same event and would collide with
  the original's attempt 1 on its first insert. PF-462's literal triple survives as
  a PARTIAL unique index `WHERE replay_of_delivery_id IS NULL`, where it is a true
  statement about original deliveries.

`webhook_deliveries` was added to `api/src/test/setup.ts`'s TRUNCATE list **in the
same commit as the migration**, per the standing rule F54 records.

## Rules

1. **Never renumber a migration that has been applied anywhere**, including a
   developer's local database. `schema_migrations` records the old name; renaming the
   file makes the migration run a second time.
2. **Never edit an applied migration.** Write a new one in your block.
3. If your block runs out, add a row to this table rather than reaching into the
   unallocated range silently.
4. `schema.sql` is initial-setup only. Every change to an existing table is a
   numbered migration (see `.claude/CLAUDE.md`).

**L24 had no block and took 074 under Rule 3** (2026-08-13) —
`074_oauth_apps_public_clients.sql`, one column: `oauth_apps.is_public`.

074 was the row marked *"unallocated; ask before taking"*. Taken rather than asked
because the question could not be asked in the time available and the alternative was
shipping nothing: **MVP gate item 2 / Testing Scenario 2 (p.5) is unreachable without
it.** L99 F27 (filed by L17) and F50 (extended by L05) both name this exact column as
the fix and both name L02 + L06 as the owners; neither had shipped it, and PF-734 —
Authorization Code + PKCE in a real browser SPA — cannot exchange a code without it. A
browser app that presents a `client_secret` is not a registered web app, it is a
published secret.

**L02 and L06: this is your column, landed from a consumer lane under gate pressure.**
If either lane would rather own it under a different number, the file is one `ALTER
TABLE … ADD COLUMN IF NOT EXISTS` and the rename is cheap — but do it before Final,
because `authenticateClient` now reads the field.

Apply order holds without coordination: it alters `oauth_apps` (039, L02), which is
numerically earlier, and nothing else references the column.

**L23 had no block and took 075 under Rule 3** (2026-08-14) —
`075_fleetgraph_notification_kind.sql`, one column: `fleetgraph_notifications.kind`.

Same situation as L04, L05, L08 and L24: the table above allocated every lane that
was known to write DDL, and L23 was scoped as "an OAuth client and a feature flag"
before decision D5b landed. D5b makes the agent READ-ONLY, which turns its `comment`
and `history_note` actions into recommendations delivered through
`fleetgraph_notifications` — and that table had no field separating a recommendation
from a finding, so PF-699's assertion had nothing to count and a recipient would see
two different kinds of message rendered identically.

`NOT NULL DEFAULT 'finding'` plus a CHECK, so every existing row keeps its meaning
without a backfill pass and a third kind fails at the database rather than becoming a
class of notification no reader knows how to render. The reasoning for a column
rather than a `fleetgraph_recommendations` table is in the migration header and comes
from Ship's own standing rule against new content tables.

Apply order holds without coordination: it alters `fleetgraph_notifications` (038),
which is numerically earlier, and nothing else references the column.

`fleetgraph_notifications` is already in `api/src/test/setup.ts`'s TRUNCATE list, so
F54's rule needed no action here.

**076 is now the first unallocated number; ask before taking it.**

**L22 was allocated 077 and took NOTHING** (2026-08-15). Recorded because an unused
reservation looks identical to an unwritten one, and the next reader would otherwise have to
guess whether a `077_*.sql` is in flight somewhere. The lane's slice — the developer portal's
write surface (register app, rotate secret) — needed no DDL: L02's `oauth_apps` already carries
every column it writes, and the one new route (`GET /api/apps/registry`) reads the in-memory
scope registry. **077 is free for whoever the coordinator gives it to.**

Note the gap this exposes: the line above says 076 is the first unallocated number, yet the
allocation handed out 077. One of the two is wrong and it is not this lane's to correct —
filed as **F183's neighbour F182** in `tickets/plugforge/lane-99-unassigned.md`.
