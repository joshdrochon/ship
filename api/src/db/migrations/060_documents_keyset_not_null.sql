-- 060 — documents.created_at NOT NULL, and the index the PUBLIC page query needs.
--
-- Block 060–062 is allocated to L03/L09 in migrations/RESERVATIONS.md with the
-- subject "scope grant storage, `documents.created_at NOT NULL` (F15)". This
-- file takes 060; 061–062 remain free for L03's scope-grant storage.
--
-- ────────────────────────────────────────────────────────────────────────────
-- (a) THE CONSTRAINT — finding F15
-- ────────────────────────────────────────────────────────────────────────────
--
-- `created_at TIMESTAMPTZ DEFAULT now()` (schema.sql:153) has no NOT NULL. The
-- public list paginates by keyset with a row comparison:
--
--     WHERE (created_at, id) < ($1::timestamptz, $2::uuid)
--
-- Against a row whose `created_at` is NULL that expression evaluates to NULL,
-- and a NULL predicate excludes the row. So such a row is not misordered — it is
-- INVISIBLE. It appears on page 1 (no predicate, and `ORDER BY created_at DESC`
-- puts NULLs first) and then vanishes from every subsequent page; a consumer
-- resuming from a cursor never sees it at all. Silent data loss through the
-- flagship public endpoint, with no error anywhere.
--
-- The rejected alternative was `ORDER BY created_at NULLS LAST` plus a COALESCE
-- in the predicate. It works and it makes the index unusable, which trades
-- silent row loss for a sequential scan on the hottest public endpoint. Fixing
-- the data is the cheaper correct answer.
--
-- The backfill is expected to be a no-op — every row has a value because the
-- DEFAULT has always been there — but it is written rather than assumed, because
-- ALTER ... SET NOT NULL fails outright on a single offending row and a
-- deploy-time failure on Part 1's hottest table is not a good way to find out.
--
-- `updated_at` gets the same treatment. It is not named in F15 and this is a
-- deliberate small widening: the public projection serialises both timestamps,
-- so a NULL `updated_at` is a 500 on a route that would otherwise have worked.
-- One column constrained and its neighbour left nullable would be an odd place
-- to stop.

UPDATE documents SET created_at = now() WHERE created_at IS NULL;
UPDATE documents SET updated_at = COALESCE(created_at, now()) WHERE updated_at IS NULL;

ALTER TABLE documents ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE documents ALTER COLUMN updated_at SET NOT NULL;

-- Keep the defaults. NOT NULL constrains the value; the default is what supplies
-- it for the ~40 insert sites in this repo that do not name the column.
ALTER TABLE documents ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE documents ALTER COLUMN updated_at SET DEFAULT now();

-- ────────────────────────────────────────────────────────────────────────────
-- (b) THE INDEX THAT COVERS THE REAL PREDICATE — PF-259
-- ────────────────────────────────────────────────────────────────────────────
--
-- L08's 063 ships `idx_documents_keyset (created_at DESC, id DESC)`, which
-- covers the page query in the abstract. The query this route actually issues
-- also filters `workspace_id`, `document_type IN (…)`, `archived_at IS NULL`,
-- `deleted_at IS NULL` and the visibility predicate — and every page is scoped
-- to ONE workspace. A bare `(created_at, id)` index makes the planner walk rows
-- newest-first across ALL workspaces, discarding those belonging to others until
-- it has collected a page. On a database with many tenants that is a scan whose
-- cost grows with everyone else's data, which is the failure mode keyset
-- pagination exists to avoid.
--
-- Leading with `workspace_id` makes the scan an ordered range within one tenant.
-- Both indexes are kept: L08's is the generic contract `assertKeysetIndexed`
-- checks, this one is what the live route rides.
CREATE INDEX IF NOT EXISTS idx_documents_workspace_keyset
  ON documents (workspace_id, created_at DESC, id DESC);
