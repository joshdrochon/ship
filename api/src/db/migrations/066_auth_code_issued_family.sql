-- 066_auth_code_issued_family.sql
-- Lane L04, PF-104. Link a redeemed code to the token family it produced.
--
-- ── Why this column exists ───────────────────────────────────────────────────
-- RFC 6749 §4.1.2: if an authorization code is used more than once, the server
-- "SHOULD revoke all tokens previously issued based on that authorization code".
-- A code presented twice means either the client is broken or the code leaked,
-- and the safe reading is the second.
--
-- Acting on that requires knowing WHICH tokens the first redemption produced,
-- and nothing else in the schema records the link: `oauth_tokens.family_id` is a
-- grouping key with no row of its own, and the code row had no way to name it.
--
-- ── Why it is written by the CONSUME statement and not afterwards ────────────
-- The family id is generated BEFORE issuance and handed to `issueTokenPair`,
-- so the same conditional `UPDATE … WHERE consumed_at IS NULL` that burns the
-- code also records the family. One statement, so a crash between "burned" and
-- "recorded" is not a state this table can be in — which matters, because that
-- state is precisely a leaked code whose family we can no longer revoke.
--
-- ── Nullable, and the null cases are real ───────────────────────────────────
--   · A code burned by a FAILED PKCE verification (PF-102) produced no tokens.
--     There is no family, and the replay path correctly finds nothing to revoke.
--   · Rows written before this migration.
--
-- ── No foreign key, deliberately ────────────────────────────────────────────
-- `family_id` is not a primary key anywhere — `oauth_tokens` has many rows per
-- family and no `oauth_token_families` table exists. An FK would require
-- inventing one to satisfy a constraint, which is a table earning its keep by
-- being referenced rather than by being needed.

ALTER TABLE oauth_authorization_codes
  ADD COLUMN IF NOT EXISTS issued_family_id UUID;

COMMENT ON COLUMN oauth_authorization_codes.issued_family_id IS
  'The oauth_tokens.family_id this code produced, recorded by the same statement that consumed it. NULL when the code was burned without issuing (failed PKCE). Lane L04 PF-104.';
