/**
 * `GET /oauth/authorize` — parameter validation, as pure functions.
 * PF-088 – PF-093 (lane L04, slice S1).
 *
 * Everything here takes values and returns values. No Express, no database, no
 * HTML. That is what lets the whole decision table — six rejection cases, two of
 * which must NOT redirect — be driven from a unit test with no HTTP stack, and
 * it is the same shape L03's `validation.ts` uses for the same reason.
 *
 * ---------------------------------------------------------------------------
 * THE SPLIT THAT MATTERS: RENDERED vs REDIRECTED (PF-089, RFC 6749 §4.1.2.1).
 * ---------------------------------------------------------------------------
 * The RFC divides authorize-time failures in two, and the division is a security
 * boundary rather than a presentation choice:
 *
 *   RENDERED    the `client_id` is unknown, the `redirect_uri` is missing, or it
 *               does not match a registered one. The server MUST NOT redirect.
 *               It has not established that the URI belongs to the client, and
 *               redirecting to it anyway turns `/oauth/authorize` into an open
 *               redirector — attacker supplies `client_id=real&redirect_uri=evil`,
 *               gets a 302 to `evil` from Ship's own domain, and now has a
 *               phishing link with our hostname on it.
 *
 *   REDIRECTED  everything else. The URI is proven to belong to the client, so
 *               the client is entitled to learn why its request failed, in the
 *               only channel it has: `error` + `state` on the redirect.
 *
 * PF-089's table test drives two rendered cases and four redirected ones and
 * asserts no rendered case emits a `Location` header. p.10 asks for
 * "hand-rolled minimal IETF-correct flows"; this is one of the places
 * "IETF-correct" has teeth, because a functionally-correct implementation passes
 * every happy-path test with the split absent.
 *
 * ---------------------------------------------------------------------------
 * ORDER OF CHECKS IS PART OF THE CONTRACT.
 * ---------------------------------------------------------------------------
 * `client_id` → `redirect_uri` → `active` → everything else. The first two must
 * come first because every later error needs a *trusted* redirect target to be
 * delivered to. Reordering this is not a refactor; it changes which failures
 * become open redirects.
 */
import type { OAuthApp } from '../apps/types.js';
import type { Scope } from '../scopes/scopes.js';
import { validateRequestedScopes } from '../scopes/validation.js';
import type { ScopeRegistry } from '../scopes/registry.js';

/**
 * RFC 6749 §4.1.2.1's error codes for the authorization endpoint.
 *
 * A subset of `OAUTH_ERROR_CODES` (`oauthErrors.ts`) rather than a second
 * taxonomy — `server_error` and `temporarily_unavailable` are in §4.1.2.1 and
 * deliberately absent here, because nothing in this lane produces either and an
 * unproduced code is a code no test covers.
 */
export type AuthorizeErrorCode =
  | 'invalid_request'
  | 'unauthorized_client'
  | 'access_denied'
  | 'unsupported_response_type'
  | 'invalid_scope';

/** The raw query string, before anything is trusted. Every field optional by construction. */
export interface AuthorizeQuery {
  response_type?: string | undefined;
  client_id?: string | undefined;
  redirect_uri?: string | undefined;
  scope?: string | undefined;
  state?: string | undefined;
  code_challenge?: string | undefined;
  code_challenge_method?: string | undefined;
}

/**
 * A failure that must be RENDERED on Ship's own origin. See the header.
 *
 * Carries no `redirect_uri` and no `state`, because by construction neither has
 * been established — making them absent from the type is what stops a later
 * edit from "helpfully" redirecting one of these.
 */
export interface RenderedAuthorizeError {
  disposition: 'render';
  error: AuthorizeErrorCode;
  errorDescription: string;
}

/** A failure the client is entitled to receive on its own validated redirect URI. */
export interface RedirectedAuthorizeError {
  disposition: 'redirect';
  redirectUri: string;
  error: AuthorizeErrorCode;
  errorDescription: string;
  /** PF-092 — echoed verbatim, and absent when the client sent none. */
  state: string | undefined;
}

export type AuthorizeError = RenderedAuthorizeError | RedirectedAuthorizeError;

