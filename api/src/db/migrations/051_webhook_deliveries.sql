-- 051 — the delivery log (L16 PF-458, PF-460, PF-462, PF-463, PF-473, PF-475).
--
-- Number 051 comes from L16's reserved block 051–056 (RESERVATIONS.md), not
-- from "the next free number" — the highest APPLIED migration is 073 and taking
-- 074 would have reached into the unallocated range. Block order is also apply
-- order and it holds: the FK target is `webhook_subscriptions` (047, L15),
-- which is numerically earlier. Nothing here depends on 057+ or 06x.
--
-- PRD p.4, Delivery Log: "webhook_deliveries table records every attempt with
-- subscription_id, event_id, attempt_number, response_status, response_excerpt,
-- latency_ms. Queryable per app."
--
-- ─── p.4 names six columns. The PRD's own requirements need more. ────────────
--
-- Every column below that is NOT one of p.4's six is load-bearing for a
-- DIFFERENT requirement the PRD states elsewhere, named here so the additions
-- read as necessity rather than as appetite:
--
--   id                     the `:id` in `/webhooks/deliveries/:id/replay` (p.4)
--   idempotency_key        "replays carry the original idempotency key" (p.4);
--                          p.18's dedupe-visibility question
--   status                 the DLQ is a state, not a table (PF-473)
--   dlq_reason             which of the three DLQ paths (PF-474)
--   attempted_at           retention pruning (p.10's Include Assumptions)
--   event_type             `?event_type=` on PF-464 without a join, and it
--                          survives the subscription's cascade delete
--   raw_body               "/replay re-emits a logged event" (p.4) — see below
--   signature_header       finding B9: L19's `ship webhooks tail --poll` cannot
--                          say "signature verified" without the header that was
--                          actually sent
--   replay_of_delivery_id  a replay links to its ancestor (PF-477)
--   delivery_group_id      makes the per-attempt uniqueness constraint correct
--                          in the presence of replays — see the constraints
--
-- ─── raw_body: a requirement p.4's own column list makes unbuildable ─────────
--
-- p.4 enumerates six columns and none of them holds the event. p.4 ALSO
-- requires `/replay` to "re-emit a logged event". Those cannot both be
-- satisfied.
--
-- The alternative is to re-derive the envelope from `event_id` at replay time,
-- which means re-reading CURRENT document state. Two things break. A replay of
-- `document.created` for a since-renamed document would deliver a DIFFERENT
-- body under the ORIGINAL idempotency key — so a subscriber that correctly
-- deduped the first delivery would never see the change, and one that did not
-- would see two different payloads claiming to be the same event. And
-- `document.deleted` is unresolvable outright: finding F10 established that
-- `DELETE /api/documents/:id` is a HARD delete, so there is no row left to
-- derive anything from.
--
-- So the exact signed bytes are stored. The SIGNATURE is still recomputed at
-- send time with a fresh `t` (L15 PF-442), which is what makes a replay
-- verifiable rather than expired.
--
-- ─── No FK on anything but the subscription ─────────────────────────────────
--
-- Same reasoning L12's audit tables give: a log that cannot outlive the things
-- it describes is not a log. `event_id` has no FK because events are not
-- persisted anywhere — the bus is in-process and the envelope's only durable
-- form is `raw_body` in this table.
--
-- `subscription_id` DOES cascade, and that is deliberate rather than
-- inconsistent: L15's `DELETE /api/v1/webhooks/:id` deactivates rather than
-- deleting (PF-426), specifically so this table keeps a resolvable
-- `subscription_id` after a subscriber walks away. The only thing that actually
-- removes a subscription row is deleting the owning OAuth app, at which point
-- the app's delivery history has no owner and no reader — `webhook_deliveries`
-- is queryable per APP, and there is no longer an app.

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The ladder this attempt belongs to. One group = one run of up to six
  -- attempts. A replay starts a NEW group against the same (subscription,
  -- event), which is exactly why the uniqueness constraint cannot be on the
  -- triple p.4's column list suggests. See the constraints below.
  delivery_group_id UUID NOT NULL,

  subscription_id UUID NOT NULL
    REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,

  -- PF-463's "Queryable per app" (p.4), and the one column here that is a
  -- DENORMALISATION rather than a fact only this row knows.
  --
  -- It is here because the alternative does not work. The ownership path is
  -- webhook_deliveries -> webhook_subscriptions -> app_id, and a keyset page
  -- written as that join cannot ride an index: the equality is on the JOINED
  -- table, so the planner scans deliveries, joins back, and then SORTS — measured,
  -- not assumed. `EXPLAIN` on the join form produced `Seq Scan on
  -- webhook_deliveries` + `Sort` even with the (subscription_id, attempted_at
  -- DESC, id DESC) index present, because no subscription_id is known at plan
  -- time. Resolving the app's subscription ids first and using `= ANY(...)` is
  -- no better for the sort: N index ranges under one ORDER BY ... LIMIT is a
  -- MergeAppend or a bitmap scan plus a sort, not a single range walk.
  --
  -- Safe to denormalise because the value is IMMUTABLE: nothing in L15's route
  -- surface changes a subscription's app (PATCH sets `active` and nothing else),
  -- and the row is written at delivery time with the subscription in hand. It is
  -- populated by a SUBSELECT inside the INSERT rather than passed in, so a caller
  -- cannot supply an app id that disagrees with the subscription's.
  --
  -- Precedent in this schema: migration 047 denormalises `workspace_id` onto
  -- `webhook_subscriptions` for exactly this reason, and says so.
  app_id UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,

  -- No FK: events are not a table. `event_id` is L14's per-publish UUID
  -- (PF-394) and the envelope's only durable form is `raw_body` below.
  event_id UUID NOT NULL,

  -- Denormalised from the subscription so `?event_type=` is a filter rather
  -- than a join, and so the row still says what it was about after the
  -- subscription is gone.
  event_type TEXT NOT NULL,

  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),

  -- FIVE values, not the four PF-473 lists. `failed` is the state most rows of
  -- a retrying delivery are in: Testing Scenario 7's attempts 1-3 each failed,
  -- none is terminal, and none is still in flight. The DLQ is still exactly
  -- `WHERE status = 'dead_lettered'`, which is what PF-473 was protecting.
  status TEXT NOT NULL
    CHECK (status IN ('in_flight', 'delivered', 'failed', 'dead_lettered', 'cancelled')),

  -- NULLABLE, and that is the point: a timeout, a refused connection and a TLS
  -- failure all produce an attempt with no status. NULL means "no response
  -- arrived"; it is not a stand-in for zero.
  response_status INTEGER,

  -- PF-460. First 256 characters of the response BODY. The CHECK is at 280 so a
  -- code path that forgets to truncate fails at the DATABASE rather than storing
  -- a megabyte of someone's HTML error page per attempt — at 6 attempts times
  -- p.9's fanout that is the storage line item PF-483 has to size.
  --
  -- 280 rather than 256 leaves room for the truncation marker, so a truncated
  -- excerpt says so in-band instead of silently looking like a short body.
  -- '' and NULL are DIFFERENT: '' is an empty body, NULL is no response.
  response_excerpt TEXT CHECK (response_excerpt IS NULL OR char_length(response_excerpt) <= 280),

  -- PF-461. Brackets the HTTP call ONLY — not signing, not the subscription
  -- lookup, not these log writes — so the number means what a subscriber would
  -- measure. NULL until the attempt completes. p.6: "Webhook delivery latency
  -- (P95, first attempt) < 2s", and a target no query can evaluate is not a
  -- target: see `idx_webhook_deliveries_first_attempt_latency`.
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),

  -- PF-470. Written at attempt 1 and READ thereafter, never recomputed. Not a
  -- UUID column: L15's `idempotencyKeyFor` produces `<event_id>:<subscription_id>`,
  -- which is deliberately readable rather than hashed.
  idempotency_key TEXT NOT NULL,

  -- PF-474. NULL unless `status = 'dead_lettered'`; the coherence CHECK below
  -- makes the two agree.
  dlq_reason TEXT
    CHECK (dlq_reason IS NULL OR dlq_reason IN
      ('max_attempts_exhausted', 'permanent_status', 'circuit_open')),

  -- From the injected Clock, supplied by the writer — NOT `DEFAULT now()`. A
  -- server-side default would read the wall clock, which is the one thing p.11
  -- forbids on this path: `FakeClock` could advance six minutes and every row
  -- would still be stamped with the same real second, so no ladder-timing
  -- assertion over the LOG would mean anything.
  attempted_at TIMESTAMPTZ NOT NULL,

  -- PF-475. The exact bytes that were signed and POSTed. See the header.
  raw_body BYTEA NOT NULL,

  -- Finding B9. The `Ship-Signature` actually sent on THIS attempt. NULL for an
  -- attempt where nothing was sent (cancelled, or refused by the breaker).
  signature_header TEXT,

  -- PF-477. Self-referential and ON DELETE SET NULL: pruning an old original
  -- must not cascade away the replay that is the interesting row.
  replay_of_delivery_id UUID REFERENCES webhook_deliveries(id) ON DELETE SET NULL,

  -- An in-flight attempt has no outcome yet, and a terminal one has no business
  -- claiming it is still running. Without this, `status='in_flight'` with a
  -- latency and a response is representable and means nothing.
  CONSTRAINT webhook_deliveries_in_flight_has_no_outcome CHECK (
    status <> 'in_flight'
    OR (response_status IS NULL AND response_excerpt IS NULL AND latency_ms IS NULL
        AND dlq_reason IS NULL)
  ),

  -- PF-474 made structural: `dlq_reason` is set if and only if the row is in the
  -- DLQ. A reason on a delivered row, or a dead-lettered row with no reason,
  -- would each make "why is this in the DLQ" unanswerable from the row.
  CONSTRAINT webhook_deliveries_dlq_reason_coherent CHECK (
    (status = 'dead_lettered' AND dlq_reason IS NOT NULL)
    OR (status <> 'dead_lettered' AND dlq_reason IS NULL)
  ),

  -- One row per attempt of one ladder. THIS is the constraint that makes
  -- at-least-once auditable (PF-462): without it a delivery re-driven after a
  -- crash writes attempt 3 twice, and every count derived from this log —
  -- attempts-until-success, DLQ eligibility, p.6's retry success rate — is
  -- quietly wrong.
  --
  -- Keyed on the GROUP and not on (subscription_id, event_id, attempt_number),
  -- which is what PF-462 asks for literally. The literal version is wrong in the
  -- presence of replay: a replay is a new ladder starting at attempt 1 against
  -- the SAME subscription and the SAME event, so it would collide with the
  -- original's attempt 1 on its first insert. PF-462 anticipated the problem and
  -- waved at "a fresh event_id-scoped sequence"; a group id is that idea with a
  -- name. The literal triple is still enforced for original deliveries by the
  -- partial index below, where it is a true statement.
  CONSTRAINT webhook_deliveries_one_row_per_attempt UNIQUE (delivery_group_id, attempt_number)
);

