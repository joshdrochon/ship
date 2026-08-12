-- Migration 043: oauth_tokens — access and refresh tokens in ONE table (PF-151)
--
-- Lane L06, slice S1. Number 043 is the first in the block PF-021 reserved for
-- this lane (043–046) in api/src/db/migrations/RESERVATIONS.md. It lands AFTER
-- L02's 039_oauth_apps.sql, which is what makes the `app_id` foreign key below
-- resolvable: migrate.ts applies files in filename order, and 039 < 043.
--
-- ---------------------------------------------------------------------------
-- ONE TABLE, NOT TWO.
-- ---------------------------------------------------------------------------
-- Access and refresh tokens share every column that matters — the family, the
-- owning app, the user, the workspace, the granted scopes, the expiry, the
-- revocation bookkeeping — and differ only in `token_type` and in TTL. Two
-- tables would buy nothing and would cost the property this lane's theft
-- signal depends on: family revocation (PF-168) is
--
--     UPDATE oauth_tokens SET revoked_at = ... WHERE family_id = $1
--
-- one statement that either applies or does not. Split across two tables it is
-- two statements that can partially apply, which is a half-revoked family — a
-- state where the stolen refresh token is dead and the live access token it was
-- paired with is not. That is precisely the bug PRD p.3's "reuse invalidates the
-- family" exists to prevent, and it would be invisible to a test that only
-- checks the refresh side.
--
-- ---------------------------------------------------------------------------
-- SECRET STORAGE. Same discipline as `oauth_apps` (D1) and for the same reason.
-- ---------------------------------------------------------------------------
-- `docs/architecture.md:138` already commits to it: "Access tokens are opaque
-- high-entropy strings stored hashed (same discipline as the existing
-- `api_tokens` table)". Unsalted SHA-256 over 32 bytes of crypto.randomBytes.
-- The no-salt argument is entropy, not laziness — a salt defends against
-- precomputation over a small input space, and there is no precomputable space
-- in a uniform draw from 2^256. See platform/oauth/tokens.ts for the full
-- write-up; it is the same argument platform/apps/secrets.ts makes for
-- client_secret, and if that one ever stops holding, so does this one.
--
-- The raw token is never stored in any column. PF-152 asserts that by scanning
-- every text column of a freshly written row for the raw value.

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Hex SHA-256 of the raw token. The lookup key on every /api/v1 request:
  -- the middleware hashes the presented value and finds the row by digest, so
  -- a database dump yields no usable credential. UNIQUE because a collision
  -- would mean two tokens resolving to one identity.
  token_hash TEXT NOT NULL,

  -- First 8 characters of the token's random portion, in clear (PF-152).
  -- Mirrors api_tokens.token_prefix ("First 8 chars for identification",
  -- api/src/db/schema.sql:254) and oauth_apps.secret_prefix. It is how an
  -- operator names WHICH token in a revocation audit without holding one.
  -- 8 base64url characters is 48 bits of a 256-bit value.
  token_prefix TEXT NOT NULL,

  -- CHECK-constrained to exactly two values. A third type is a design change,
  -- not a data value, and should fail at the database rather than silently
  -- create a class of token no code path knows how to expire.
  token_type TEXT NOT NULL CHECK (token_type IN ('access', 'refresh')),

  -- THE THEFT SIGNAL'S ANCHOR (PRD p.3).
  --
  -- Every token issued by one grant redemption, and every token descended from
  -- it by rotation, shares one family_id. Reuse of a spent refresh token
  -- revokes the family — keyed on THIS column, never on "the previous token",
  -- which is what makes PF-169 true: replaying a long-spent R1 after three
  -- rotations still kills the current pair. NOT NULL because a token with no
  -- family is a token the revocation sweep cannot reach.
  family_id UUID NOT NULL,

  -- ON DELETE RESTRICT, matching oauth_apps' own FK reasoning (PF-031, D2).
  -- Under D2 a deleted owner DEACTIVATES apps rather than destroying rows, so
  -- nothing should ever be deleting an app row out from under live tokens. If
  -- something tries, failing loudly beats destroying the rows that an audit
  -- trail's client_id has to stay resolvable against.
  app_id UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE RESTRICT,

  -- NULLABLE, deliberately. PlatformAuthContext.userId is `string | null`
  -- (platform/scopes/registry.ts) because a first-party machine-to-machine
  -- token belongs to an app and to no human. A NOT NULL here would force the
  -- client-credentials grant to invent a fake user.
  user_id UUID REFERENCES users(id) ON DELETE RESTRICT,

  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- The RESOLVED grant, not the app's requested_scopes. Copied onto the token
  -- at issuance so that narrowing an app's requested scopes later cannot
  -- retroactively widen or shrink what an already-issued token may do.
  scopes TEXT[] NOT NULL,

  -- NOT NULL for both types. An access token without an expiry is a permanent
  -- credential, which is the thing p.3's rotation policy exists to avoid.
  expires_at TIMESTAMPTZ NOT NULL,

  -- ONE-TIME USE (PF-167). Set on a refresh token when it is exchanged. The
  -- spend is a conditional UPDATE ... WHERE spent_at IS NULL, whose zero-row
  -- result IS the reuse signal — never a SELECT followed by an UPDATE, which
  -- two concurrent exchanges would both pass.
  spent_at TIMESTAMPTZ,

  -- Revocation is an UPDATE, never a DELETE (PF-165). The row stays so the
  -- audit trail resolves against it and so "why is this token dead" has an
  -- answer. Same reasoning as the RESTRICT above and as L02's PF-051.
  revoked_at TIMESTAMPTZ,

  -- Machine-readable tag, not prose: 'refresh_token_reuse', 'app_revoked',
  -- 'rotated'. A caller never sees it; it is for the operator reading the table.
  revocation_reason TEXT,

  -- THE ROTATION CHAIN (PF-153). Self-referencing: points at the token this one
  -- succeeds. Walking it end to end is what makes PF-169's "replaying R1 kills
  -- A3" provable rather than incidental — a test can show R1 → R2 → R3 is one
  -- chain in one family rather than three unrelated rows that happen to share
  -- an id. NULL for the first pair of a family.
  replaces_token_id UUID REFERENCES oauth_tokens(id) ON DELETE RESTRICT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A revocation is recorded or it is not. A revoked_at with no reason is a row
  -- no reader can interpret, which is the same coherence argument
  -- oauth_apps_deactivation_coherent makes for deactivation.
  CONSTRAINT oauth_tokens_revocation_coherent CHECK (
    (revoked_at IS NULL AND revocation_reason IS NULL) OR
    (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)
  )
);

-- The bearer middleware's lookup, on every single /api/v1 request. UNIQUE
-- rather than a plain index: two rows with one digest would be two identities
-- behind one credential.
CREATE UNIQUE INDEX IF NOT EXISTS oauth_tokens_token_hash_key
  ON oauth_tokens (token_hash);

-- The revocation sweep (PF-168). Family revocation touches every row of one
-- family and must not degrade into a sequential scan of the whole table on the
-- theft path, which is the one path where latency is a security property.
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_family
  ON oauth_tokens (family_id);

-- The expiry sweeper (`deleteExpired`, PF-154).
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expires_at
  ON oauth_tokens (expires_at);

-- revokeByApp (PF-165) — the missing half of L02's leaked-secret playbook.
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_app
  ON oauth_tokens (app_id);
