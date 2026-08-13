-- L12 PF-339 — the public API audit trail.
--
-- Migration number 057, taken from L12's reserved block 057–059
-- (api/src/db/migrations/RESERVATIONS.md). The `audit.ts` sketch guessed 039;
-- that number belongs to L02's `oauth_apps` and is already applied.
--
-- ── WHY NOT `audit_logs` ────────────────────────────────────────────────────
-- `schema.sql` already has an `audit_logs` table: workspace / actor / action /
-- resource, the internal application's compliance log, with AU-9 triggers that
-- forbid DELETE. Same word, completely different contract. Sharing it would put
-- public-API rows under an internal schema and re-cross the p.12 boundary this
-- lane exists on the public side of — and it would make the retention policy
-- L12 owns (D10: 30 days) silently apply to compliance rows that must not be
-- pruned.
--
-- ── NO FOREIGN KEYS, AND THAT IS DELIBERATE ─────────────────────────────────
-- `client_id` is not FK'd to `oauth_apps` and `user_id` is not FK'd to `users`.
-- An audit trail has to outlive the things it describes: the question "what did
-- this app do before it was deleted?" is one of the main reasons to keep one,
-- and an ON DELETE RESTRICT would make deleting an app impossible while an ON
-- DELETE CASCADE would erase exactly the evidence. Nulling on delete is no
-- better — it would rewrite history.
--
-- ── UNITS ───────────────────────────────────────────────────────────────────
-- `latency_ms` is `double precision`, not an integer. Sub-millisecond public
-- calls are normal (a 401 never touches the database), and rounding them to 0
-- would make a P95 computed from this table meaningless at the fast end.

CREATE TABLE IF NOT EXISTS public_api_calls (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- L07's request id, CONSUMED. This table never mints one; PF-330 greps the
  -- module to keep that true. Not unique: a retry from a client is a new
  -- request with a new id, but a middleware bug that wrote twice would show up
  -- as a duplicate here rather than being silently rejected.
  request_id     uuid        NOT NULL,

  -- NULL means the request never authenticated (401, or a route above bearer
  -- auth). It never means "unknown".
  client_id      text,
  -- NULL means unauthenticated OR machine-to-machine (client_credentials).
  user_id        uuid,

  method         text        NOT NULL,
  -- The route TEMPLATE, /api/v1-prefixed — `/api/v1/documents/:id`, never a
  -- concrete uuid (PF-331). Bounded cardinality is what makes this groupable.
  route          text        NOT NULL,
  -- NULL means NO SCOPE WAS CHECKED. Never "the check passed".
  scope_used     text,

  status         integer     NOT NULL,
  latency_ms     double precision NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);

-- PF-343 — the portal's query is "this app's calls, newest first", and it walks
-- them with a keyset cursor on `(occurred_at, id)`. DESC on both columns so the
-- index order matches the walk order exactly; a mismatch turns the range scan
-- into a sort of the whole partition.
--
-- `id` is in the index rather than left to a heap lookup because it is the
-- cursor's tie-breaker: without it, two rows sharing a microsecond are ordered
-- arbitrarily and a page boundary that lands between them either repeats a row
-- or skips one.
CREATE INDEX IF NOT EXISTS idx_public_api_calls_client_occurred
  ON public_api_calls (client_id, occurred_at DESC, id DESC);

-- PF-339 — support-conversation lookup: "here is my request id, what happened?"
CREATE INDEX IF NOT EXISTS idx_public_api_calls_request_id
  ON public_api_calls (request_id);

-- D10's pruner deletes by age across ALL apps, so it needs an index that does
-- not lead with `client_id`. Without this, a nightly prune is a seq scan of the
-- whole table — which at p.9's 100 000-user tier is 20 million rows a day.
CREATE INDEX IF NOT EXISTS idx_public_api_calls_occurred_at
  ON public_api_calls (occurred_at);

COMMENT ON TABLE public_api_calls IS
  'L12 — one row per /api/v1 call (PRD p.4). Public surface only: the internal '
  '/api routes write nothing here, which is what keeps MVP-9''s per-route '
  'query-count budget true. Raw rows are retained 30 days (D10); the '
  'indefinite per-day-per-app rollup is public_api_call_daily.';
