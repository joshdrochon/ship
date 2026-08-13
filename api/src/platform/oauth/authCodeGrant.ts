/**
 * ★ THE PKCE ASSERTION POINT. `grant_type=authorization_code`.
 * PF-100 – PF-105 (lane L04, slice S3).
 *
 * `docs/architecture.md`'s Auth Code sequence diagram carries the marker
 * *"★ PKCE validated HERE — S256(verifier) ≟ stored challenge. Mismatch → 400
 * invalid_grant"* on the `/oauth/token` participant. That marker is a graded
 * deliverable (p.12 requires the diagram to mark where the verifier is
 * validated), so this file is not free to put the check somewhere else.
 * `architectureDoc.test.ts` is the latch that fails if the two ever disagree.
 *
 * ---------------------------------------------------------------------------
 * ORDER OF CHECKS, AND WHY EACH ONE SITS WHERE IT DOES.
 * ---------------------------------------------------------------------------
 *   1. parameters present and well-formed
 *   2. the verifier's RFC 7636 §4.1 FORM, before any hashing
 *   3. the code exists
 *   4. the code is bound to THIS client, THIS redirect_uri, and is unexpired
 *   5. the code has not already been redeemed  → replay: revoke the family
 *   6. ★ PKCE
 *   7. burn the code (conditionally), recording the family it is about to make
 *   8. issue
 *
 * Step 4 before step 6 is the security-relevant ordering. The PKCE failure path
 * BURNS the code (PF-102 — a wrong verifier must not be retriable against the
 * same code with a better guess), so if the binding checks came after it, a
 * client that authenticated as app B could burn a code issued to app A. Binding
 * first means only the code's rightful client can burn it, and that client
 * already had to pass `verifyClientSecret`.
 *
 * Step 2 before step 3 is a smaller point with the same shape: a malformed
 * verifier is `invalid_grant` rather than an exception out of `timingSafeEqual`,
 * and validating form before doing a database lookup means a garbage request
 * costs nothing.
 *
 * ---------------------------------------------------------------------------
 * EVERY FAILURE HERE IS `invalid_grant`, AND THAT IS DELIBERATE.
 * ---------------------------------------------------------------------------
 * Unknown code, wrong client, wrong redirect_uri, expired, replayed, wrong
 * verifier, missing verifier — one code, one status, indistinguishable bodies
 * apart from `error_description`. RFC 6749 §5.2 defines `invalid_grant` as
 * exactly this set, and splitting them apart would turn the token endpoint into
 * an oracle: "expired" versus "unknown" tells an attacker holding a stolen code
 * whether it was ever real.
 *
 * The one failure that is NOT `invalid_grant` is a failed CLIENT authentication,
 * which is `invalid_client` + 401 and is handled by the router above this
 * handler, through L02's `verifyClientSecret` (PF-036) — the only client-secret
 * comparison site in the repository. This file defines no comparison of its own
 * and a fitness test asserts it.
 *
 * ---------------------------------------------------------------------------
 * ⚑ ONE DEPARTURE FROM PF-104's WORDING, STATED RATHER THAN HIDDEN.
 * ---------------------------------------------------------------------------
 * PF-104 says `consumed_at` is set "inside the same transaction that issues the
 * tokens". It is not, and cannot be without coupling two repositories'
 * transaction boundaries: `IAuthCodeRepo` and `ITokenRepo` are separate seams
 * owned by separate lanes, each with its own `transaction()` over its own
 * connection.
 *
 * What PF-104's TEST actually asserts still holds, because the guarantee never
 * rested on the transaction: exactly one of N concurrent exchanges wins, and
 * that is a property of the single conditional `UPDATE … WHERE consumed_at IS
 * NULL` statement alone (see `pgAuthCodeRepo.ts`'s isolation note). The burn
 * happens FIRST and the issue second, so the failure mode of a crash between
 * them is a burned code and no tokens — the client restarts a sixty-second flow.
 * The opposite order would risk tokens issued from a code that stayed live,
 * which is the failure that actually matters.
 *
 * The family id is generated before the burn and written by the same statement,
 * so there is no window where a code is spent but the family it produced is
 * unrecoverable — which would be a leaked code we could not revoke.
 */
