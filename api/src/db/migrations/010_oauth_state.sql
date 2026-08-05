-- Migration: Store OAuth state in database instead of memory session
-- Purpose: Prevent OAuth flow failures when server restarts during authentication
--
-- OAuth flows require state, nonce, and code_verifier to be stored temporarily
-- between the authorization redirect and the callback. Using the database instead
-- of in-memory session ensures the flow survives server restarts.

-- IF NOT EXISTS, because migrate.ts applies schema.sql before any migration and
-- schema.sql carries current state — which already contains this table. The bare
-- CREATE therefore raised "already exists" on every fresh database, and the outer
-- handler in migrate.ts treated that as benign and stopped applying migrations
-- entirely. 011 onward silently never ran, with exit code 0.
--
-- On an existing database this migration is already recorded in
-- schema_migrations and will not execute again, so the change is safe after the
-- fact.
CREATE TABLE IF NOT EXISTS oauth_state (
  state_id TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Index for cleanup queries
CREATE INDEX IF NOT EXISTS idx_oauth_state_expires_at ON oauth_state(expires_at);

-- Comment for documentation
COMMENT ON TABLE oauth_state IS 'Temporary storage for OAuth PKCE flow state. Entries auto-expire after 10 minutes.';
