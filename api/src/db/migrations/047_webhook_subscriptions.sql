-- 047 — webhook subscriptions (L15 PF-421, PF-422, PF-423, PF-426).
--
-- Number 047 comes from L15's reserved block 047–050 (RESERVATIONS.md), not
-- from "the next free number" — the highest APPLIED migration is 067 and taking
-- 068 would have collided with L10's reservation.
--
-- PRD p.3, Webhook Subscriptions: "Per-app per-event-type subscriptions. Target
-- URL, hashed signing secret, active flag. Manageable via /api/v1/webhooks
-- (gated by webhooks:manage scope)."
--
-- ─── The one deviation from p.3's literal text: "hashed signing secret" ───────
--
-- The secret is ENCRYPTED at rest, not hashed. This is deliberate, it is the
-- lane's headline decision (PF-422), and it is filed as PRD contradiction C3 in
-- tickets/plugforge/lane-99-unassigned.md.
--
-- HMAC-SHA256 is symmetric. The server must key an HMAC with this value on
-- EVERY delivery attempt — p.12's Failure Modes row asks what happens when "a
-- subscriber's signing secret is rotated mid-flight", which only means anything
-- if the server signs each attempt with the subscription's CURRENT secret. A
-- cryptographic hash is one-way, so "hashed at rest" and "sign every attempt"
-- cannot both hold. They are not in tension; they are mutually impossible.
--
-- Rejected alternative worth naming, because it is the tempting one: store
-- sha256(secret) and use THAT as the HMAC key. It satisfies the word "hashed"
-- and is security theater — whatever the server signs with IS the key, so an
-- attacker holding a database dump forges signatures either way. It also
-- silently breaks the published contract on p.7,
-- `verifyWebhook(headers, rawBody, secret)`, unless the SDK hashes internally,
-- which is a hidden step in a printed interface.
--
-- So: AES-256-GCM, key in `WEBHOOK_SECRET_KEY` in the environment and never in
-- this database. `secret_ciphertext` holds nonce ‖ ciphertext ‖ tag, base64.
-- That buys confidentiality against the realistic leak (a database dump or a
-- backup) without breaking signing, and it is what Stripe and GitHub do.
--
-- The asymmetry with `oauth_apps.client_secret_hash`, which correctly STAYS
-- hashed, is one sentence: a client secret is PRESENTED BACK TO US and can be
-- verified by comparing digests, so hashing costs nothing; a webhook secret is
-- USED BY US to produce a MAC and is never presented, so hashing costs
-- everything and buys nothing.

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The owning app. `ON DELETE CASCADE` rather than RESTRICT: a subscription
  -- has no meaning without the app whose token created it, and L16's delivery
  -- log deliberately carries no FK of its own (same reasoning as L12's audit
  -- tables) so nothing downstream is orphaned by this cascade.
  app_id UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,

  -- Denormalised from the app rather than joined, because the matcher's hot
  -- query is `WHERE workspace_id = $1 AND event_type = $2 AND active`. A token
  -- is stamped with `oauth_apps.workspace_id` at authentication (L06), so the
  -- two can never disagree — the route reads the workspace off the token and
  -- never off the request.
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- The consenting user of the token that created the subscription, or NULL for
  -- a machine-to-machine token with no user behind it.
  --
  -- NOT IN PF-421's column list, and added deliberately: decision D7 (L14,
  -- lane-99) hands this lane the private-document gate and defines it as
  -- `data.created_by === subscription.user_id`. Without this column the gate
  -- cannot be implemented at all, and D7 explicitly names it as "the one piece
  -- of D7 this lane could not enforce itself". Filed as an amendment to PF-421
  -- rather than smuggled in.
  --
  -- `ON DELETE SET NULL`: a deleted user must not take live subscriptions with
  -- them, and a NULL user_id fails the private gate closed (see the matcher).
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,

  -- NO CHECK CONSTRAINT ON `event_type`, and that is a decision (PF-421).
  -- The closed set is L14's `EVENT_TYPES` (platform/webhooks/events.ts).
  -- Restating those eight strings here would make registering a ninth event
  -- type a database migration, which is precisely the Open/Closed property
  -- PF-395 exists to prove. An unregistered type is rejected by the route
  -- through `assertEventType` (PF-429), where the error message can enumerate
  -- the valid set — a CHECK violation surfaces as a 500 that names nothing.
  event_type TEXT NOT NULL,

  target_url TEXT NOT NULL,

  -- nonce ‖ ciphertext ‖ auth tag, base64. See the header.
  secret_ciphertext TEXT NOT NULL,

  -- First 8 characters of the random portion, in clear, so the portal and L16's
  -- delivery log can say WHICH secret without holding one. Copied from
  -- `api_tokens.token_prefix` and `oauth_apps.secret_prefix`; 8 base64url
  -- characters is 48 bits of a 256-bit value.
  secret_prefix TEXT NOT NULL,

  -- Incremented by rotate. The old secret verifies nothing from the moment the
  -- row is written (PF-433) — no grace period, matching D3's decision for
  -- `client_secret` so the codebase tells one story about both.
  secret_version INTEGER NOT NULL DEFAULT 1,

  -- p.3 lists this as a first-class column. It is a MATCHER input, not a
  -- display flag (PF-426): an inactive subscription receives zero deliveries,
  -- and reactivating it does not backfill.
  active BOOLEAN NOT NULL DEFAULT true,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- DELETE deactivates rather than removing the row (PF-426), so L16's delivery
  -- log keeps a resolvable `subscription_id` after a subscriber walks away.
  deactivated_at TIMESTAMPTZ,

  -- Coherence, in the same shape as `oauth_apps_deactivation_coherent`: an
  -- active row has no deactivation timestamp and vice versa. Without it,
  -- `active = false, deactivated_at = NULL` is representable and means nothing.
  CONSTRAINT webhook_subscriptions_deactivation_coherent CHECK (
    (active = true AND deactivated_at IS NULL)
    OR (active = false AND deactivated_at IS NOT NULL)
  ),

  -- One row per (app, event type, target). A second identical triple is a
  -- duplicate subscription, and a duplicate subscription means two signed POSTs
  -- of the same event to the same URL — which the subscriber cannot tell from a
  -- retry, because the idempotency key would be identical too.
  --
  -- Deliberately NOT `UNIQUE(app_id, event_type)`: one app legitimately fans a
  -- single event type out to several targets (a staging listener and a
  -- production one), and p.3's "per-app per-event-type" names the granularity
  -- of a subscription, not a uniqueness constraint over it.
  CONSTRAINT webhook_subscriptions_unique_target
    UNIQUE (app_id, event_type, target_url)
);

-- PF-430 / PF-222. The bare `(created_at DESC, id DESC)` index is what
-- `assertKeysetIndexed` EXPLAINs — it runs a SIMPLIFIED page query with no
-- tenant equality, and for that shape this is the only usable index. Migration
-- 067 documents the same pair on `documents` and why both are load-bearing.
CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_keyset
  ON webhook_subscriptions (created_at DESC, id DESC);

-- What the LIVE list query rides. `GET /api/v1/webhooks` is scoped to the
-- calling app, so the app must lead: an index leading on `created_at` cannot
-- satisfy the `app_id` equality and the planner sorts instead (migration 067
-- caught exactly that on `documents`).
CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_app_keyset
  ON webhook_subscriptions (app_id, created_at DESC, id DESC);

-- What the MATCHER rides (PF-440): active subscriptions for one workspace and
-- one event type, on every publish. Partial on `active` because an inactive
-- subscription is never a match and there is no query that wants both.
CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_match
  ON webhook_subscriptions (workspace_id, event_type)
  WHERE active = true;
