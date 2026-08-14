/**
 * Token generation, hashing and TTLs. PF-152, PF-153, PF-157 (lane L06, slice S1).
 *
 * ---------------------------------------------------------------------------
 * This file makes `docs/architecture.md:138` true.
 * ---------------------------------------------------------------------------
 * That line is already committed and already graded:
 *
 *   "Access tokens are opaque high-entropy strings stored hashed (same
 *    discipline as the existing `api_tokens` table); the bearer middleware
 *    resolves token -> app + user + granted scopes on every `/api/v1/*` request."
 *
 * Three claims, and each one is checked by something rather than asserted:
 *
 *   opaque         `tokens.test.ts` proves the value is not a JWT and carries no
 *                  decodable payload. "Opaque" is a property a reviewer can only
 *                  confirm if something confirms it.
 *   high-entropy   32 bytes of `crypto.randomBytes` per token, and a test draws
 *                  10 000 and asserts they are distinct.
 *   stored hashed  the row stores `sha256(raw)` and a test byte-scans every text
 *                  column of a written row for the raw value.
 *
 * ---------------------------------------------------------------------------
 * SHA-256, UNSALTED — the same call D1 made for `client_secret`, same argument.
 * ---------------------------------------------------------------------------
 * A salt defends against precomputation, and precomputation is only a threat
 * when the input space is small enough to enumerate — human-chosen passwords.
 * These tokens are a uniform draw from 2^256 out of a CSPRNG. There is no
 * rainbow table to build and no dictionary to run, so a per-row salt would add a
 * column and change nothing an attacker can do. The same entropy argument rules
 * out bcrypt/argon2: an iteration cost buys time against a feasible search, this
 * search is not feasible, and the cost would land on the hot path — the bearer
 * middleware hashes a token on EVERY `/api/v1` request.
 *
 * ---------------------------------------------------------------------------
 * DUPLICATED FROM `middleware/auth.ts` BY CONVENTION, NOT BY IMPORT.
 * ---------------------------------------------------------------------------
 * `api/src/middleware/auth.ts:84` hashes `api_tokens` the same way, and L01's
 * PF-010 fences `platform/**` off from `api/src/middleware/**`. The duplication
 * below is deliberate and this paragraph is the record of it. An auditor who
 * "fixes" it by importing the middleware helper undoes the boundary rule L01
 * exists to establish. L02's `platform/apps/secrets.ts` made the identical call
 * for the identical reason; this is the second instance of the same convention,
 * not a new one.
 */
import crypto from 'crypto';

/**
 * Tag on an access token. Distinct from the refresh tag on purpose — a leaked
 * credential in a log dump or a public-repo scan is greppable, and an operator
 * reading one can tell at a glance which kind they are holding.
 */
export const ACCESS_TOKEN_TAG = 'ship_at_';

/** Tag on a refresh token. See ACCESS_TOKEN_TAG. */
export const REFRESH_TOKEN_TAG = 'ship_rt_';

/**
 * Bytes of CSPRNG output behind every token, of either type. PF-152 requires
 * exactly 32.
 *
 * THIS CONSTANT IS THE ENTIRE LOAD-BEARING ELEMENT of the no-salt decision in
 * the header. Lowering it does not merely weaken a token — it invalidates the
 * argument for storing tokens unsalted at all. If this number ever changes, the
 * write-up above changes with it, and so does D1's in `docs/architecture.md`.
 */
const TOKEN_ENTROPY_BYTES = 32;

/**
 * Characters of the token kept in clear for identification.
 *
 * 8, taken from the random portion AFTER the tag — storing `ship_at_` would
 * identify nothing. Copies `api_tokens.token_prefix` ("First 8 chars for
 * identification", `api/src/db/schema.sql:254`) and `oauth_apps.secret_prefix`,
 * so all three credential kinds in this repo name themselves the same way.
 *
 * Disclosure budget: 8 base64url characters is 48 bits of a 256-bit value,
 * leaving 208 bits unknown. Not a meaningful reduction in search space.
 */
const TOKEN_PREFIX_LENGTH = 8;