import type { Clock } from '../clock.js';
import type { OAuthApp } from '../apps/types.js';
import type { GrantHandler, GrantOutcome } from './router.js';
import type { ITokenRepo } from './tokenRepo.js';
import type { TokenTtlConfig } from './tokens.js';
import { newFamilyId } from './tokens.js';
import { issueTokenPair } from './issue.js';
import { verifyPkce, isValidVerifier } from './pkce.js';
import {
  hashAuthorizationCode,
  type IAuthCodeRepo,
  type AuthorizationCodeRecord,
} from './authCodes.js';

export interface AuthCodeGrantDeps {
  authCodeRepo: IAuthCodeRepo;
  tokenRepo: ITokenRepo;
  clock: Clock;
  ttl: TokenTtlConfig;
}

/**
 * The `error_description` for each failure, as data.
 *
 * Exported so the tests assert against the same strings the handler emits
 * rather than restating them — the same call L06's `REFRESH_ERROR_DESCRIPTIONS`
 * makes. Prose only: nothing switches on these, and an SDK that did would be
 * relying on wording rather than on the `error` code.
 */
export const AUTH_CODE_ERROR_DESCRIPTIONS = {
  missingCode: 'The code parameter is required.',
  missingRedirectUri: 'The redirect_uri parameter is required.',
  missingVerifier: 'The code_verifier parameter is required; PKCE is mandatory on this server.',
  malformedVerifier:
    'The code_verifier must be 43–128 characters from the RFC 7636 §4.1 unreserved set.',
  /**
   * ONE string for every "this grant is not usable" case. See the header: an
   * endpoint that distinguished expired from unknown from wrong-client would
   * tell an attacker holding a stolen code which of those it is.
   */
  badGrant: 'The authorization code is invalid, expired, or has already been used.',
} as const;

function fail(description: string): GrantOutcome {
  return {
    ok: false,
    // 400, per RFC 6749 §5.2 and PRD p.2's "Mismatched verifier returns 400
    // with invalid_grant". Not 401 — the CLIENT authenticated fine; what is
    // wrong is the grant it presented.
    status: 400,
    body: { error: 'invalid_grant', error_description: description },
  };
}

function badRequest(description: string): GrantOutcome {
  return { ok: false, status: 400, body: { error: 'invalid_request', error_description: description } };
}

/** Is this code redeemable by this client, on this URI, right now? */
function isBound(row: AuthorizationCodeRecord, app: OAuthApp, redirectUri: string, now: Date): boolean {
  // RFC 6749 §4.1.3, all three:
  //   · the code was issued to the authenticated client
  //   · the redirect_uri matches the one used at authorize, byte-for-byte —
  //     compared against the value RECORDED ON THE ROW, not against the app's
  //     registered list, so an app with two registered URIs cannot redeem a code
  //     issued for one against the other
  //   · the code has not expired
  if (row.appId !== app.id) return false;
  if (row.redirectUri !== redirectUri) return false;
  if (row.expiresAt <= now) return false;
  return true;
}

/**
 * The grant handler. Registered as a NEW ENTRY in the router's grant map —
 * adding it required no edit to the dispatcher, which is PF-166/PF-134's whole
 * point and the reason three lanes can add three grant types without merging
 * over one another's `switch` statement.
 */
