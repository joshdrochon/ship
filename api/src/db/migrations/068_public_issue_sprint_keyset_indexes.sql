-- 068 — keyset indexes for the public `issues` and `sprints` lists.
--
-- Reserved to L10 in `RESERVATIONS.md` (block 068–070). PF-281, PF-288, F18.
--
-- ## Finding F18 is right about the problem and wrong about the fix
--
-- F18 reads: *"Both remaining internal sort keys are unusable for stable keyset
-- pagination: issues sort by mutable priority + `updated_at`; sprints by
-- `(properties->>'sprint_number')::int`, an unindexed JSONB expression."* Both
-- halves are true and both were re-verified against the files
-- (`routes/issues.ts` ORDER BY CASE … , `d.updated_at DESC`; `routes/weeks.ts`
-- ORDER BY `(d.properties->>'sprint_number')::int`).
--
-- The fix it implies — add `'issues'` and `'sprints'` to
-- `KEYSET_INDEXED_TABLES` — cannot work, and the reason is the thing that has
-- already misled one agent:
--
--   SELECT tablename FROM pg_tables
--    WHERE tablename IN ('issues','sprints','documents');
--   -- returns exactly one row: documents
--
-- **`issues` and `sprints` are not tables.** They are `document_type` values in
-- Ship's unified document model (CLAUDE.md, "everything is a document"), so
-- `assertKeysetIndexed`'s `EXPLAIN SELECT … FROM ${table}` would fail with
-- "relation does not exist" rather than reporting a missing index.
-- `KEYSET_INDEXED_TABLES` is therefore left holding `documents` alone, and the
-- correct artifact is two PARTIAL indexes over that one table.
--
-- ## Why partial, and why the tenant leads
--
-- Same shape as 067, for the same reason it had to be corrected: equality
-- columns first, then the sort keys in their sort direction. The query these
-- serve is
--
--   WHERE workspace_id = $1
--     AND document_type = 'issue'
--     AND archived_at IS NULL AND deleted_at IS NULL
--     AND (created_at, id) < ($3, $4)
--   ORDER BY created_at DESC, id DESC
--   LIMIT 26
--
-- An index leading on `created_at` cannot satisfy the `workspace_id` equality,
-- so Postgres walks every workspace's rows in timestamp order or sorts. Leading
-- with `workspace_id` opens the scan at the tenant and walks in
-- `(created_at DESC, id DESC)` order, which turns the keyset predicate into a
-- range start rather than a filter.
--
-- `document_type` is in the partial PREDICATE rather than the key because it is
-- a constant for each of these indexes: one index serves issues, the other
-- serves sprints, and neither wastes a key column storing a value every entry
-- shares. That also keeps each index carrying only live rows of one type — on a
-- table holding ten document types, the issues index is a fraction of the size
-- an all-types index would be, which is what keeps it in cache.
--
-- 067's `idx_documents_keyset_tenant` STAYS and is not superseded. It serves the
-- `documents` resource, whose predicate is `document_type = ANY($3)` over five
-- types — a variable set that no single-type partial index can answer.

CREATE INDEX IF NOT EXISTS idx_documents_keyset_issue
  ON documents (workspace_id, created_at DESC, id DESC)
  WHERE document_type = 'issue'
    AND archived_at IS NULL
    AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_keyset_sprint
  ON documents (workspace_id, created_at DESC, id DESC)
  WHERE document_type = 'sprint'
    AND archived_at IS NULL
    AND deleted_at IS NULL;
