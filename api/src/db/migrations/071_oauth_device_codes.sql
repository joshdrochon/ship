-- 071_oauth_device_codes.sql
-- Lane L05, PF-121. One row per pending device authorization (RFC 8628 §3.1).
--
-- ── Numbering ────────────────────────────────────────────────────────────────
-- L05 had no reserved block in `RESERVATIONS.md`. Taken from the unallocated
-- 071–073 range under that file's Rule 3, and the row is recorded there rather
-- than taken silently. 071 lands after L02's 039 (`oauth_apps`, the FK target),
-- which is the apply order the FK needs.
--
-- ── THE DELIBERATE ASYMMETRY: `user_code` IN CLEAR, `device_code` HASHED ──────
-- A reviewer who sees one credential hashed and its neighbour not will read it
-- as an oversight, so it is written down here rather than left to be inferred.
--
--   `device_code`  is a bearer credential. The client presents it to
--                  /oauth/token and redeems it for a token pair, so a database
--                  read must not yield one. Stored as sha256 only (PF-124),
--                  the same discipline `oauth_tokens` applies to access tokens,
--                  `oauth_authorization_codes` applies to codes, and D1 applies
--                  to `client_secret`.
--
--   `user_code`    is a short, low-entropy value a human reads off a terminal
--                  and types into a form. It MUST be looked up by equality on
--                  the value the user typed, so it is stored in clear. Its
--                  defense is not secrecy — it is PF-123's entropy (~38.5 bits;
--                  see `deviceCodes.ts`) multiplied by PF-132's guess throttle
--                  and PF-127's 600-second expiry. RFC 8628 §5.1 makes exactly
--                  that product the requirement, and stating one half without
--                  the other is how this gets shipped weak.
--
-- ── ON DELETE RESTRICT on app_id ─────────────────────────────────────────────
-- Same reasoning migrations 039, 043 and 065 give: D2 says an app is
-- deactivated, never deleted, so a device authorization whose app vanished is a
-- state the model does not have. RESTRICT makes the database say so instead of
-- silently orphaning grants.
--
-- ── WHY user_id AND workspace_id ARE NULLABLE HERE ───────────────────────────
-- Unlike `oauth_authorization_codes`, where both are NOT NULL. A device code is
-- created BEFORE any human is involved — that is the entire point of the grant:
-- the device has no browser and no user at the keyboard when it asks for the
-- code. Both columns are stamped at approval (PF-130) from the verifying user's
-- session. The CHECK below is what stops an `approved` row from existing
-- without them, so the nullability buys the pending state without weakening the
-- approved one.

CREATE TABLE IF NOT EXISTS oauth_device_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Unsalted SHA-256 (hex) of the raw device code. See the header. 32 bytes of
  -- CSPRNG output has nothing for a salt to defend against.
  device_code_hash TEXT NOT NULL,

  -- IN CLEAR, on purpose. See the header.
  user_code TEXT NOT NULL,

  app_id UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE RESTRICT,

  -- The scopes the client requested and the app registered, validated at
  -- issuance (PF-126). Replaced at approval with the RESOLVED grant
  -- (`resolveGrantedScopes`, PF-074) — never the raw `scope` parameter, and
  -- never `oauth_apps.requested_scopes`, which is a ceiling and not a grant.
  scopes TEXT[] NOT NULL,

  status TEXT NOT NULL DEFAULT 'pending',

  -- NULL until approval. See the header.
  user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- RFC 8628 §3.5's polling interval, ON THE ROW rather than in a module-level
  -- map (PF-137). Two consequences, both asserted: two concurrent device flows
  -- throttle independently, and a backoff a client has already earned survives a
  -- process restart — so a crash-loop is not a way to reset the throttle.
  interval_seconds INT NOT NULL,

  -- Stamped on EVERY poll, legal or not (PF-136). NULL means never polled.
  last_polled_at TIMESTAMPTZ,

  expires_at TIMESTAMPTZ NOT NULL,

  -- Set on the first legal poll after approval, in the same transaction that
  -- issues the token pair and under a row lock (PF-140), so two simultaneous
  -- polls yield exactly one pair. NULL means unredeemed.
  --
  -- Consumed rows are NOT deleted at redemption: a further poll has to be
  -- distinguishable from an unknown device code so the client gets
  -- `invalid_grant` rather than a second token pair (PF-133). The sweeper
  -- (PF-144) removes them after a retention window instead.
  consumed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A device code is looked up by hash on exactly one path, and a duplicate hash
  -- would mean a CSPRNG failure. UNIQUE makes that loud instead of ambiguous.
  CONSTRAINT oauth_device_codes_device_code_hash_key UNIQUE (device_code_hash),

  -- The constraint PF-123's collision assertion actually rides on. The generator
  -- retries on conflict (bounded), and this is what makes a conflict detectable
  -- rather than a silently shared code — two live rows with one `user_code`
  -- would let one user's approval authorize another user's device.
  CONSTRAINT oauth_device_codes_user_code_key UNIQUE (user_code),

  -- Three states, enforced by the database and not only by the handler. A fourth
  -- status is rejected here so that no seed, no future grant type and no
  -- migration can introduce one behind the endpoint's back.
  CONSTRAINT oauth_device_codes_status
    CHECK (status IN ('pending', 'approved', 'denied')),

  -- An approved row without a user is not a grant — there would be nobody for
  -- the token to belong to, and `issueTokenPair` would stamp a NULL `user_id`,
  -- silently producing a machine-to-machine token out of an interactive flow.
  -- The database refuses rather than trusting PF-130 to always set both.
  CONSTRAINT oauth_device_codes_approved_has_user
    CHECK (
      status <> 'approved'
      OR (user_id IS NOT NULL AND workspace_id IS NOT NULL)
    )
);

-- The sweeper's index (PF-144). It scans by expiry, and without this it scans
-- the table.
CREATE INDEX IF NOT EXISTS idx_oauth_device_codes_expires_at
  ON oauth_device_codes (expires_at);

COMMENT ON TABLE oauth_device_codes IS
  'RFC 8628 device authorization grants. device_code stored hashed, user_code in clear for human entry. 600s TTL. Lane L05 PF-121.';