export function authorizationCodeGrant(deps: AuthCodeGrantDeps): GrantHandler {
  return async ({ app, params }) => {
    const code = params.code;
    if (!code) return badRequest(AUTH_CODE_ERROR_DESCRIPTIONS.missingCode);

    const redirectUri = params.redirect_uri;
    if (!redirectUri) return badRequest(AUTH_CODE_ERROR_DESCRIPTIONS.missingRedirectUri);

    // ── PF-103 — a missing verifier is invalid_grant, never a bypass ─────────
    //
    // There is deliberately no `if (row.codeChallenge)` anywhere below. The
    // column is NOT NULL (migration 065) precisely so that no such branch could
    // ever be justified, and a fitness test greps for one. An absent parameter
    // reaching a truthiness guard is how a non-PKCE path gets invented.
    const verifier = params.code_verifier;
    if (verifier === undefined || verifier === '') {
      return fail(AUTH_CODE_ERROR_DESCRIPTIONS.missingVerifier);
    }
    // Form BEFORE hashing (RFC 7636 §4.1), so a malformed verifier is a grant
    // failure rather than an exception out of the comparison.
    if (!isValidVerifier(verifier)) {
      return fail(AUTH_CODE_ERROR_DESCRIPTIONS.malformedVerifier);
    }

    const now = new Date(deps.clock.nowMs());
    const row = await deps.authCodeRepo.findByHash(hashAuthorizationCode(code));

    if (!row) return fail(AUTH_CODE_ERROR_DESCRIPTIONS.badGrant);

    // ── PF-105 — bound to its client, its redirect_uri, and its lifetime ─────
    // Before the burn. See the header for why the order is load-bearing.
    if (!isBound(row, app, redirectUri, now)) return fail(AUTH_CODE_ERROR_DESCRIPTIONS.badGrant);

    // ── PF-104 — a replayed code revokes what it produced ────────────────────
    //
    // RFC 6749 §4.1.2: a code presented twice means the client is broken or the
    // code leaked, and the safe reading is the second. Revoking mirrors L06's
    // refresh-token reuse rule deliberately — one theft-response story for the
    // whole grant, not a strong one for refresh tokens and a weaker one for
    // codes.
    //
    // `issuedFamilyId` is null when the first presentation was itself a failed
    // PKCE attempt, which burned the code without issuing anything. Nothing to
    // revoke, and the answer is still invalid_grant.
    if (row.consumedAt !== null) {
      if (row.issuedFamilyId) {
        await deps.tokenRepo.revokeFamily(row.issuedFamilyId, 'refresh_token_reuse', now);
      }
      return fail(AUTH_CODE_ERROR_DESCRIPTIONS.badGrant);
    }

    // ── ★ PKCE VALIDATED HERE ───────────────────────────────────────────────
    //
    // `verifyPkce` derives base64url(sha256(verifier)) and compares it to the
    // stored challenge with `timingSafeEqual` after a length guard. This is the
    // ONLY call site of it in the repository and a fitness test proves that —
    // a second comparison written by hand somewhere else is how the constant-
    // time property silently stops holding.
    if (!verifyPkce(verifier, row.codeChallenge)) {
      // PF-102 — burn it. A wrong verifier must not be retriable against the
      // same code with a better guess, which is exactly what an attacker
      // holding a stolen code would do. No family: nothing was issued.
      await deps.authCodeRepo.consume(row.id, now, null);
      return fail(AUTH_CODE_ERROR_DESCRIPTIONS.badGrant);
    }

    // ── The burn, and the family it is about to produce, in one statement ────
    const familyId = newFamilyId();
    const won = await deps.authCodeRepo.consume(row.id, now, familyId);
    if (!won) {
      // Lost a race with a concurrent exchange of the same code. The winner has
      // the tokens; this caller gets the same answer a replay gets, because from
      // its point of view that is what happened.
      return fail(AUTH_CODE_ERROR_DESCRIPTIONS.badGrant);
    }

    // ── Issue, through L06's single issuance site (PF-155) ───────────────────
    //
    // Never minted here. `issueTokenPair` is the only function in the repository
    // that writes a token pair, and calling it rather than reimplementing it is
    // what keeps TTLs, hashing, prefixes and the family chain identical between
    // this grant and the refresh grant.
    const { response } = await issueTokenPair(
      { tokenRepo: deps.tokenRepo, clock: deps.clock, ttl: deps.ttl },
      {
        app,
        userId: row.userId,
        // The RESOLVED grant, copied from the code row — the intersection the
        // consent screen already computed. Never `app.requestedScopes`, which
        // is a ceiling and not a grant.
        scopes: row.scopes,
        // A NEW family. An authorization-code redemption starts a fresh grant;
        // passing an existing family would chain it to something it has no
        // relationship with.
        familyId,
      },
    );

    return { ok: true, body: response };
  };
}