/** A request that passed every check. What the consent screen renders from. */
export interface ValidatedAuthorizeRequest {
  app: OAuthApp;
  redirectUri: string;
  /**
   * The scopes the CLIENT asked for, all of them registered. Not yet
   * intersected with the app's registration — that happens at consent
   * resolution (PF-091), because the consent screen must show the user what the
   * app can actually receive, which is the intersection.
   */
  requestedScopes: Scope[];
  state: string | undefined;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

export type AuthorizeOutcome =
  | { ok: true; request: ValidatedAuthorizeRequest }
  | { ok: false; error: AuthorizeError };

/**
 * PF-090 — the only `code_challenge_method` this server accepts.
 *
 * `plain` is rejected rather than supported-and-discouraged. The policy is the
 * one `pkce.ts`'s header already states: if you can compute SHA-256 you have no
 * reason to send the verifier in the clear. Supporting `plain` would also make
 * the mandatory negative test (PF-102) meaningless for any client that chose it,
 * because with `plain` the "verifier" and the "challenge" are the same string
 * and there is nothing to get wrong.
 */
export const SUPPORTED_CODE_CHALLENGE_METHOD = 'S256' as const;

/**
 * An S256 challenge is base64url of a 32-byte digest: exactly 43 characters,
 * unpadded (RFC 7636 §4.2). A 44-character value with `=` is standard base64
 * padding and is the single most common way a client's PKCE implementation is
 * wrong; rejecting it here with a named reason is far kinder than accepting it
 * and failing the exchange with `invalid_grant` a second later.
 */
const S256_CHALLENGE_PATTERN = /^[A-Za-z0-9\-._~]{43}$/;

/**
 * PF-088 — `redirect_uri` is compared BYTE-FOR-BYTE against the registered list.
 *
 * Not normalised, not parsed, not case-folded on the host, no trailing-slash
 * tolerance. L02's PF-042 stores the URIs verbatim precisely so this comparison
 * can be `===`, and every normalisation anyone has ever added here has widened
 * what an attacker can register their way into: a parser that treats
 * `https://app.example.com` and `https://app.example.com/` as equal is one
 * whose disagreement with the client's parser becomes a redirect to somewhere
 * neither party intended.
 *
 * RFC 6749 §3.1.2.3 permits simple string comparison and §3.1.2.2 requires
 * registration; taking both literally is the narrow, defensible reading.
 */
export function redirectUriMatches(registered: readonly string[], presented: string): boolean {
  return registered.some((uri) => uri === presented);
}

function render(error: AuthorizeErrorCode, errorDescription: string): AuthorizeOutcome {
  return { ok: false, error: { disposition: 'render', error, errorDescription } };
}

function redirect(
  redirectUri: string,
  state: string | undefined,
  error: AuthorizeErrorCode,
  errorDescription: string,
): AuthorizeOutcome {
  return {
    ok: false,
    error: { disposition: 'redirect', redirectUri, error, errorDescription, state },
  };
}

/**
 * The whole decision, in the order the header fixes.
 *
 * `app` is `null` when the `client_id` resolved to nothing — resolution is I/O
 * and belongs to the caller, so this function stays pure and the repository
 * lookup stays testable on its own.
 */
export function validateAuthorizeRequest(
  app: OAuthApp | null,
  query: AuthorizeQuery,
  registry?: ScopeRegistry<string>,
): AuthorizeOutcome {
  const state = query.state;

  // ── 1. client_id ────────────────────────────────────────────────────────────
  // RENDERED. Nothing is trusted yet.
  if (!query.client_id) {
    return render('invalid_request', 'The client_id parameter is required.');
  }
  if (!app) {
    // Deliberately the same wording as a redirect_uri mismatch below. An
    // authorize endpoint that distinguishes "no such client" from "wrong URI for
    // this client" is a client-id enumerator — the same oracle PF-036 refuses to
    // be at the token endpoint, applied to the front door.
    return render('unauthorized_client', 'The client_id and redirect_uri do not identify a registered application.');
  }

  // ── 2. redirect_uri ─────────────────────────────────────────────────────────
  // RENDERED. This is the check that stops the open redirect.
  if (!query.redirect_uri) {
    return render('invalid_request', 'The redirect_uri parameter is required.');
  }
  if (!redirectUriMatches(app.redirectUris, query.redirect_uri)) {
    return render('unauthorized_client', 'The client_id and redirect_uri do not identify a registered application.');
  }

  // From here the URI is proven to belong to this client and every remaining
  // failure is delivered on it.
  const redirectUri = query.redirect_uri;

  // ── 3. the app is live (PF-093, D2) ─────────────────────────────────────────
  // RENDERED, and that is a deliberate departure from the "everything else
  // redirects" rule above. Two reasons, both structural:
  //
  //   (a) A deactivated app is one whose owner was deleted or which an admin
  //       killed — in the abuse case, killed for exactly the kind of behaviour
  //       that makes bouncing a browser to its registered URI a bad idea. The
  //       registration is no longer a statement we want to act on.
  //   (b) The user is never shown a consent screen for an app that cannot
  //       receive the grant, which is the second half of PF-052's argument: L02
  //       proves a token minted before deactivation stops validating, this
  //       proves a new grant cannot be started after it.
  //
  // The cost is honest: a well-behaved client whose app was deactivated gets a
  // page instead of a machine-readable redirect, and has to look at it. That is
  // the correct trade for a state that should be rare and needs a human anyway.
  if (!app.active) {
    return render('unauthorized_client', 'This application is no longer active.');
  }

  // ── 4. response_type ────────────────────────────────────────────────────────
  if (query.response_type !== 'code') {
    return redirect(
      redirectUri,
      state,
      'unsupported_response_type',
      `Only response_type=code is supported; received ${query.response_type ? `'${query.response_type}'` : 'nothing'}.`,
    );
  }

  // ── 5. PKCE (PF-090) ────────────────────────────────────────────────────────
  // Both parameters REQUIRED. There is no non-PKCE path to fall back to, and
  // that absence is what makes the mandatory negative test (PF-102) meaningful:
  // if PKCE were optional, a client could simply omit it and the check being
  // tested would never run.
  if (!query.code_challenge) {
    return redirect(redirectUri, state, 'invalid_request', 'The code_challenge parameter is required; PKCE is mandatory.');
  }
  if (!query.code_challenge_method) {
    return redirect(
      redirectUri,
      state,
      'invalid_request',
      'The code_challenge_method parameter is required and must be S256.',
    );
  }
  if (query.code_challenge_method !== SUPPORTED_CODE_CHALLENGE_METHOD) {
    // Names the offending method, so a client sending `plain` learns what is
    // wrong from the error rather than from the spec.
    return redirect(
      redirectUri,
      state,
      'invalid_request',
      `Unsupported code_challenge_method '${query.code_challenge_method}'; only S256 is supported.`,
    );
  }
  if (!S256_CHALLENGE_PATTERN.test(query.code_challenge)) {
    return redirect(
      redirectUri,
      state,
      'invalid_request',
      'The code_challenge must be 43 characters of unpadded base64url (RFC 7636 §4.2).',
    );
  }

  // ── 6. scope (PF-091) ───────────────────────────────────────────────────────
  //
  // ⚑ DECISION, and it is one this lane makes rather than inherits: an ABSENT or
  // empty `scope` is `invalid_request`, not "grant nothing" and not "grant
  // everything".
  //
  // RFC 6749 §3.3 leaves the no-scope case to the server. L03's
  // `validateRequestedScopes` header settles half of it — an empty request is
  // never all-scopes, "for the same reason `chmod 777` is wrong: the failure is
  // silent and maximal" — but its other option, issuing a zero-scope grant,
  // has the mirror-image problem: the client gets a token that works, carries
  // nothing, and 403s on its first real call. That converts a client bug into a
  // production incident days later, which is the exact failure mode L03's header
  // argues against for unknown scope names. There is no useful zero-scope token
  // on this server, so asking for none is a malformed request and is answered as
  // one, immediately, on the redirect the client is listening to.
  const rawScope = query.scope?.trim() ?? '';
  if (rawScope === '') {
    return redirect(
      redirectUri,
      state,
      'invalid_request',
      'The scope parameter is required; this server issues no zero-scope tokens.',
    );
  }

  // RFC 6749 §3.3: space-delimited. Split on runs of whitespace so a
  // double-space from a client's string concatenation is not an empty scope name.
  const requested = rawScope.split(/\s+/);
  const validation = registry
    ? validateRequestedScopes(requested, registry)
    : validateRequestedScopes(requested);

  if (validation.unknown.length > 0) {
    // Names the offending scopes — the shape L03's PF-080(b) asserts against.
    // A client that asked for something that does not exist has a bug, and
    // silently dropping the name would hide it until a 403 in production.
    return redirect(
      redirectUri,
      state,
      'invalid_scope',
      `Unknown scope(s): ${validation.unknown.join(', ')}.`,
    );
  }

  return {
    ok: true,
    request: {
      app,
      redirectUri,
      requestedScopes: validation.valid,
      state,
      codeChallenge: query.code_challenge,
      codeChallengeMethod: SUPPORTED_CODE_CHALLENGE_METHOD,
    },
  };
}

/**
 * PF-092 — build a redirect URL, echoing `state` verbatim.
 *
 * `URLSearchParams` does the percent-encoding, so a `state` containing reserved
 * characters round-trips byte-for-byte through the client's own parser. The
 * temptation this function exists to resist is hand-concatenating
 * `?code=${code}&state=${state}`, which silently corrupts any state containing
 * `&`, `#` or `=` and is how a client's CSRF defence stops working without
 * anyone noticing.
 *
 * `state` is the CLIENT's CSRF defence for the redirect leg (RFC 6749 §10.12)
 * and the only party that can check it is the client. Dropping it disables a
 * defence we do not own and cannot compensate for. The PRD does not name
 * `state`; p.10's "IETF-correct" is the citation and PF-092 does not pretend
 * otherwise.
 *
 * Appends to whatever query the registered URI already carries, per §3.1.2 —
 * a registered `https://app.example.com/cb?tenant=7` keeps `tenant=7`.
 */
export function buildRedirect(
  redirectUri: string,
  params: Record<string, string>,
  state: string | undefined,
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  // Set last and only when present. `undefined` must not become the literal
  // string "undefined", and an absent state must not become `state=`.
  if (state !== undefined) url.searchParams.set('state', state);
  return url.toString();
}