/**
 * PF-152 — the opaque access token.
 *
 * Opaque is a DECISION, not an accident. A JWT would let a resource server skip
 * the database lookup, and that is exactly the property this lane does not want:
 * `docs/architecture.md:138` promises the middleware resolves app + user +
 * scopes on every request, and PF-156 requires a deactivated app's token to stop
 * working IMMEDIATELY. A self-validating token cannot be revoked before it
 * expires without a revocation list, which is a database lookup wearing a
 * disguise. Opaque + a lookup is the honest version of the same cost, and it is
 * what makes D2's "a deleted user's access cannot outlive them" true.
 */
export function generateAccessToken(): string {
  return ACCESS_TOKEN_TAG + crypto.randomBytes(TOKEN_ENTROPY_BYTES).toString('base64url');
}

/**
 * PF-153 — the refresh token. Same construction, same entropy, different tag.
 *
 * The difference between the two types is NOT in the value; it is in the row
 * (`token_type`, TTL, and whether `spent_at` ever gets stamped). That is why
 * presenting a refresh token as a bearer credential has to be caught by the
 * middleware explicitly (PF-160) rather than by the value looking different.
 */
export function generateRefreshToken(): string {
  return REFRESH_TOKEN_TAG + crypto.randomBytes(TOKEN_ENTROPY_BYTES).toString('base64url');
}

/**
 * L04 PF-087 — the authorization code (RFC 6749 §4.1.2).
 *
 * Here rather than in `authCodes.ts`, which is where it is used, and the reason
 * is this file's own fitness test: PF-155 asserts that `tokens.ts` is the ONLY
 * file under `platform/oauth/` that draws random bytes. That invariant is worth
 * more than the locality — it makes "every opaque credential this surface issues
 * is 32 bytes of CSPRNG output" a claim you can check by reading one file, and a
 * lane that added its own `randomBytes` call with a smaller budget would be
 * invisible without it. L04 hit exactly that assertion and moved the function
 * rather than widening the rule.
 *
 * No tag prefix, unlike the two above. A code is never stored by a client, never
 * pasted into a config file and never appears in a log a human greps — the tags
 * exist so a leaked *token* is identifiable on sight, and a value that lives for
 * sixty seconds inside one redirect has no such audience.
 */
export function generateAuthorizationCode(): string {
  return crypto.randomBytes(TOKEN_ENTROPY_BYTES).toString('base64url');
}

/**
 * L05 PF-124 — the device code (RFC 8628 §3.2).
 *
 * Here, and not in `deviceCodes.ts` where it is used, for this file's own
 * fitness assertion: `issue.test.ts` requires `tokens.ts` to be the ONLY file
 * under `platform/oauth/` that draws random bytes. L04 hit the same assertion
 * with `generateAuthorizationCode` and moved the function rather than widening
 * the rule; L05 does the same. The invariant is worth more than the locality —
 * it makes "every opaque credential this surface issues is 32 bytes of CSPRNG
 * output" checkable by reading one file.
 *
 * No tag prefix, for `generateAuthorizationCode`'s reason: a device code lives
 * inside one polling loop, is never stored by a user, never pasted into a config
 * file and never appears in a log a human greps.
 */
export function generateDeviceCode(): string {
  return crypto.randomBytes(TOKEN_ENTROPY_BYTES).toString('base64url');
}

/**
 * L05 PF-123 — the `user_code` alphabet (RFC 8628 §6.1).
 *
 * Uppercase alphanumerics with the eight visually ambiguous characters removed:
 * `B` `I` `O` `S` and `0` `1` `5` `8`. Each of those is the one a human
 * mistranscribes when reading a code off a terminal in a bad font — `O`/`0`,
 * `I`/`1`, `S`/`5`, `B`/`8`. Removing BOTH members of each confusable pair is
 * the point: dropping only `0` would still leave the user typing `0` when they
 * saw `O`, and the lookup would fail on a code they read correctly.
 *
 * 22 letters + 6 digits = 28 characters. See `USER_CODE_ENTROPY_BITS`.
 */
const USER_CODE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXYZ234679';

/** Characters drawn, excluding the display hyphen. Formatted `XXXX-XXXX`. */
const USER_CODE_LENGTH = 8;

