/**
 * PF-073 – PF-076 — scope decisions made at grant time, as pure functions.
 *
 * Everything here takes values and returns values. No Express, no database, no
 * module-level state beyond the default registry. That is deliberate and it is
 * what lets L04 (`/oauth/authorize`) and L05 (device grant) call these before
 * either lane exists — they are consumers of L03, not co-authors of it, and a
 * pure function is the only kind of dependency that can be satisfied that early.
 *
 * Four questions, four functions, asked at four different moments:
 *
 *   validateRequestedScopes   at /oauth/authorize: did the client ask for
 *                             something real? Unknown names become RFC 6749
 *                             `invalid_scope`.
 *   resolveGrantedScopes      at token issuance: what may this token actually
 *                             carry? The app's registration is a ceiling the
 *                             consent payload cannot raise.
 *   reconcileTokenScopes      at request time: is what this token carries still
 *                             meaningful? A name the registry has forgotten is
 *                             not a permission.
 *   resolveScopeUpgrade       when a client wants more than it has: re-consent
 *                             to the union. See the policy note below.
 *
 * ## PF-076 — scope upgrades are re-consent with union (decided; D4, 2026-08-12)
 *
 * A client holding `documents:read` that now needs `documents:write` restarts
 * `/oauth/authorize`. The user is shown the **union** of what they already
 * granted and what is newly asked, consents once, and a fresh token replaces the
 * old one. There is no partial grant, no mutable grant record, and no state that
 * says "granted A, pending B".
 *
 * The alternative — incremental consent, where the new token carries only the
 * increment and the client holds two — is the better product answer and Google
 * ships it. It is not the better answer for a one-week hand-rolled RFC 6749
 * implementation, because it turns a grant from a fact into a mutable
 * accumulator: every code path that reads scopes has to know how to merge across
 * live tokens, and revocation has to reason about which of several tokens
 * carried which grant. Re-consent-with-union keeps a token's scope set immutable
 * for its whole life, which is the property every other function in this file
 * assumes.
 *
 * The cost is honest and it is a real one: the user sees a consent screen again,
 * including for permissions they already approved. Showing the union rather than
 * just the delta is what makes that screen truthful — the user is consenting to
 * the whole of what the new token will carry, not to an increment whose base
 * they would have to remember.
 */
import type { ScopeRegistry } from './registry.js';
import { scopeRegistry, type Scope } from './scopes.js';

/** The outcome of checking a client's requested scopes against the registry. */
export interface ScopeValidation {
  /** Requested names that are registered, deduplicated, in requested order. */
  valid: Scope[];
  /**
   * Requested names nobody registered.
   *
   * Non-empty means the whole authorization request fails with RFC 6749
   * `invalid_scope` — not a silent drop. A client that asked for something that
   * does not exist has a bug, and quietly issuing a token without that scope
   * turns a startup-time bug into a 403 in production weeks later.
   */
  unknown: string[];
}

/**
 * PF-073 — split a requested scope list into known and unknown.
 *
 * An **empty** request returns empty-valid, never all-scopes. RFC 6749 §3.3
 * leaves the no-scope case to the server, and "everything" is the wrong default
 * for the same reason `chmod 777` is: the failure is silent and maximal. A
 * client that wants scopes asks for them.
 *
 * Accepts `string[]` rather than `Scope[]` on purpose — the input is a
 * space-delimited query parameter from an untrusted client, and typing it as
 * already-valid would put the cast at the wrong end of the check.
 */
export function validateRequestedScopes(
  requested: readonly string[],
  registry: ScopeRegistry<string> = scopeRegistry,
): ScopeValidation {
  const valid: Scope[] = [];
  const unknown: string[] = [];

  for (const name of requested) {
    if (registry.has(name)) {
      if (!valid.includes(name as Scope)) valid.push(name as Scope);
    } else if (!unknown.includes(name)) {
      unknown.push(name);
    }
  }

  return { valid, unknown };
}

