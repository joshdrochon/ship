/**
 * ★ CLIENT CREDENTIALS. `grant_type=client_credentials` — RFC 6749 §4.4.
 * PF-686, PF-687, PF-688 (lane L23, slice S1).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS GRANT IS IN L23 AND NOT IN L04, L05 OR L06.
 * ---------------------------------------------------------------------------
 * PRD p.17 names the option — *"Client Credentials (RFC 6749 §4.4) for
 * first-party machine-to-machine"* — and L99's D5a picks it for the FleetGraph
 * agent, on the ground that the agent runs on a schedule with no human at a
 * browser. Device and Authorization Code both require a person to visit a URL
 * and click a button; a cron job cannot do either, and pretending otherwise
 * means a human re-authorises a scheduled scan by hand or a refresh token is
 * persisted forever while the grant records claim it was interactive.
 *
 * The three grant lanes are L04 (authorization code), L05 (device) and L06
 * (token lifecycle), and none of them is this one. `router.ts` carried a
 * `TODO(L05/D5)` where this entry now sits and the live server answered
 * `unsupported_grant_type` — measured against `pf/integration`, not assumed.
 *
 * It is registered as a NEW KEY in `grantHandlers`, so the dispatcher was not
 * edited. That is the fourth lane to add a grant type without touching it.
 *
 * ---------------------------------------------------------------------------
 * NO REFRESH TOKEN, ASSERTED BY KEY ABSENCE (PF-686).
 * ---------------------------------------------------------------------------
 * RFC 6749 §4.4.3: *"A refresh token SHOULD NOT be included."* The reasoning is
 * not ceremonial. A refresh token exists so that a credential a human approved
 * once can be renewed without asking them again; a client-credentials client
 * holds its own secret and can re-present it at any moment, so a refresh token
 * buys nothing and costs a second long-lived credential with no rotation story.
 *
 * `issueAccessTokenOnly` is the issuance path, in `issue.ts` with the others —
 * PF-155's one-site rule. Nothing here mints, hashes or generates a token.
 *
 * ---------------------------------------------------------------------------
 * FIRST-PARTY ONLY, AND CONFIDENTIAL ONLY (PF-688).
 * ---------------------------------------------------------------------------
 * Two independent gates, and they are not the same gate said twice.
 *
 * **First-party.** A client-credentials token has no consenting human behind it
 * — `user_id` is null end to end. Every other grant on this server ends with a
 * person looking at a consent screen; this one ends with a server presenting a
 * secret. Handing that shape to a third-party developer would let any registered
 * app read workspace data with nobody having approved it, which is precisely the
 * property `/oauth/authorize` exists to establish. `is_first_party` is the
 * column L02 already ships for this distinction (PF-054).
 *
 * **Confidential.** `authenticateClient` lets a `is_public` app authenticate
 * with `client_id` ALONE (L99 F70/F100, migration 074) — correctly, because a
 * CLI and an SPA cannot keep a secret and RFC 6749 §3.2.1 only requires
 * authentication of clients that have credentials. But `client_id` is not a
 * secret: it is printed in the README for graders. So a public app reaching this
 * grant would mean *anyone who read the README* could mint a token carrying that
 * app's full scope set, with no human in the loop and nothing to steal first.
 * RFC 6749 §4.4 says so in as many words — the grant *"is suitable for
 * confidential clients"* — and this is the one place on the server where the
 * public-client relaxation and a userless grant would compose into a hole.
 *
 * Both are checked here rather than in `authenticateClient`, because both are
 * properties of THIS grant and not of client authentication: a public app
 * redeeming an authorization code with PKCE is correct and must keep working.
 *
 * ---------------------------------------------------------------------------
 * `scope` NARROWS, NEVER WIDENS — AND NEVER SILENTLY (PF-687d).
 * ---------------------------------------------------------------------------
 * There is no consent record to resolve against: nobody consented. The ceiling
 * is therefore the app's own `requested_scopes`, which is what the registration
 * asked for and an operator approved when they seeded the row.
 *
 * A `scope` parameter naming anything outside that set is `invalid_scope` — NOT
 * a quiet intersection. A caller who asks for `issues:write` and receives a
 * token carrying `issues:read` will discover the difference as a 403 from a
 * route, three layers from the request that caused it. Failing at the token
 * endpoint names the problem where it happened.
 *
 * Omitting `scope` grants the app's full requested set, per §3.3's *"the
 * authorization server SHOULD process the request using … a scope policy."*
 * Here the policy is the registration.
 */
import type { GrantHandler, GrantOutcome } from './router.js';
import type { ITokenRepo } from './tokenRepo.js';
import type { Clock } from '../clock.js';
import type { TokenTtlConfig } from './tokens.js';
import type { Scope } from '../scopes/scopes.js';
import { scopeRegistry } from '../scopes/scopes.js';
import { issueAccessTokenOnly } from './issue.js';