-- PF-462's literal constraint, scoped to where it is true. An ORIGINAL delivery
-- has exactly one row per attempt of one event to one subscription; a replay
-- deliberately does not, and that is the whole feature.
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_deliveries_original_attempt
  ON webhook_deliveries (subscription_id, event_id, attempt_number)
  WHERE replay_of_delivery_id IS NULL;

-- PF-463. What the live per-app page rides. The equality column LEADS, then the
-- sort key, then the tie-break — migration 067 documents the same shape on
-- `documents` and what happens when the equality does not lead.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_keyset
  ON webhook_deliveries (app_id, attempted_at DESC, id DESC);

-- The DLQ view (PF-464's `?status=dead_lettered`, p.4's "visible in the
-- developer portal"). Partial, because the DLQ is a small fraction of the rows
-- and no query wants "every status".
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_dlq
  ON webhook_deliveries (app_id, attempted_at DESC, id DESC)
  WHERE status = 'dead_lettered';

-- `?subscription_id=` narrows to one subscription within one app.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_subscription
  ON webhook_deliveries (subscription_id, attempted_at DESC, id DESC);

-- PF-461. What makes p.6's "P95, first attempt" a query rather than an
-- aspiration. Partial on attempt 1 with a non-null latency — the population the
-- target is defined over.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_first_attempt_latency
  ON webhook_deliveries (attempted_at DESC)
  INCLUDE (latency_ms)
  WHERE attempt_number = 1 AND latency_ms IS NOT NULL;

-- PF-472 / PF-470. Answers "how many times did we send this key, and how did
-- those attempts end" without a scan.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_idempotency_key
  ON webhook_deliveries (idempotency_key);

-- PF-484. The boot-time re-drive asks for every ladder left mid-flight by a
-- crash. Partial, because in a healthy process this is the empty set.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_in_flight
  ON webhook_deliveries (attempted_at)
  WHERE status = 'in_flight';
