/**
 * `issueTokenPair` — THE single issuance site. PF-155 (lane L06, slice S1).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ONE FUNCTION AND WHY THAT MATTERS MORE THAN IT LOOKS.
 * ---------------------------------------------------------------------------
 * Three callers mint tokens: L04's authorization-code redemption (PF-100), L05's
 * device-grant redemption (PF-140), and this lane's own refresh rotation
 * (PF-166). If any of them grows a local `generateToken`, the flows drift into
 * DIFFERENT ROTATION SEMANTICS — and the failure is invisible, because every
 * test in this lane would still pass. PF-169's family guarantee would be true
 * for one grant and false for another.
 *
 * So the rule is mechanical, not cultural: one exported function, one
 * definition, and a grep assertion in all three lanes. `issue.test.ts` asserts
 * there is no second definition and that nothing under `platform/oauth/` mints a
 * token outside `tokens.ts`.
 *
 * ---------------------------------------------------------------------------
 * SCOPES ARE AN INPUT, NEVER READ OFF THE APP.
 * ---------------------------------------------------------------------------
 * `scopes` is a parameter and this function never reads `app.requestedScopes`.
 * That is deliberate and it is asserted: `requested_scopes` is what an app ASKED
 * FOR at registration, and the granted set is what the USER consented to, which
 * is the same set or a narrower one. Reading the app's list here would silently
 * upgrade every token to the maximum the app ever requested, quietly undoing
 * consent. L03's `resolveGrantedScopes` (PF-074) is what produces the argument;
 * this function's contract is that it faithfully records whatever it was handed.
 */
import type { Clock } from '../clock.js';
import type { Scope } from '../scopes/registry.js';
import type { OAuthApp } from '../apps/types.js';
import type { ITokenRepo, TokenRecord } from './tokenRepo.js';
import {
  generateAccessToken,
  generateRefreshToken,
  hashToken,
  tokenPrefix,
  newFamilyId,
  type TokenTtlConfig,
} from './tokens.js';

/** RFC 6749 §5.1, verbatim. This is the body both grant redemptions return. */
export interface TokenPairResponse {
  access_token: string;
  token_type: 'Bearer';
  /** Seconds. Read from the injected TTL config, never restated (PF-157). */
  expires_in: number;
  refresh_token: string;
  /** Space-delimited, per §5.1 — the RESOLVED grant. */
  scope: string;
}

export interface IssueTokenPairDeps {
  tokenRepo: ITokenRepo;
  clock: Clock;
  ttl: TokenTtlConfig;
}

export interface IssueTokenPairInput {
  app: OAuthApp;
  /** Null for a machine-to-machine token: it belongs to an app and to no human. */
  userId: string | null;
  /** The RESOLVED grant. See the header — never `app.requestedScopes`. */
  scopes: Scope[];
  /**
   * ROTATION: pass the existing family to keep the chain (PF-153). Omitted, a
   * NEW family is started — which is what an authorization-code or device-grant
   * redemption does, and why those two produce distinct families.
   */
  familyId?: string;
  /** The tokens this pair supersedes, for the `replaces_token_id` chain. */
  replacesAccessTokenId?: string | null;
  replacesRefreshTokenId?: string | null;
  /**
   * Transaction-bound repository. Rotation passes the repo it got from
   * `transaction()` so the insert joins the same transaction as the spend
   * (PF-170). Omitted, `deps.tokenRepo` is used directly.
   */
  repo?: ITokenRepo;
}

/**
 * The raw pair plus the rows behind it.
 *
 * `response` is exactly the RFC 6749 §5.1 body and nothing else — a caller
 * serializes it straight to the wire. The two records ride alongside because
 * rotation needs the new refresh token's id to link the next link in the chain,
 * and because the replay window (D14) needs to remember what it issued. Neither
 * is part of the HTTP response.
 */
export interface IssuedPair {
  response: TokenPairResponse;
  access: TokenRecord;
  refresh: TokenRecord;
  familyId: string;
}

export async function issueTokenPair(
  deps: IssueTokenPairDeps,
  input: IssueTokenPairInput,
): Promise<IssuedPair> {
  const repo = input.repo ?? deps.tokenRepo;

  // Time comes from the injected clock (PF-017/PF-173), never from `Date.now()`.
  // That is what lets a drill advance a FakeClock past a TTL instead of waiting,
  // which PRD p.11 requires and p.9's zero-flake budget depends on.
  const now = new Date(deps.clock.nowMs());

  const accessToken = generateAccessToken();
  const refreshToken = generateRefreshToken();

  const familyId = input.familyId ?? newFamilyId();

  const { access, refresh } = await repo.insertPair({
    familyId,
    appId: input.app.id,
    userId: input.userId,
    workspaceId: input.app.workspaceId,
    scopes: input.scopes,
    accessTokenHash: hashToken(accessToken),
    accessTokenPrefix: tokenPrefix(accessToken),
    accessExpiresAt: new Date(now.getTime() + deps.ttl.accessSeconds * 1000),
    refreshTokenHash: hashToken(refreshToken),
    refreshTokenPrefix: tokenPrefix(refreshToken),
    refreshExpiresAt: new Date(now.getTime() + deps.ttl.refreshSeconds * 1000),
    replacesAccessTokenId: input.replacesAccessTokenId ?? null,
    replacesRefreshTokenId: input.replacesRefreshTokenId ?? null,
    createdAt: now,
  });

  return {
    response: {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: deps.ttl.accessSeconds,
      refresh_token: refreshToken,
      scope: input.scopes.join(' '),
    },
    access,
    refresh,
    familyId,
  };
}
