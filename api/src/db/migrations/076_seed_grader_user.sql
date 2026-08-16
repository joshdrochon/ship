-- 076_seed_grader_user.sql
--
-- L26 / grader onboarding — the human who can approve a grant in the Grader
-- Sandbox.
--
-- WHY THIS EXISTS
-- ---------------
-- PRD p.13 requires "a pre-registered OAuth app (read-only scopes) for graders,
-- plus credentials in the README". Migration 041 built the structure for that —
-- the 'Grader Sandbox' workspace and the 'platform-apps@ship.local' system user
-- that owns the apps — and `seedPlatformApps()` writes the app rows on every
-- `db:migrate`. Both grader apps are `is_public = true`, so `ship login` can
-- start AND finish a device grant against them with `client_id` alone.
--
-- Every one of those grants was still unreachable, and this is the measured
-- reason. The device grant's approval leg (`platform/oauth/deviceVerify.ts:317`)
-- and the authorization-code consent screen (`platform/oauth/consent.ts:322,399`)
-- both refuse when the signed-in human's workspace is not the app's:
--
--     if (app.workspaceId !== user.workspaceId) → 403 'Wrong workspace'
--
-- That guard is correct and must stay — `issueTokenPair` stamps the token with
-- the APP's workspace, so a user in workspace A approving an app registered in B
-- would mint a B-scoped token on an A session. F43 closed exactly that hole on
-- the authorize leg.
--
-- The problem was never the guard. It was that the Grader Sandbox had exactly
-- one member — 'platform-apps@ship.local', inserted by 041 with NO
-- `password_hash` — and `POST /api/auth/login` rejects a null hash outright
-- ("This account uses PIV authentication only", `routes/auth.ts:59`). So there
-- was no human on earth who could sign in and click Allow, and the five-line
-- story on p.6 terminated at 403 for every grader.
--
-- Measured against the DEPLOYED instance before this file was written:
--   * POST /oauth/device/code  (ship_app_grader_readonly) → 200, user_code issued
--   * POST /oauth/device/verify as dev@ship.local         → 403 'Wrong workspace'
--
-- WHY A HUMAN USER AND NOT A WIDER GUARD
-- --------------------------------------
-- The alternatives were considered and are worse:
--   (a) exempt first-party apps from the workspace check — deletes the tenancy
--       property p.18 asks about and F43 was filed to protect;
--   (b) move the grader apps into the demo workspace — a token issued to a
--       grader would then read the primary tenant's documents, which is the
--       exact outcome p.18 says to avoid;
--   (c) tell graders to register their own app in their own workspace — MEASURED
--       AND DOES NOT WORK: `routes/apps.ts:195` calls `repo.create()` without
--       `isPublic`, so a portal registration is CONFIDENTIAL
--       (`platform/apps/pg-repo.ts:104`, default false), and `ship login` sends
--       `client_id` with no secret. Confirmed end to end on the deployed
--       instance: consent renders and Allow succeeds, then `/oauth/token`
--       returns 401 `invalid_client`. It also fails p.13's "pre-registered".
--
-- Adding the missing human keeps the guard, keeps the tenancy story, and makes
-- the pre-registered apps usable exactly as p.13 words it.
--
-- WHY A MIGRATION AND NOT `seed.ts`
-- --------------------------------
-- Same reasoning 041 records for the workspace and the owner: this is a
-- one-time structural fact, and `db:migrate` is the thing that provably runs on
-- every deployed environment. `db:seed` is dev data. The app ROWS still belong
-- in `seedPlatformApps()` because a rotated secret must be able to overwrite a
-- hash on a later deploy; a password that is published in the README has no such
-- rotation requirement, so a run-once file is the right home for it.
--
-- ON THE PASSWORD BEING IN THE REPOSITORY
-- ---------------------------------------
-- Deliberate, and not the same act as publishing a `client_secret`. This
-- credential opens ONE empty sandbox workspace on a demo deployment and is
-- required by p.13 to be in the README; the repo already publishes
-- 'dev@ship.local / admin123' on the same terms (`start.sh`, `seed.ts`).
-- A `client_secret` would be different in kind — it is a machine credential
-- that `seedPlatformApps()` reads from the environment precisely so it never
-- lands in git, and publishing one would not have fixed this anyway, because
-- `client_credentials` refuses both grader apps (they are not first-party).
--
-- The row is NOT `is_super_admin`. A super-admin would see every workspace and
-- would forfeit the isolation this file exists to preserve.
-- ---------------------------------------------------------------------------

