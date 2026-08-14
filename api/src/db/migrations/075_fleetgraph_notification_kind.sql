-- ---------------------------------------------------------------------------
-- L23 PF-702 — a recommendation is not a finding, and one column says so.
-- ---------------------------------------------------------------------------
-- Decision D5b makes the FleetGraph agent read-only. Its two Ship-facing write
-- actions — `comment` (POST /api/documents/:id/comments) and `history_note`
-- (POST /api/issues/:id/history) — have no public route and no scope on PRD
-- p.3, so under the rewire they become RECOMMENDATIONS delivered through
-- `fleetgraph_notifications`: the agent's own table, never the public API.
--
-- Before this column, that table carried `title`, `body`, `target_id`, `state`
-- and `pending_thread_id` and nothing separating *"here is a finding you are
-- accountable for"* from *"here is a comment the agent would have posted."*
-- Two consequences, and the second is the one that would have shipped silently:
-- PF-699's assertion has nothing to count, and a recipient sees two different
-- kinds of message rendered identically.
--
-- ---------------------------------------------------------------------------
-- WHY A COLUMN AND NOT A TABLE.
-- ---------------------------------------------------------------------------
-- Ship's standing rule is that everything is a document and content tables are
-- not added (`.claude/CLAUDE.md`, Philosophy Enforcement). A
-- `fleetgraph_recommendations` table would be a second delivery channel with a
-- second index, a second reader in the UI and a second thing to keep in step
-- with the notification lifecycle — more work and worse.
--
-- The rejected cheap alternative was a prefix convention on `title`
-- ("[recommendation] …"). That is a string-matching invariant, and string
-- matching invariants rot: the first person to reword a title breaks the query
-- and nothing fails until someone reads a report.
--
-- ---------------------------------------------------------------------------
-- WHY THE DEFAULT IS 'finding' AND NOT NULL.
-- ---------------------------------------------------------------------------
-- Every row that exists today was written by the delivery node and IS a
-- finding. A nullable column with no default would make those rows say "we do
-- not know", which is false — we do know — and would put a three-way branch in
-- every reader. `NOT NULL DEFAULT 'finding'` backfills the truth in one
-- statement and leaves every existing row meaning exactly what it meant before.
--
-- The CHECK is the same call migration 043 makes for `oauth_tokens.token_type`:
-- a third kind is a design change, not a data value, and it should fail at the
-- database rather than silently create a class of notification no reader knows
-- how to render.
-- ---------------------------------------------------------------------------

ALTER TABLE fleetgraph_notifications
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'finding';

-- Added separately and guarded, so re-running on a database that already has
-- the column is a no-op rather than a duplicate-constraint error.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fleetgraph_notifications_kind_check'
  ) THEN
    ALTER TABLE fleetgraph_notifications
      ADD CONSTRAINT fleetgraph_notifications_kind_check
      CHECK (kind IN ('finding', 'recommendation'));
  END IF;
END $$;

-- The banner query at `idx_fleetgraph_notif_target` is deliberately NOT
-- touched. It is `(target_id) WHERE state = 'pending'` and it stays exactly
-- that: a document's banner wants every pending notification about it,
-- regardless of which kind. Adding `kind` to that index would narrow a query
-- that must not narrow, and PF-702 asserts the index is still the one the
-- planner picks.
--
-- The one query that DOES filter on kind is the count in PF-699's assertion and
-- the demo query in PF-710, both of which are already keyed on
-- `observation_id` or on a small workspace scan. Indexing for them would be
-- write amplification on the agent's hottest write path for the benefit of a
-- test and a stage demo.