/**
 * PF-074 — what a token may carry: the intersection of the app's registration
 * and what the user actually consented to.
 *
 * Two ceilings, and the app's is the one that matters here. An OAuth app
 * declares `requested_scopes` when it registers (L02); a consent payload arrives
 * later, over the network, from a browser. If the payload could add a scope the
 * app never registered, the registration would be decoration — an attacker who
 * can tamper with the consent step could grant themselves anything in the
 * registry. Intersecting means a scope the app never asked for cannot appear on
 * one of its tokens, whatever the consent payload says.
 *
 * Order follows `appRequested`, so a token's scope list is stable across grants
 * regardless of how the consent form serialised its checkboxes.
 */
export function resolveGrantedScopes(
  appRequested: readonly Scope[],
  userConsented: readonly Scope[],
): Scope[] {
  const consented = new Set<string>(userConsented);
  const granted: Scope[] = [];

  for (const scope of appRequested) {
    if (consented.has(scope) && !granted.includes(scope)) granted.push(scope);
  }

  return granted;
}

/** What a presented token's scopes still mean, checked against the live registry. */
export interface TokenScopeReconciliation {
  /** Scopes still registered. These are the only ones that grant anything. */
  effective: Scope[];
  /**
   * Scopes the token carries that the registry no longer knows.
   *
   * Recorded rather than dropped. The audit trail's `scope used` field (p.4) is
   * how an operator finds out that deregistering a scope broke live integrations,
   * and a silent drop turns that into a support ticket instead of a metric.
   */
  unrecognized: string[];
}

/**
 * PF-075 — re-validate a token's scopes against the registry at request time.
 *
 * A token is issued once and used for as long as it lives. The registry can move
 * underneath it: a scope is renamed, or removed because the feature it guarded
 * was withdrawn. The token still carries the old name.
 *
 * Treating that name as still granted would be the worst outcome — it would mean
 * a permission survives the removal of the thing that defined it. So an
 * unrecognized name grants nothing, and the guard 403s naming what it needed.
 * Deleting it quietly would be nearly as bad, because then nobody learns that a
 * deregistration broke a live integration; it comes back as `unrecognized` for
 * the audit sink to record.
 */
export function reconcileTokenScopes(
  tokenScopes: readonly string[],
  registry: ScopeRegistry<string> = scopeRegistry,
): TokenScopeReconciliation {
  const effective: Scope[] = [];
  const unrecognized: string[] = [];

  for (const name of tokenScopes) {
    if (registry.has(name)) {
      if (!effective.includes(name as Scope)) effective.push(name as Scope);
    } else if (!unrecognized.includes(name)) {
      unrecognized.push(name);
    }
  }

  return { effective, unrecognized };
}

/** The decision a client's scope upgrade produces. See the module header. */
export interface ScopeUpgrade {
  /**
   * Whether the user has to be sent back through `/oauth/authorize`.
   *
   * False only when the existing grant already covers everything requested — in
   * which case the client should keep using the token it has rather than burn a
   * consent screen on a no-op.
   */
  requiresConsent: boolean;
  /**
   * What the consent screen shows and what the resulting token will carry: the
   * union, in existing-grant order followed by the newly requested additions.
   *
   * The union rather than the delta. A user approving a screen that lists only
   * the delta is not being told what the token they end up holding can do.
   */
  consentScopes: Scope[];
  /** The subset of `consentScopes` the existing grant did not already include. */
  added: Scope[];
}

/**
 * PF-076 — the scope-upgrade policy, as a function.
 *
 * The policy is a decision (D4) rather than a discovery, so it lives in one
 * place that both `/oauth/authorize` (L04) and the device grant (L05) call,
 * instead of being re-derived in each. `docs/architecture.md` carries the
 * paragraph; this carries the behaviour.
 */
export function resolveScopeUpgrade(
  existingGrant: readonly Scope[],
  newlyRequested: readonly Scope[],
): ScopeUpgrade {
  const held = new Set<string>(existingGrant);
  const added: Scope[] = [];

  for (const scope of newlyRequested) {
    if (!held.has(scope) && !added.includes(scope)) added.push(scope);
  }

  const consentScopes: Scope[] = [];
  for (const scope of [...existingGrant, ...added]) {
    if (!consentScopes.includes(scope)) consentScopes.push(scope);
  }

  return { requiresConsent: added.length > 0, consentScopes, added };
}