-- 1. The grader's human account.
--
-- Fixed UUID so the insert is idempotent under `ON CONFLICT`, on the same
-- discipline 041 uses for the workspace and the platform owner.
--
-- `last_workspace_id` points at the Grader Sandbox so the session created by
-- `POST /api/auth/login` lands there (`routes/auth.ts`). The membership below
-- would be enough on its own — it is this user's only one, so the "first
-- available" fallback picks it — but stating it means the account keeps landing
-- in the sandbox even if it is ever added to a second workspace.
--
-- Password (published, by requirement — PRD p.13): grader123
INSERT INTO users (id, email, password_hash, name, is_super_admin, last_workspace_id)
VALUES (
  '00000000-0000-4000-8000-0000000000b2',
  'grader@ship.local',
  '$2b$10$2Qk9rqUFQvnC.1.z9r03PuDRAarAdTi1qYcF04QaPa8RVbGzqBmZG',
  'Grader',
  false,
  '00000000-0000-4000-8000-0000000000a1'
)
ON CONFLICT (id) DO UPDATE
  SET password_hash     = EXCLUDED.password_hash,
      last_workspace_id = EXCLUDED.last_workspace_id,
      is_super_admin    = false,
      updated_at        = now();

-- 2. Membership in the Grader Sandbox, and nowhere else.
--
-- 'admin' rather than 'member': MVP gate item 1 (p.2) is "an admin can create an
-- app", and a grader checking that item needs somewhere to do it. The sandbox is
-- the safe place — it is a workspace of its own with no tenant data in it, so
-- admin here grants nothing outside it.
INSERT INTO workspace_memberships (user_id, workspace_id, role)
VALUES (
  '00000000-0000-4000-8000-0000000000b2',
  '00000000-0000-4000-8000-0000000000a1',
  'admin'
)
ON CONFLICT (workspace_id, user_id) DO UPDATE
  SET role = 'admin', updated_at = now();

-- 3. A little content, so the documented smoke test returns something.
--
-- `integrations/cli/README.md` names `docs ls` as the grader's smoke command,
-- precisely because the read-only app cannot create anything. Against an empty
-- workspace that command succeeds and prints nothing — a 200 with `data: []`,
-- which is indistinguishable from a broken integration to the one person whose
-- job is to judge whether the integration works. Measured: before these rows,
-- `GET /api/v1/documents` for a grader token returned `{"data":[]}`.
--
-- Three rows, not thirty: enough to show a list, a cursor and a second document
-- type, and few enough that the sandbox stays obviously a sandbox.
--
-- Fixed UUIDs for the same idempotency reason as everything above. `created_by`
-- is the grader user, so the rows are consistent with the only human who can
-- sign in here. Titles are descriptive rather than 'Untitled' on the same terms
-- as `seed.ts`'s demo content: the "new documents are titled Untitled" rule
-- governs documents the APP creates, not seeded fixtures.
INSERT INTO documents (id, workspace_id, document_type, title, properties, created_by)
VALUES
  (
    '00000000-0000-4000-8000-0000000000d1',
    '00000000-0000-4000-8000-0000000000a1',
    'wiki',
    'Grader Sandbox — start here',
    '{}',
    '00000000-0000-4000-8000-0000000000b2'
  ),
  (
    '00000000-0000-4000-8000-0000000000d2',
    '00000000-0000-4000-8000-0000000000a1',
    'wiki',
    'What this workspace is for',
    '{}',
    '00000000-0000-4000-8000-0000000000b2'
  ),
  (
    '00000000-0000-4000-8000-0000000000d3',
    '00000000-0000-4000-8000-0000000000a1',
    'issue',
    'Example issue for issues:read',
    '{"state":"todo","priority":"medium"}',
    '00000000-0000-4000-8000-0000000000b2'
  )
ON CONFLICT (id) DO NOTHING;