/** RFC 6749 §4.4's grant type, written once. */
export const CLIENT_CREDENTIALS_GRANT_TYPE = 'client_credentials';

export interface ClientCredentialsGrantDeps {
  tokenRepo: ITokenRepo;
  clock: Clock;
  ttl: TokenTtlConfig;
}

/**
 * The `error_description` for each failure, as data.
 *
 * Same call L04's `AUTH_CODE_ERROR_DESCRIPTIONS`, L05's
 * `DEVICE_GRANT_ERROR_DESCRIPTIONS` and L06's `REFRESH_ERROR_DESCRIPTIONS` make:
 * tests assert against the strings the handler emits rather than restating them.
 * Prose only — nothing switches on these, and an SDK that did would be relying
 * on wording rather than on `error`.
 */
export const CLIENT_CREDENTIALS_ERROR_DESCRIPTIONS = {
  /**
   * ONE string covering not-first-party AND public.
   *
   * Distinguishing them would tell a caller holding a published `client_id`
   * exactly which registration property to go and change, and both properties
   * are decisions an operator makes at seed time rather than things a client can
   * fix by retrying. Same reasoning as `verifyClientSecret`'s single failure
   * shape, one layer up.
   */
  notEligible:
    'This client is not permitted to use the client_credentials grant. It is ' +
    'available to first-party confidential clients only (RFC 6749 §4.4).',
  unknownScope: 'One or more requested scopes are not registered on this server.',
  scopeNotRequested:
    'The requested scope exceeds what this client is registered for. Client ' +
    'credentials grants no scope the registration did not ask for.',
} as const;

function fail(error: string, description: string): GrantOutcome {
  return {
    // 400, per RFC 6749 §5.2. `invalid_client` is the one that carries 401, and
    // that case is handled ABOVE this handler by `authenticateClient` — a
    // request that reaches here has already authenticated.
    ok: false,
    status: 400,
    body: { error: error as never, error_description: description },
  };
}

/**
 * Resolves the token's scope set.
 *
 * Returns a discriminated failure rather than throwing, so the two ways a scope
 * request can be wrong stay distinguishable to the caller: naming a scope this
 * server has never heard of is a different mistake from naming a real scope this
 * app did not register for.
 */
export function resolveClientCredentialsScopes(
  requestedByApp: readonly string[],
  scopeParam: string | undefined,
): { ok: true; scopes: Scope[] } | { ok: false; reason: 'unknown' | 'not_requested' } {
  // The ceiling. Filtered through the registry because `requested_scopes` is a
  // `text[]` column and a row written before a scope was renamed would otherwise
  // mint a token carrying a name `requireScope` cannot match.
  const ceiling = requestedByApp.filter((s): s is Scope => scopeRegistry.has(s));

  if (scopeParam === undefined || scopeParam.trim() === '') {
    return { ok: true, scopes: ceiling };
  }

  const asked = scopeParam.trim().split(/\s+/);
  const resolved: Scope[] = [];
  for (const name of asked) {
    if (!scopeRegistry.has(name)) return { ok: false, reason: 'unknown' };
    if (!ceiling.includes(name as Scope)) return { ok: false, reason: 'not_requested' };
    resolved.push(name as Scope);
  }
  return { ok: true, scopes: resolved };
}

export function clientCredentialsGrant(deps: ClientCredentialsGrantDeps): GrantHandler {
  return async ({ app, params }) => {
    // PF-688, half one. Both gates, before anything else runs.
    //
    // `app.active` is NOT re-checked here: `authenticateClient` already refuses
    // an inactive app for every grant, which is where D2/PF-052 belongs. A
    // second copy here would be a second place to keep in step.
    if (!app.isFirstParty || app.isPublic) {
      return fail('unauthorized_client', CLIENT_CREDENTIALS_ERROR_DESCRIPTIONS.notEligible);
    }

    const scopes = resolveClientCredentialsScopes(app.requestedScopes, params.scope);
    if (!scopes.ok) {
      return fail(
        'invalid_scope',
        scopes.reason === 'unknown'
          ? CLIENT_CREDENTIALS_ERROR_DESCRIPTIONS.unknownScope
          : CLIENT_CREDENTIALS_ERROR_DESCRIPTIONS.scopeNotRequested,
      );
    }

    const issued = await issueAccessTokenOnly(
      { tokenRepo: deps.tokenRepo, clock: deps.clock, ttl: deps.ttl },
      { app, scopes: scopes.scopes },
    );

    return { ok: true, body: issued.response };
  };
}
