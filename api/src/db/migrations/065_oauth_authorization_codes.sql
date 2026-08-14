-- 065_oauth_authorization_codes.sql
-- Lane L04, PF-086. The authorization code is a ROW, and it carries the PKCE challenge.
--
-- ── Why a table and not a process map ────────────────────────────────────────
-- PRD p.2 says `code_challenge` and `code_challenge_method` are "recorded at
-- /oauth/authorize". *Recorded* is the operative word. The token exchange is a
-- different HTTP request that may land on a different process behind a load
-- balancer, and a Map in module scope would make the flow work on one instance
-- and fail on two — the classic hand-rolled-OAuth bug that only appears after
-- the first horizontal scale-out. It would also lose every in-flight
-- authorization on deploy.
--
-- ── Numbering ────────────────────────────────────────────────────────────────
-- L04 had no reserved block in `RESERVATIONS.md`. Taken from the unallocated
-- 065–069 range under that file's Rule 3, and the row is recorded there rather
-- than taken silently. 065 lands after L02's 039 (`oauth_apps`, the FK target)
-- and after L06's 043 (`oauth_tokens`), which is the apply order the FK needs.
--
-- ── ON DELETE RESTRICT on app_id ─────────────────────────────────────────────
-- Same reasoning migration 039 gives for `owner_user_id` and 043 gives for
-- `app_id`: D2 says an app is deactivated, never deleted, so a code whose app
-- vanished is a state the model does not have. RESTRICT makes the database say
-- so instead of silently orphaning grants. PF-086's test asserts the FK is
-- RESTRICT rather than trusting this comment.
--
-- ── What is NOT here ─────────────────────────────────────────────────────────
-- No `code` column, in any form. The row stores `sha256(code)` only (PF-087) —
-- the same discipline `oauth_tokens` applies to access tokens and D1 applies to
-- `client_secret`. A leaked database must not yield a redeemable code.
--
-- No `grant_id` and no mutable grant record. D4 (2026-08-12) settled scope
-- upgrades as re-consent with union: a new scope restarts /oauth/authorize and a
-- fresh token replaces the old one. There is deliberately nothing here to
-- UPDATE, which is the property that makes that decision cheap.

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Unsalted SHA-256 (hex) of the raw code. The raw value exists only in the
  -- redirect that carries it and in the client's memory. 32 bytes of CSPRNG
  -- output has nothing for a salt to defend against — salts stop precomputation
  -- against low-entropy human input, which this is not (same argument as D1).
  code_hash TEXT NOT NULL,

  -- First 8 chars of the code, in clear, for identification in a log or an
  -- operator query. Copies the `oauth_tokens.token_prefix` and
  -- `oauth_apps.secret_prefix` convention rather than inventing a third.
  code_prefix TEXT NOT NULL,

  app_id UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE RESTRICT,

  -- NOT NULL, unlike `oauth_tokens.user_id`. An authorization code is by
  -- definition the product of a human at a consent screen; there is no
  -- machine-to-machine path through this table (that is client_credentials,
  -- D5a, and it never mints a code).
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- RFC 6749 §4.1.3: the redirect_uri presented at the token exchange must equal
  -- the one used at authorize. Recorded here so the exchange compares against
  -- what THIS grant used, not against the app's whole registered list — an app
  -- with two registered URIs must not be able to redeem a code issued for one
  -- against the other.
  redirect_uri TEXT NOT NULL,

  -- The RESOLVED grant (intersection of app registration and user consent,
  -- PF-074), never the raw `scope` query parameter.
  scopes TEXT[] NOT NULL,

  -- PRD p.2, recorded at /oauth/authorize. Both NOT NULL: PKCE is mandatory on
  -- every code this server issues, and a nullable challenge is what would let
  -- someone later justify an `if (challenge)` branch that skips verification
  -- (PF-103 greps for exactly that branch).
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,

  expires_at TIMESTAMPTZ NOT NULL,

  -- Single use. Set inside the same transaction that issues the token pair
  -- (PF-104), under a row lock, so two simultaneous exchanges produce exactly
  -- one pair. NULL means unredeemed.
  --
  -- Consumed rows are NOT deleted at redemption: a replayed code has to be
  -- recognisable as replayed in order to revoke the family it produced
  -- (RFC 6749 §4.1.2). The sweeper (PF-112) removes them after a retention
  -- window instead.
  consumed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A code is looked up by hash on exactly one path, and a duplicate hash would
  -- mean a CSPRNG failure. UNIQUE makes that loud instead of ambiguous.
  CONSTRAINT oauth_authorization_codes_code_hash_key UNIQUE (code_hash),

  -- S256 only, enforced by the database as well as by the handler. PF-090
  -- rejects `plain` at the endpoint; this stops any other writer — a seed, a
  -- future grant type, a migration — from inserting one behind the endpoint's
  -- back.
  CONSTRAINT oauth_authorization_codes_method_s256
    CHECK (code_challenge_method = 'S256')
);

-- The sweeper's index (PF-112). It scans by expiry, and without this it scans
-- the table.
CREATE INDEX IF NOT EXISTS idx_oauth_authorization_codes_expires_at
  ON oauth_authorization_codes (expires_at);

COMMENT ON TABLE oauth_authorization_codes IS
  'RFC 6749 §4.1 authorization codes with their RFC 7636 PKCE challenge. Single-use, 60s TTL, stored hashed. Lane L04 PF-086.';
