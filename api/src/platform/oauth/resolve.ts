/**
 * `resolveToken` — raw bearer credential -> app + user + granted scopes.
 * PF-156 (lane L06, slice S1).
 *
 * This is the second half of `docs/architecture.md:138`: *"the bearer middleware
 * resolves token -> app + user + granted scopes on every `/api/v1/*` request."*
 * The middleware (PF-158) is the HTTP wrapper; the decision is here, in a
 * function with no Express types in its signature, so the rules below can be
 * unit-tested without booting a server.
 *
 * ---------------------------------------------------------------------------
 * D2's BOUNDARY — the half L02's PF-052 explicitly deferred to this lane.
 * ---------------------------------------------------------------------------
 * PF-052 asserts that a deactivated app fails client-secret verification, and
 * then says: *"L06 owns that middleware and this lane owns the repository
 * contract it reads."* This is that middleware's decision point.
 *
 * `active === false` is treated as NO TOKEN — the same `invalid` a revoked or
 * unknown token gets, not a distinct error. That is not laziness about error
 * reporting; it is PF-160's oracle rule. Splitting "this app was deactivated"
 * out from "this token does not exist" tells an attacker holding a stolen token
 * that the app is real and merely switched off, which is precisely the fact L02's
 * PF-043 refuses to disclose on the registration surface.
 *
 * D2's whole argument is that a deleted user's access cannot outlive them.
 * `resolve.test.ts` and `bearer.test.ts` prove it end to end rather than at the
 * flag: mint a token, call `deactivateByOwner`, and the NEXT `/api/v1` request
 * with that token is 401.
 *
 * ---------------------------------------------------------------------------
 * CHECK ORDER IS LOAD-BEARING.
 * ---------------------------------------------------------------------------
 * Everything that means "this credential is not ours" is decided BEFORE expiry.
 * A deactivated app's expired token must report `invalid`, not `expired`:
 * `expired` is the one reason that tells an SDK "refresh and retry" (L17's
 * PF-500), and sending a client back to `/oauth/token` when its app is switched
 * off produces a second failure and a confusing loop. `expired` is reserved for
 * the case where refreshing is genuinely the right next move.
 */
import type { Clock } from '../clock.js';
import type { IOAuthAppRepo } from '../apps/repo.js';
import type { OAuthApp } from '../apps/types.js';
import type { PlatformAuthContext } from '../scopes/auth-context.js';
import type { ITokenRepo } from './tokenRepo.js';
import { hashToken, ACCESS_TOKEN_TAG } from './tokens.js';

/**
 * Why resolution failed, in the vocabulary L07's closed `UNAUTHORIZED_REASONS`
 * enum uses (`expired` | `invalid` | `missing`).
 *
 * `missing` is not produced here — it is the middleware's answer to "no
 * Authorization header at all", and this function is only called once a
 * credential exists.
 */
export type ResolveFailureReason = 'expired' | 'invalid';

export type ResolveResult =
  | { ok: true; context: PlatformAuthContext; app: OAuthApp }
  | { ok: false; reason: ResolveFailureReason };

export interface ResolveTokenDeps {
  tokenRepo: ITokenRepo;
  appsRepo: IOAuthAppRepo;
  clock: Clock;
}

export async function resolveToken(
  deps: ResolveTokenDeps,
  rawToken: string,
): Promise<ResolveResult> {
  // The presented value is hashed and looked up by digest. The raw token is
  // never compared against anything stored, because nothing raw is stored.
  const row = await deps.tokenRepo.findByHash(hashToken(rawToken));

  // Unknown token. Also covers a syntactically malformed value: it simply
  // hashes to a digest no row carries. No separate "malformed" branch exists,
  // deliberately — one fewer way for the two cases to answer differently.
  if (!row) return { ok: false, reason: 'invalid' };

  // A REFRESH token presented as a bearer credential (PF-160).
  //
  // Called out explicitly because it is the mistake an SDK makes when its token
  // store returns the wrong field, and because answering it with anything other
  // than a plain `invalid` leaks which of the two credentials the caller is
  // holding. The tag check below is a cheap second gate on the same rule.
  if (row.tokenType !== 'access') return { ok: false, reason: 'invalid' };
  if (!rawToken.startsWith(ACCESS_TOKEN_TAG)) return { ok: false, reason: 'invalid' };

  // Revoked — individually, or by the family sweep PF-168 fires on refresh
  // reuse, or by PF-165's per-app revocation. All three land here and all three
  // are indistinguishable to the caller.
  if (row.revokedAt !== null) return { ok: false, reason: 'invalid' };

  // Defensive: access tokens are never spent by any code path in this lane.
  // A spent access token would mean a rotation bug, and treating it as live
  // would be the wrong way to find out.
  if (row.spentAt !== null) return { ok: false, reason: 'invalid' };

  // D2 — the app behind the token. `findById` returns the row REGARDLESS of
  // `active`, with the flag on it (L02's PF-037 contract), precisely so this
  // decision is made here and visibly rather than hidden in a WHERE clause.
  const app = await deps.appsRepo.findById(row.appId);
  if (!app) return { ok: false, reason: 'invalid' };
  if (!app.active) return { ok: false, reason: 'invalid' };

  // Expiry LAST — see the check-order note in the header. This is the only
  // outcome that tells a client "refresh and retry".
  if (row.expiresAt.getTime() <= deps.clock.nowMs()) return { ok: false, reason: 'expired' };

  return {
    ok: true,
    app,
    context: {
      appId: app.id,
      clientId: app.clientId,
      userId: row.userId,
      // The scopes on the TOKEN, not on the app. A token carries the grant the
      // user consented to at issuance; narrowing or widening the app's
      // requested_scopes afterwards must not retroactively change it.
      scopes: row.scopes,
      tokenId: row.id,
    },
  };
}
