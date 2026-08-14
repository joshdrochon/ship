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
import type { Scope } from '../scopes/scopes.js';
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

/**
 * RFC 6749 §4.4.3's response. Note what is NOT here: `refresh_token`.
 *
 * *"A refresh token SHOULD NOT be included."* A client credentials client holds
 * its own secret and can mint a new token whenever it likes, so a refresh token
 * would be a second long-lived credential earning nothing — and one with no
 * rotation story, since there is no user session to log out and nothing to
 * revoke a family against beyond the token itself.
 *
 * L23's PF-686 asserts the absence by KEY, not by value: `'refresh_token' in
 * body` must be false. An `undefined` value would serialise away over JSON and
 * pass a truthiness check while a second implementation quietly reintroduced it.
 */
export interface AccessTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
}

export interface IssuedAccessToken {
  response: AccessTokenResponse;
  access: TokenRecord;
  familyId: string;
}

/**
 * L23 PF-686 — the client-credentials issuance path.
 *
 * Lives HERE, in `issue.ts`, rather than in the grant handler, because PF-155's
 * rule is that this file is the only place tokens are minted. The grep in
 * `issue.test.ts` — nothing under `platform/oauth/` draws random bytes except
 * `tokens.ts` — is what keeps that true, and a second minting site inside the
 * grant would satisfy the grep while defeating its purpose.
 *
 * `userId` is not a parameter. A client-credentials token belongs to an app and
 * to no human (RFC 6749 §4.4: *"the client is acting on its own behalf"*), so
 * there is nothing for a caller to pass and nothing for a caller to get wrong.
 * The column is nullable for exactly this case — `043_oauth_tokens.sql` says so
 * in its own comment.
 */
export async function issueAccessTokenOnly(
  deps: IssueTokenPairDeps,
  input: { app: OAuthApp; scopes: Scope[]; repo?: ITokenRepo },
): Promise<IssuedAccessToken> {
  const repo = input.repo ?? deps.tokenRepo;
  const now = new Date(deps.clock.nowMs());
  const accessToken = generateAccessToken();
  const familyId = newFamilyId();

  const access = await repo.insertAccessOnly({
    familyId,
    appId: input.app.id,
    // THE null. Not an omission — see the header.
    userId: null,
    workspaceId: input.app.workspaceId,
    scopes: input.scopes,
    accessTokenHash: hashToken(accessToken),
    accessTokenPrefix: tokenPrefix(accessToken),
    accessExpiresAt: new Date(now.getTime() + deps.ttl.accessSeconds * 1000),
    createdAt: now,
  });

  return {
    response: {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: deps.ttl.accessSeconds,
      scope: input.scopes.join(' '),
    },
    access,
    familyId,
  };
}
