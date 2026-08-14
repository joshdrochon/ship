-- L12 PF-341 / decision D10 — the per-day-per-app rollup, retained INDEFINITELY.
--
-- Migration 058, from L12's reserved block 057–059.
--
-- D10 is "30 days of raw rows plus an indefinite per-day-per-app rollup", and
-- this table is the second half. The reason it exists is Epic 7: p.13 grades
-- "the agent's audit-log rows showing OAuth app" authentication, and that claim
-- has to stay provable after the raw rows expire. A retention policy that
-- deletes the evidence for the thing the project is graded on is the wrong
-- policy however cheap it is.
--
-- ── WHAT IS LOST AT 30 DAYS, STATED ─────────────────────────────────────────
-- The rollup keeps counts per app per day. It does NOT keep per-route or
-- per-request detail, so after 30 days you can prove "this app made 412 calls on
-- 2026-08-12, 9 of which were 4xx" and you cannot answer "which document did it
-- read". That is the deliberate trade: the first question is the one Epic 7 and
-- the portal's usage view ask, and the second is a debugging question whose
-- useful life is days, not months.
--
-- ── SIZE ────────────────────────────────────────────────────────────────────
-- One row per app per day. At 50 registered apps that is ~18 000 rows a year —
-- under 4 MB with indexes. "Indefinite" costs essentially nothing, which is why
-- it can be indefinite.

CREATE TABLE IF NOT EXISTS public_api_call_daily (
  -- NULL groups every unauthenticated call for that day together. Kept rather
  -- than dropped: "how many anonymous calls hit the public API yesterday" is a
  -- real operational question, and it is the denominator for the 401 rate.
  client_id      text,
  day            date        NOT NULL,

  calls          bigint      NOT NULL,
  -- Split out rather than derived later, because the raw rows they are derived
  -- FROM are the thing being deleted.
  client_errors  bigint      NOT NULL,  -- 4xx, excluding 429
  throttled      bigint      NOT NULL,  -- 429 specifically; the rate-limit signal
  server_errors  bigint      NOT NULL,  -- 5xx
  total_latency_ms double precision NOT NULL,

  rolled_up_at   timestamptz NOT NULL DEFAULT now(),

  -- `coalesce` in the constraint, because NULL never equals NULL and a plain
  -- PRIMARY KEY (client_id, day) would let the anonymous bucket be inserted
  -- twice for the same day.
  UNIQUE (client_id, day)
);

CREATE INDEX IF NOT EXISTS idx_public_api_call_daily_day
  ON public_api_call_daily (day DESC);

COMMENT ON TABLE public_api_call_daily IS
  'L12 decision D10 — per-day-per-app rollup of public_api_calls, retained '
  'indefinitely so Epic 7 stays provable after raw rows expire at 30 days. '
  'Per-route and per-request detail is deliberately NOT carried here.';
