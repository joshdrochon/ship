-- Migration 038: FleetGraph — project intelligence agent
--
-- Architecture and the reasoning for each object here: PRESEARCH.md at the repo
-- root. Where a decision is non-obvious the relevant question is cited inline.
--
-- Four things:
--   1. an index the watermark scan needs                     (Q1)
--   2. scopes on api_tokens, so an agent token can be read-only (Q3, Q29)
--   3. observations — what the agent has already surfaced    (Q19, Q20, Q23)
--   4. notifications — the delivery channel Ship has never had (Q6, Q19)
--   5. watermarks — where the last completed scan got to     (Q24)
--
-- Every statement is guarded. Migrations in this repo run against databases in
-- three different states (fresh, pre-033 legacy, and current), and 010/025/033/035
-- each had to be repaired for exactly this reason.

-- ---------------------------------------------------------------------------
-- 1. Watermark scan index
--
-- The proactive scan is "documents in this workspace changed since the last
-- completed run" — an equality on workspace_id and a range on updated_at.
-- Without this it is a sequential scan over every document in the table
-- (PRESEARCH.md Q1). idx_documents_active covers (workspace_id, document_type)
-- and does not help an ordered range on updated_at.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_documents_workspace_updated
  ON documents (workspace_id, updated_at DESC)
  WHERE archived_at IS NULL AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. api_tokens.scopes
--
-- Today a token inherits every permission of the user who created it — there is
-- no ceiling on what an agent token can do (PRESEARCH.md Q3). FleetGraph's
-- detection path only ever reads, so it gets a read-only token and the autonomy
-- boundary is enforced by the credential rather than only by the graph.
--
-- NULL means "unscoped", which is exactly the behaviour every existing token
-- has today. Nothing changes for them.
-- ---------------------------------------------------------------------------
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS scopes TEXT[];

COMMENT ON COLUMN api_tokens.scopes IS
  'NULL = unscoped, inherits the user''s full permissions (legacy behaviour). '
  'Otherwise a list such as {read} or {read,write:comments}.';

-- ---------------------------------------------------------------------------
-- 3. fleetgraph_observations
--
-- What the agent has already seen and surfaced. This is the memory that
-- accountability.ts does not have: without it every run re-surfaces the same
-- finding, which is both the alert-fatigue failure (Q23) and the largest cost
-- cliff in the design (Q32) — one finding becoming 480 model calls a day.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fleetgraph_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- Stable hash of (signal_type, target_id, threshold bucket). The bucket is
  -- part of it deliberately: an issue idle 5 days and the same issue idle 20
  -- days are different findings and should each be surfaced once.
  fingerprint TEXT NOT NULL,

  signal_type TEXT NOT NULL,
  target_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_surfaced_at TIMESTAMPTZ,

  -- NULL while open. 'accepted' | 'dismissed' | 'resolved' | 'snoozed'.
  -- 'dismissed' is permanent for this fingerprint — a dismissed finding that
  -- returns next week is the fastest way to get the agent switched off (Q23).
  resolution TEXT,
  resolved_at TIMESTAMPTZ,

  -- Set by snooze. The detector is re-run at wake, not replayed, so a condition
  -- that fixed itself in the meantime never comes back (Q23).
  snooze_until TIMESTAMPTZ,

  -- Escalation clock, in business days, per Q6. Counts how many times this
  -- finding has been escalated; capped at one in the graph.
  escalation_count INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- THE suppression key. If this is not unique, the same finding is recorded and
-- re-judged on every run — PRESEARCH.md Q32 names this as the biggest cost cliff
-- in the architecture, and the one bounded by nothing external.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fleetgraph_obs_fingerprint
  ON fleetgraph_observations (workspace_id, fingerprint);

-- Loading the suppression set is the hot read: open findings for a workspace.
CREATE INDEX IF NOT EXISTS idx_fleetgraph_obs_open
  ON fleetgraph_observations (workspace_id, signal_type)
  WHERE resolution IS NULL;

CREATE INDEX IF NOT EXISTS idx_fleetgraph_obs_target
  ON fleetgraph_observations (target_id);

-- Snooze wake-ups.
CREATE INDEX IF NOT EXISTS idx_fleetgraph_obs_snooze
  ON fleetgraph_observations (snooze_until)
  WHERE snooze_until IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. fleetgraph_notifications
--
-- Ship has no notifications table and no webhook infrastructure — "delivers
-- findings to the team" had nowhere to land (PRESEARCH.md Q19). One recipient
-- per finding, resolved by accountability for the signal rather than proximity
-- to it (Q6).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fleetgraph_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  observation_id UUID NOT NULL REFERENCES fleetgraph_observations(id) ON DELETE CASCADE,

  -- Exactly one accountable person. Never a list: a notification everyone
  -- receives is a notification nobody closes (Q6).
  recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  title TEXT NOT NULL,
  body TEXT,

  -- Where the human should land to act on it.
  target_id UUID REFERENCES documents(id) ON DELETE CASCADE,

  -- 'pending' | 'acknowledged' | 'superseded'
  state TEXT NOT NULL DEFAULT 'pending',
  acknowledged_at TIMESTAMPTZ,

  -- Set when the finding needs a human gate before anything happens (Q3, Q21).
  -- Holds the LangGraph thread id so the suspended run can be resumed.
  pending_thread_id TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The UI's query: my open notifications, newest first.
CREATE INDEX IF NOT EXISTS idx_fleetgraph_notif_recipient
  ON fleetgraph_notifications (recipient_user_id, state, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fleetgraph_notif_observation
  ON fleetgraph_notifications (observation_id);

-- Banner lookup when a document is opened.
CREATE INDEX IF NOT EXISTS idx_fleetgraph_notif_target
  ON fleetgraph_notifications (target_id)
  WHERE state = 'pending';

-- ---------------------------------------------------------------------------
-- 5. fleetgraph_watermarks
--
-- How far the last COMPLETED scan got. Advanced only on completion, which is
-- what makes the proactive path crash-safe with no retry logic: an aborted run
-- leaves the mark where it was and the next scan re-covers the window
-- (PRESEARCH.md Q24).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fleetgraph_watermarks (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,

  -- documents.updated_at of the last completed scan. NULL = never scanned, in
  -- which case the first run bounds itself by lookback rather than scanning all
  -- history.
  last_scanned_at TIMESTAMPTZ,

  last_run_completed_at TIMESTAMPTZ,
  last_run_signal_count INTEGER,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
