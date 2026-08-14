/**
 * Credential generation, hashing and verification for `oauth_apps`.
 * PF-032, PF-033, PF-034, PF-035, PF-036 (lane L02, slice S1).
 *
 * ---------------------------------------------------------------------------
 * D1 — client_secret is SHA-256, UNSALTED. Closed 2026-08-12.
 * ---------------------------------------------------------------------------
 * PRD p.15 asks where client_secret values live at rest, "hashed with what
 * algorithm, salted how, recoverable via what". The answers:
 *
 *   algorithm    SHA-256, hex.
 *   salted       Not salted, deliberately.
 *   recoverable  Never. There is no code path that returns a stored secret.
 *
 * The no-salt answer is the one that owes an argument, so here it is. A salt
 * defends against *precomputation* — rainbow tables and cross-account hash
 * reuse — and precomputation is only a threat when the input space is small
 * enough to enumerate, which is the case for human-chosen passwords and is not
 * the case here. `generateClientSecret()` below draws 32 bytes from
 * `crypto.randomBytes`, a CSPRNG: 2^256 uniformly distributed possibilities.
 * There is no table to precompute and no dictionary to run. A per-row salt
 * would add a column and change nothing an attacker can do.
 *
 * The same entropy argument is why this is a fast hash rather than bcrypt or
 * argon2. Slow KDFs buy *iteration cost* against a brute-force search, which is
 * only worth paying for when the search is feasible. Against 256 bits it is
 * not, and the cost would land on the hot path — `/oauth/token` verifies a
 * client secret on every client-credentials exchange.
 *
 * This matches the existing `api_tokens` precedent (`api/src/middleware/auth.ts`
 * `hashToken`, and `api/src/db/seedAgentToken.ts` `hashApiToken`), but it
 * matches it BY CONVENTION, NOT BY IMPORT. L01's PF-010 fences `platform/**`
 * off from `api/src/middleware/**`; the duplication below is deliberate and
 * this paragraph is the record of that. An auditor who "fixes" it by importing
 * the middleware helper undoes the boundary rule L01 exists to establish.
 *
 * ---------------------------------------------------------------------------
 * No recovery process, by design.
 * ---------------------------------------------------------------------------
 * p.2: the raw secret is shown "once on creation and rotation; never
 * recoverable thereafter". A lost secret is rotated (PF-047), never retrieved.
 * `secret_prefix` (PF-035) exists so an operator can still *name* a secret
 * without holding one.
 */
import crypto from 'crypto';

/**
 * Tag on the public identifier. Not a secret — see PF-032 below.
 * Mirrors the repo's existing `ship_`-tagged `api_tokens` format so a developer
 * reading a log can tell at a glance which kind of credential they are holding.
 */
export const CLIENT_ID_TAG = 'ship_app_';

/** Tag on the secret. A distinct tag from CLIENT_ID_TAG on purpose: it is what
 *  makes a leaked secret greppable in a log dump or a public repository scan. */
export const CLIENT_SECRET_TAG = 'ship_secret_';

/**
 * Bytes of CSPRNG output behind a client_id. PF-032 requires >= 128 bits.
 * 16 bytes = 128 bits: enough that guessing a valid client_id is infeasible,
 * which matters not for secrecy but because PF-043 makes "does this id exist"
 * a question the API deliberately refuses to answer.
 */
const CLIENT_ID_ENTROPY_BYTES = 16;

/**
 * Bytes of CSPRNG output behind a client_secret. PF-033 requires exactly 32.
 * THIS CONSTANT IS THE ENTIRE LOAD-BEARING ELEMENT OF D1's no-salt defense
 * (see the header). Lowering it does not merely weaken the secret — it
 * invalidates the argument for storing it unsalted at all. If this number ever
 * needs to change, the D1 write-up in `docs/architecture.md` changes with it.
 */
const CLIENT_SECRET_ENTROPY_BYTES = 32;

