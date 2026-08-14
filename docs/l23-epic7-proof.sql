-- ---------------------------------------------------------------------------
-- ★ EPIC 7's PROOF, as the thing you run on stage. PF-710 · D11's option (a).
-- ---------------------------------------------------------------------------
-- PRD p.13 makes the Per-Epic Write-up's evidence for Epic 7 "the agent's
-- audit-log rows showing OAuth app" authentication. This is the query that
-- produces them.
--
-- Parameterised by NOTHING except the agent's fixed `client_id` — which is a
-- constant (`api/src/db/platformApps.ts`, PF-691), not a per-environment value,
-- precisely so this file is portable to whatever instance the demo runs on.
-- Paste it, run it, read it.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS PROVES, AND — MORE IMPORTANTLY — WHAT IT DOES NOT.
-- ---------------------------------------------------------------------------
-- It proves that SOME calls went through the public API under the agent's own
-- OAuth app. It does **not** prove that EVERY action did, and no query can:
-- the rows it reads are exactly the rows a missing call would not have written.
-- A grep cannot see an absence.
--
-- That second half is `api/src/platform/api/v1/agentCitizenFitness.test.ts`
-- (PF-709), which runs the agent and asserts the table invariant for the same
-- run — the flag-on path touched no Ship table over SQL. The two are presented
-- TOGETHER for exactly that reason, and the write-up says so rather than
-- letting this query carry a claim it cannot support.
--
-- Fields are p.4's set, in p.4's order, so it reads as the audit trail rather
-- than as a bespoke report built to flatter a demo.
-- ---------------------------------------------------------------------------

\set agent_client_id 'ship_app_firstparty_fleetgraph_agent'

-- ── 1. The rows themselves. This is the one to have on screen. ──────────────
SELECT
  occurred_at,
  client_id,
  user_id,                       -- ALWAYS NULL: client credentials binds no user
  method || ' ' || route AS call,
  scope_used,                    -- NULL only on /me, which declares no scope
  status,
  latency_ms,
  request_id
FROM public_api_calls
WHERE client_id = :'agent_client_id'
ORDER BY occurred_at DESC
LIMIT 50;

-- ── 2. The one-line summary, for the slide. ─────────────────────────────────
--
-- `distinct_users` is the interesting number and it should be ZERO. A
-- client-credentials token has nobody behind it, so a non-zero count here would
-- mean some other grant is minting tokens for this app — which is the thing
-- PF-688's first-party-only rule exists to prevent.
SELECT
  count(*)                                    AS calls,
  count(*) FILTER (WHERE status >= 400)       AS failures,
  count(DISTINCT route)                       AS distinct_routes,
  count(DISTINCT user_id)                     AS distinct_users,
  count(DISTINCT scope_used)                  AS distinct_scopes,
  min(occurred_at)                            AS first_call,
  max(occurred_at)                            AS last_call,
  round(avg(latency_ms)::numeric, 1)          AS avg_latency_ms
FROM public_api_calls
WHERE client_id = :'agent_client_id';

-- ── 3. Which scopes the agent actually exercised. ───────────────────────────
--
-- p.17 asks "which scopes does the agent request, and what is your defence for
-- each?" This is the empirical half of the answer: a scope that appears in the
-- registration and never here is a scope the agent does not need.
SELECT
  coalesce(scope_used, '(no scope required — /me)') AS scope_used,
  count(*)  AS calls,
  array_agg(DISTINCT route ORDER BY route) AS routes
FROM public_api_calls
WHERE client_id = :'agent_client_id'
GROUP BY 1
ORDER BY calls DESC;

-- ── 4. The counter-check: is anyone ELSE using the agent's app? ─────────────
--
-- Should return zero rows. L99's B11 records that portal traffic cannot be
-- separated from a developer's own because both run under one app; the agent
-- does not have that problem because it has its own. The one way it breaks is
-- credential sharing — a developer running the agent locally against the
-- deployed secret. If this ever returns rows, the fix is a separate
-- dev-environment app, NOT a softer claim in the write-up.
SELECT DISTINCT user_id
FROM public_api_calls
WHERE client_id = :'agent_client_id'
  AND user_id IS NOT NULL;