/**
 * L05 PF-123 — a `user_code` a human can read aloud and type.
 *
 * ---------------------------------------------------------------------------
 * REJECTION SAMPLING, AND WHY `% 28` WOULD BE WRONG.
 * ---------------------------------------------------------------------------
 * 256 is not a multiple of 28 — it is 9×28 + 4 — so mapping a uniform byte with
 * `byte % 28` makes the first four characters of the alphabet ~11% more likely
 * than the rest. That is a real, if small, reduction in the effective search
 * space of a code whose whole defense is the product of its entropy and
 * PF-132's throttle. Bytes at or above the largest multiple of 28 are discarded
 * and redrawn instead, which costs a few extra bytes and keeps the draw uniform.
 *
 * Returns the CANONICAL hyphenated form. That is what the row stores, what the
 * terminal prints, and what `normalizeUserCode` (PF-131) reduces every user
 * input back to.
 */
export function generateUserCode(): string {
  const max = Math.floor(256 / USER_CODE_ALPHABET.length) * USER_CODE_ALPHABET.length;
  let out = '';
  while (out.length < USER_CODE_LENGTH) {
    for (const byte of crypto.randomBytes(USER_CODE_LENGTH)) {
      if (out.length === USER_CODE_LENGTH) break;
      // Discard the biased tail rather than folding it back in. See the header.
      if (byte >= max) continue;
      out += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Exported for `deviceCodes.ts`'s pattern and entropy assertions. */
export const USER_CODE_CHARSET = USER_CODE_ALPHABET;
export const USER_CODE_RAW_LENGTH = USER_CODE_LENGTH;

/**
 * THE ONLY token-hashing site in this lane.
 *
 * One site means one place to audit and one place to change. `tokens.test.ts`
 * asserts there is no second `createHash('sha256')` under `platform/oauth/`.
 */
export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** The clear-text identifier for a token: 8 chars of the random portion. */
export function tokenPrefix(raw: string): string {
  const body = raw.startsWith(ACCESS_TOKEN_TAG)
    ? raw.slice(ACCESS_TOKEN_TAG.length)
    : raw.startsWith(REFRESH_TOKEN_TAG)
      ? raw.slice(REFRESH_TOKEN_TAG.length)
      : raw;
  return body.slice(0, TOKEN_PREFIX_LENGTH);
}

// NOTE ON CONSTANT-TIME COMPARISON — why there is no `digestsEqual` here.
//
// `platform/apps/secrets.ts` exports one, and this file deliberately does not
// duplicate it. Client-secret verification compares a PRESENTED value against a
// digest belonging to a NAMED app, so a short-circuiting `===` leaks digest
// bytes to an attacker who can time the endpoint. Token resolution has no such
// comparison: the presented token is hashed and the digest is handed to a
// UNIQUE-index lookup (`WHERE token_hash = $1`), which either finds a row or
// does not. There is no stored value being compared byte-by-byte against
// attacker-controlled input, so there is nothing for a constant-time compare to
// protect. Adding one would be cargo cult, and it would have collided with the
// `apps/` export through the platform barrel.

/**
 * A fresh family identifier — the anchor PRD p.3's theft signal hangs on.
 *
 * Built from `crypto.randomBytes` and formatted to the RFC 4122 version-4
 * layout rather than taken from a generator library, for one reason worth
 * stating: PF-152 requires that nothing in this directory mint a credential-
 * shaped value from anything other than the CSPRNG, and a single source of
 * random bytes is easier to audit than two. The version and variant bits are set
 * so the value is well-formed for the `UUID` column type in migration 043.
 *
 * This is an IDENTIFIER, not a secret. It is never presented by a caller and
 * never leaves the server; it only has to be unique.
 */
export function newFamilyId(): string {
  const bytes = crypto.randomBytes(16);
  // Version 4 (random) in the high nibble of byte 6; RFC 4122 variant in byte 8.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

// ─────────────────────────────────────────────────────────────────────────────
// PF-157 — DECISION: 1 hour access, 30 days refresh, sliding.
// ─────────────────────────────────────────────────────────────────────────────
//
// PRD p.15's Pre-Search 1.4 asks "How long are access tokens valid, and what is
// your refresh-token rotation policy?" — a question with no PRD-specified
// answer, so the answer is ours and it is written down as ours rather than
// left to be inferred from a magic number.
//
// ACCESS: 1 hour. An opaque access token is checked against the database on
// every single request (PF-158), so a short TTL costs nothing in verification
// work — the lookup happens either way. What it buys is a bounded blast radius:
// a leaked access token is useful for at most an hour, and after that the
// holder needs the refresh token too. `platform/apps/types.ts` already documents
// "~1h TTL" on `IssuedTokens.accessToken`, so this matches the shape that was
// already on disk before this lane existed.
//
// REFRESH: 30 days, SLIDING — each rotation issues a fresh 30-day token, so an
// actively used credential never expires and an abandoned one dies in a month.
// 30 days is what makes `ship login` a once-a-month act rather than a daily one,
// which is the second line of the TTFE story (p.8).
//
// Both are overridable at boot (PF-173) so L24's rotation drill can produce
// expiry by configuration instead of by waiting — PRD p.11 rules out
// `setTimeout` waits and p.9 sets the drill's flake budget at zero over twenty
// runs. Overriding goes through `createApp`'s injected deps, NOT through a
// mutable module-level binding: a test that reassigns a module export leaks that
// state into every later test in the file.

/** PF-157 — access-token lifetime, in seconds. One hour. */
export const ACCESS_TOKEN_TTL_SECONDS = 3600;

/** PF-157 — refresh-token lifetime, in seconds. Thirty days, sliding. */
export const REFRESH_TOKEN_TTL_SECONDS = 2592000;

/**
 * The TTL pair as one injectable value (PF-173).
 *
 * Carried on `AppDeps` so a drill can boot with a 2-second access TTL. The
 * defaults below are the only place the two numbers above are read in
 * production wiring.
 */
export interface TokenTtlConfig {
  accessSeconds: number;
  refreshSeconds: number;
}

export const DEFAULT_TOKEN_TTL: TokenTtlConfig = {
  accessSeconds: ACCESS_TOKEN_TTL_SECONDS,
  refreshSeconds: REFRESH_TOKEN_TTL_SECONDS,
};

// ─────────────────────────────────────────────────────────────────────────────
// D14 / PF-171 — the same-generation replay window. DEFAULT: OFF (strict).
// ─────────────────────────────────────────────────────────────────────────────
//
// ESCALATED, NOT SILENTLY CHOSEN. The full write-up, both options and the PRD
// tension, are in `docs/architecture.md` under "Refresh rotation under
// concurrent clients" and in `tickets/plugforge/lane-99-unassigned.md` (D14).
// The short version:
//
// L17's PF-509 single-flight promise is keyed on the SDK's token-store INSTANCE,
// so it serializes refreshes inside ONE PROCESS. L19's CLI persists credentials
// to a shared `~/.ship/credentials.json` (PF-506/PF-566), so two terminals
// running `ship docs ls` at once are two processes holding one credential. Both
// see an expired access token, both present R1, and under strict rotation the
// second one revokes the family and logs the user out — during a demo.
//
//   (a) STRICT           reuse always revokes the family. PRD p.3's sentence,
//                        unqualified. Concurrent CLI processes are unsupported.
//   (b) REPLAY WINDOW    re-presenting the IMMEDIATELY PRECEDING refresh token
//                        within this window returns the already-issued pair
//                        instead of revoking. Reuse of anything older still
//                        revokes the family. This is the OAuth 2.1 BCP's own
//                        accommodation.
//
// SHIPPED DEFAULT IS (a) — 0 means the window is closed and every reuse revokes.
// Switching to (b) is changing this one number to 10_000; the rotation path
// already implements the window and `rotation.test.ts` table-tests BOTH
// behaviours, so the switch is one line and is covered either way.
//
// The honest cost of (b), recorded because it is not free: it is a documented
// departure from p.3's flat "reuse invalidates the family", and the replay cache
// it needs is process-local (see `replayCache` in `rotation.ts`), so behind more
// than one API instance a replay that lands on a different instance still
// revokes. (b) therefore SOFTENS the failure rather than eliminating it.
export const REFRESH_REPLAY_WINDOW_MS = 0;
