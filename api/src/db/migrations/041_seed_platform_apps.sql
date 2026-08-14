-- Migration 041: scaffolding for the first-party OAuth apps (PF-054, PF-056)
--
-- Lane L02, slice S5. Number 041 from this lane's reserved block (039-042).
--
-- WHAT THIS FILE DOES AND DELIBERATELY DOES NOT DO.
--
-- It creates the STRUCTURE the first-party apps hang off: the system owner user
-- and the dedicated grader workspace. Both are one-time, secret-free facts, and
-- a numbered migration is the right home for them.
--
-- It does NOT insert the app rows. That was the first design and it was wrong,
-- for a reason worth recording: `migrate.ts` skips any migration already in
-- `schema_migrations`, so a numbered file runs EXACTLY ONCE per database. An
-- app row seeded that way would never see a secret set after the first deploy,
-- and PF-055's third case — "reseeding with a rotated value rewrites the hash"
-- — would be unreachable, because the statement would never run again.
--
-- So the app upsert lives in `seedPlatformApps()` (api/src/db/platformApps.ts),
-- which `db:migrate` calls on EVERY invocation. That is what actually delivers
-- what docs/architecture.md promises — "seeded by migration, so it provably
-- exists in deployed environments" — since the guarantee being bought is "runs
-- on the same schedule as db:migrate", not "is physically a .sql file".
--
-- The repo does not do this today at all (L99 finding G1): api/src/db/seed.ts
-- calls seedAgentApiToken(), and `db:seed` does not run on deploy the way
-- `db:migrate` does.
-- ---------------------------------------------------------------------------
-- 1. The owner every first-party app hangs off.
--
-- oauth_apps.owner_user_id is NOT NULL (migration 039) and D2 makes a deleted
-- owner deactivate their apps, so these rows need an owner that is not a
-- person. A dedicated system user is the honest way to say "nobody's personal
-- account is load-bearing for the platform's own credentials".
-- ---------------------------------------------------------------------------
INSERT INTO users (id, email, name)
VALUES ('00000000-0000-4000-8000-0000000000b1', 'platform-apps@ship.local', 'Ship Platform')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. The dedicated grader workspace.
--
-- p.18 asks how graders get an app "without exposing your tenant's data". The
-- answer is tenancy: the grader and demo apps belong to a workspace of their
-- own, so a token issued to them sees that workspace and no other.
-- ---------------------------------------------------------------------------
INSERT INTO workspaces (id, name)
VALUES ('00000000-0000-4000-8000-0000000000a1', 'Grader Sandbox')
ON CONFLICT (id) DO NOTHING;

INSERT INTO workspace_memberships (user_id, workspace_id, role)
VALUES (
  '00000000-0000-4000-8000-0000000000b1',
  '00000000-0000-4000-8000-0000000000a1',
  'admin'
)
ON CONFLICT DO NOTHING;
