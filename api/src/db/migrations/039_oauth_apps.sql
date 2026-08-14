-- Migration 039: oauth_apps — the OAuth application registry (PF-031)
--
-- Lane L02, slice S1. Number 039 is drawn from the block PF-021 reserved for this
-- lane (039–042) in api/src/db/migrations/RESERVATIONS.md. It is deliberately the
-- FIRST number in the reserved sequence: L15's PF-421 declares a foreign key into
-- this table, and migrate.ts applies files in filename order, so 039 < 047 is what
-- guarantees the FK's target exists when L15's file runs. That is L99 dispute B3,
-- and it is settled by block ordering rather than by cross-lane coordination.
--
-- COLUMN PROVENANCE. PRD p.2 names six columns in the OAuth App Model row:
-- "oauth_apps table with id, client_id, hashed client_secret, redirect_uris,
-- owner, requested_scopes". Every other column below is required by a decision
-- recorded in tickets/plugforge/lane-02-oauth-apps.md, and each is justified at
-- its definition. A column with no justification is scope creep and should be cut.
--
-- SECRET STORAGE (D1, closed 2026-08-12). client_secret is stored as an unsalted
-- SHA-256 hash. PRD p.15 asks "hashed with what algorithm, salted how" — the
-- answer is SHA-256 and *not salted*, and the defense is entropy, not laziness:
-- the secret is 32 bytes of crypto.randomBytes (PF-033), so there is nothing for
-- a salt to defend. Salts exist to stop precomputation (rainbow tables) against
-- low-entropy human-chosen passwords; a uniform draw from 2^256 has no
-- precomputable space. A slow KDF (bcrypt/argon2) is wrong here for the same
-- reason, and would put a deliberate CPU cost on the hot token-exchange path.
-- This matches the existing api_tokens precedent at api/src/middleware/auth.ts:84.
--
-- NO RECOVERY BY DESIGN. p.2: the raw secret is shown "once on creation and
-- rotation; never recoverable thereafter". There is no column, endpoint or
-- operational process that can return a raw secret. A lost secret is rotated
-- (PF-047), never retrieved.

-- ---------------------------------------------------------------------------
-- oauth_apps
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_apps (
  -- p.2 named column.
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- p.2 named column. Public identifier, NOT a secret: it is returned in full by
  -- every read (PF-044), appears in the audit trail (L12 PF-326) and in the
  -- README (L21 PF-631). Format `ship_app_<base64url>` over >=128 bits (PF-032).
  client_id TEXT NOT NULL,

  -- p.2 named column ("hashed client_secret"). Hex SHA-256. See header for D1.
  -- There is deliberately NO salt column: PF-034 asserts none exists.
  client_secret_hash TEXT NOT NULL,

  -- PF-035. First 8 characters after the `ship_secret_` tag, stored in clear.
  -- This copies the api_tokens.token_prefix pattern (schema.sql:254, "First 8
  -- chars for identification") on purpose: it is how an operator names *which*
  -- secret in a portal list, a rotation confirmation, or a leak alert (PF-050)
  -- without holding one. A prefix of a 32-byte secret leaks 48 bits of a 256-bit
  -- value, which does not meaningfully reduce the search space.
  secret_prefix TEXT NOT NULL,

  -- PF-047. Increments on every rotation. Makes "which generation is this" a
  -- queryable fact rather than an inference from updated_at, and gives the
  -- rotation response something monotonic to return.
  secret_version INT NOT NULL DEFAULT 1,

  name TEXT NOT NULL,

  -- p.2 named column. Stored byte-for-byte as submitted (PF-042): normalization
  -- here would silently change what L04 compares at authorize time, and exact
  -- match is the security property. Validation happens at write time in Zod.
  redirect_uris TEXT[] NOT NULL,

  -- p.2 named column ("owner").
  --
  -- ON DELETE RESTRICT, DELIBERATELY NOT CASCADE (D2, closed 2026-08-12).
  -- p.17 asks what happens when an app's owner is deleted — "apps deactivated,
  -- transferred to admin, or orphaned with a soft-flag? Each is a different
  -- recovery story." We deactivate (active=false), and RESTRICT is what makes
  -- that safe rather than hopeful: a user-delete path that forgets to call
  -- deactivateByOwner() (PF-051) fails loudly on this constraint instead of
  -- silently destroying rows. A CASCADE would delete the row that every
  -- historical audit entry's client_id has to stay resolvable against — the same
  -- lesson L99's F10 records from the other direction, where a hard delete made
  -- an ids-only payload permanently unresolvable.
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  -- Tenancy. p.18 asks how graders get an app "without exposing your tenant's
  -- data"; the answer is that the grader's app (PF-056) belongs to a dedicated
  -- workspace and its tokens see only that workspace. RESTRICT for the same
  -- audit-resolvability reason as owner_user_id.
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- p.2 named column. Validated against L03's ScopeRegistry at registration
  -- (PF-041), never at issuance. Stored as TEXT[] rather than a join table: the
  -- registry is seven fixed names (p.3), the set is read whole on every token
  -- issuance, and a junction table would buy referential integrity against a
  -- registry that lives in code, not in the database.
  requested_scopes TEXT[] NOT NULL,

  -- D2. The deactivation flag the whole owner-lifecycle decision rests on.
  -- L06's token resolution treats active=false as no-app (PF-052), which is what
  -- makes "a deleted user's access cannot outlive them" true rather than stated.
  active BOOLEAN NOT NULL DEFAULT true,

  -- PF-054. Marks the FleetGraph agent's app, seeded by migration so that
  -- docs/architecture.md:178's claim ("seeded by migration, so it provably exists
  -- in deployed environments") is true. Grant-agnostic on purpose: no column here
  -- encodes a grant type, because the agent's grant is L99's D5 and still open.
  is_first_party BOOLEAN NOT NULL DEFAULT false,

  -- D2 bookkeeping. Both NULL while active. deactivation_reason is a short
  -- machine-readable tag ('owner_deleted', 'admin_action'), not prose.
  deactivated_at TIMESTAMPTZ,
  deactivation_reason TEXT,

  -- NOT NULL with a default: L99's F15 records documents.created_at being
  -- nullable as an actual defect, because cursor pagination over a nullable
  -- ordering key silently drops rows. This table is paginated by (created_at, id).
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- An app is deactivated or it is not; a half-recorded deactivation is a state
  -- no reader knows how to interpret.
  CONSTRAINT oauth_apps_deactivation_coherent CHECK (
    (active = true  AND deactivated_at IS NULL AND deactivation_reason IS NULL) OR
    (active = false AND deactivated_at IS NOT NULL)
  )
);

-- p.2's uniqueness requirement, and the conflict target PF-054's idempotent
-- reseed (ON CONFLICT (client_id) DO UPDATE) depends on.
CREATE UNIQUE INDEX IF NOT EXISTS oauth_apps_client_id_key
  ON oauth_apps (client_id);

-- Cursor pagination ordering key. (created_at, id) is the repo's stable-order
-- convention: created_at alone is not unique, so a tie at the page boundary
-- either repeats or drops a row.
CREATE INDEX IF NOT EXISTS idx_oauth_apps_created_at_id
  ON oauth_apps (created_at DESC, id DESC);

-- GET /api/apps lists only the session user's own apps (PF-044).
CREATE INDEX IF NOT EXISTS idx_oauth_apps_owner
  ON oauth_apps (owner_user_id, created_at DESC);