/**
 * Characters of the secret kept in clear for identification (PF-035).
 *
 * 8, copying `api_tokens.token_prefix` ("First 8 chars for identification",
 * `api/src/db/schema.sql:254`). Measured inconsistency in the precedent, noted
 * so this file does not inherit it: `api/src/routes/api-tokens.ts` stores 12
 * characters while `api/src/db/seedAgentToken.ts` stores 8 and the schema
 * comment says 8. We take 8, and we take it from the random portion *after*
 * the tag — storing `ship_secr` would identify nothing.
 *
 * Disclosure budget: 8 base64url characters is 48 bits of a 256-bit value,
 * leaving 208 bits unknown. That is not a meaningful reduction in search space.
 */
const SECRET_PREFIX_LENGTH = 8;

/**
 * PF-032 — the public client identifier.
 *
 * `client_id` is NOT a secret and nothing in this codebase may treat it as one.
 * It is returned in full by every read response (PF-044), it is the audit
 * trail's join key (L12 PF-326), and it goes in the README for graders
 * (L21 PF-631). A developer has to be able to copy it out of a UI. A test that
 * asserts it is redacted somewhere is the failure mode, not the protection.
 */
export function generateClientId(): string {
  return CLIENT_ID_TAG + crypto.randomBytes(CLIENT_ID_ENTROPY_BYTES).toString('base64url');
}

/**
 * PF-033 — the raw client secret. Returned to the caller exactly once, by
 * `POST /api/apps` (PF-040) and `POST /api/apps/:id/rotate-secret` (PF-047),
 * and never persisted in this form.
 */
export function generateClientSecret(): string {
  return (
    CLIENT_SECRET_TAG + crypto.randomBytes(CLIENT_SECRET_ENTROPY_BYTES).toString('base64url')
  );
}

/**
 * PF-034 — THE ONLY hashing site for client secrets in this repository.
 *
 * PF-034's fitness test asserts there is exactly one definition of this
 * function and no second `createHash('sha256')` call anywhere under
 * `platform/apps/`. One site means one place to audit and one place to change.
 */
export function hashClientSecret(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * PF-035 — the clear-text identifier for a secret.
 *
 * Takes the first 8 characters of the random portion, after the tag. Callers
 * pass the raw secret; this never sees a stored value because there is nothing
 * stored to see.
 */
export function secretPrefix(rawSecret: string): string {
  const body = rawSecret.startsWith(CLIENT_SECRET_TAG)
    ? rawSecret.slice(CLIENT_SECRET_TAG.length)
    : rawSecret;
  return body.slice(0, SECRET_PREFIX_LENGTH);
}

/**
 * PF-036 — constant-time comparison, and THE ONLY comparison site.
 *
 * `crypto.timingSafeEqual`, never `===`. A `===` on hex digests short-circuits
 * at the first differing character, which leaks digest bytes to an attacker who
 * can time the endpoint — a slow leak, but a real one, and the whole class of
 * bug disappears for the cost of one function.
 *
 * `timingSafeEqual` throws on length mismatch (which would itself be a timing
 * signal), so lengths are checked first and a mismatch is a plain `false`. Both
 * inputs here are SHA-256 hex digests produced by `hashClientSecret`, so a
 * length mismatch means malformed stored data, not an attack.
 */
export function digestsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * A digest to compare against when no app was found.
 *
 * PF-036 requires that an unknown `client_id` and a known one with a wrong
 * secret be indistinguishable to the caller. Returning early on "no such app"
 * would make them distinguishable by *timing* even when the response bodies
 * match, because the hash-and-compare work would be skipped. So the verifier
 * hashes the presented secret and compares it against this constant instead,
 * doing the same work on the same code path.
 *
 * The value is the SHA-256 of a random string generated once at module load: it
 * cannot collide with a real secret's digest, and it is not a constant an
 * attacker could recognise in a memory dump.
 */
const ABSENT_APP_DIGEST = hashClientSecret(
  crypto.randomBytes(CLIENT_SECRET_ENTROPY_BYTES).toString('base64url')
);

export { ABSENT_APP_DIGEST };
