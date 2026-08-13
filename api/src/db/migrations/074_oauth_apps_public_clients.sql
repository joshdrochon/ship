-- 074_oauth_apps_public_clients.sql
--
-- L24 / PF-734 — the column L99 F27 and F50 both name as the fix.
--
-- WHY THIS EXISTS
-- ---------------
-- `/oauth/token`'s `authenticateClient` returns null unless BOTH `client_id`
-- and `client_secret` are presented, so every grant is unreachable for a PUBLIC
-- client. RFC 6749 §2.1 defines a public client as one that "cannot maintain
-- the confidentiality of its credentials" — a browser single-page app and a CLI
-- are the two canonical examples, and RFC 7636 (PKCE) exists precisely so those
-- clients can run the authorization-code grant safely without a secret.
--
-- Consequences measured before this migration was written:
--   * PRD p.5 Testing Scenario 2 wants Auth Code + PKCE "from a registered web
--     app". A browser app that ships a client_secret is not a registered web
--     app, it is a leaked secret. So TS-2 / MVP gate item 2 was unreachable.
--   * L99 F50: the device grant is blocked identically, so TS-3's "test CLI"
--     could only be driven as a confidential client.
--
-- WHAT `is_public` MEANS
-- ---------------------
-- `false` (the default, and every existing row) — a CONFIDENTIAL client. Client
-- authentication at `/oauth/token` is unchanged: the secret is required, exactly
-- as RFC 6749 §3.2.1 requires for a client that has one.
--
-- `true` — a PUBLIC client. `/oauth/token` accepts `client_id` alone. The
-- security of the exchange rests on PKCE (which this server already makes
-- MANDATORY and S256-only — see `platform/oauth/authorize.ts`) plus the
-- byte-for-byte `redirect_uri` match, which is the RFC 7636 threat model.
--
-- DEFAULT FALSE IS THE SECURITY PROPERTY.
-- A row that predates this column, or a registration that does not mention
-- public clients, is confidential. Becoming a public client is a deliberate act
-- recorded in a column, never an inference from a missing request parameter —
-- inferring it would let anyone downgrade a confidential app to a public one by
-- simply omitting the secret, which is the whole attack this column prevents.
--
-- The `client_secret_hash` column stays NOT NULL and public clients still carry
-- one. A public registration's secret is unusable-by-policy rather than absent,
-- which keeps `verifyClientSecret` a total function and means no other lane's
-- code has to learn about a nullable secret.

ALTER TABLE oauth_apps
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN oauth_apps.is_public IS
  'RFC 6749 §2.1 public client: /oauth/token accepts client_id alone, PKCE carries the proof. Default false = confidential.';
