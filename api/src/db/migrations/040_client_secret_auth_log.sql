-- Migration 040: client_secret_auth_log — the leak signal (PF-050)
--
-- Lane L02, slice S3. Number 040 from this lane's reserved block (039-042).
--
-- WHY THIS TABLE EXISTS RATHER THAN A FILTER OVER L12's AUDIT TRAIL.
--
-- PRD p.17 ends the leaked-secret question with "What's the audit signal you'd
-- alert on?". The obvious home would be L12's `public_api_calls`. It cannot be,
-- and this is a measured repo fact rather than an assumption:
--
--   * L12's audit middleware (PF-336) is the second middleware of the /api/v1
--     stack, so it only ever sees requests routed through /api/v1.
--   * A client_secret is presented at /oauth/token, which createApp() mounts at
--     app.use('/oauth', ...) — OUTSIDE /api/v1 entirely.
--
-- So no `public_api_calls` row will ever record a secret authentication, and
-- p.17's signal has nowhere to land unless this lane creates it. If L04 or L06
-- later route the token endpoint through the v1 stack after all, this table
-- collapses into a filter over L12's and should be simplified rather than kept.
--
-- WHAT IT NEVER HOLDS. Not the secret, and not its hash. `secret_prefix`
-- (PF-035) is the identifier, which is exactly the rule L12's PF-340 applies to
-- the audit trail and for the same reason: an alerting table is read by more
-- people, and more often, than the credential store it describes.

CREATE TABLE IF NOT EXISTS client_secret_auth_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Deliberately NOT a foreign key to oauth_apps.
  --
  -- An unknown client_id is one of the three outcomes worth recording — it is
  -- the shape a credential-stuffing probe makes — and an FK would reject
  -- precisely those rows. It would also make the alert table's retention
  -- hostage to the app table's, which D2 already decided should never delete.
  client_id TEXT NOT NULL,

  -- Null when the client_id matched nothing: there is no app whose secret it
  -- could have been a prefix of.
  secret_prefix TEXT,

  -- 'success' | 'unknown_client' | 'bad_secret' | 'app_inactive'.
  -- Not an enum type: adding an outcome would then need a migration in a lane
  -- that does not own this table. A CHECK gives the same protection and is
  -- alterable in one statement.
  outcome TEXT NOT NULL CHECK (
    outcome IN ('success', 'unknown_client', 'bad_secret', 'app_inactive')
  ),

  -- Alert condition (b) counts DISTINCT source IPs for one client_id, so this
  -- is the column that makes "a shared secret being used from somewhere new"
  -- expressible. Nullable: a call over a unix socket or an internal invocation
  -- has no meaningful source address, and a fake one would corrupt the count.
  source_ip TEXT,

  -- Injected, never now(). All three alert conditions are windowed, and a
  -- windowed test that cannot control time is a test that sleeps.
  occurred_at TIMESTAMPTZ NOT NULL
);

-- The index every one of the three alert conditions scans: equality on
-- client_id, range on occurred_at. Outcome is in the index so condition (a)
-- (failed verifications for one client_id in a window) is covered.
CREATE INDEX IF NOT EXISTS idx_client_secret_auth_log_client_time
  ON client_secret_auth_log (client_id, occurred_at DESC, outcome);
