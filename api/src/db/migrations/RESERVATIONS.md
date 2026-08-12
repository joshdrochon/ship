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
| 060–062 | **L03/L09** | scope grant storage, `documents.created_at NOT NULL` (F15) |
| 063–064 | **L08** | keyset indexes for public cursor pagination (PF-222) |
| 065–066 | **L04** | `oauth_authorization_codes` — the auth-code row and its PKCE challenge (PF-086) |
| 067–069 | — | unallocated; ask before taking |

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

L15's `PF-421` declares a foreign key to `oauth_apps`, which L02 creates at 039. The
block order above is also the apply order, so the FK's target exists by the time
L15's file runs. This is the ordering question raised as **B3** in
`tickets/plugforge/lane-99-unassigned.md`; the answer is "L02's block is numerically
first", and it holds without any lane having to coordinate at write time.

## Rules

1. **Never renumber a migration that has been applied anywhere**, including a
   developer's local database. `schema_migrations` records the old name; renaming the
   file makes the migration run a second time.
2. **Never edit an applied migration.** Write a new one in your block.
3. If your block runs out, add a row to this table rather than reaching into the
   unallocated range silently.
4. `schema.sql` is initial-setup only. Every change to an existing table is a
   numbered migration (see `.claude/CLAUDE.md`).
