/**
 * `bearerTokenMiddleware` — MVP GATE ITEM 3. PF-158–164 (lane L06, slice S2).
 *
 * PRD p.2, the gate checkbox this lane exists to close:
 *
 *   "Bearer token middleware validates tokens on every /api/v1/* route; invalid
 *    tokens return 401, missing tokens return 401, expired tokens return 401
 *    with a distinct error code."
 *
 * and p.3's Token Middleware row: *"Bearer validation; populates request with
 * app, user, granted scopes."*
 *
 * ---------------------------------------------------------------------------
 * THE "DISTINCT ERROR CODE" FOR EXPIRY — B14, decided, and NOT a seventh code.
 * ---------------------------------------------------------------------------
 * L07's `ApiErrorCode` union is closed at six and PRD p.7 prints it verbatim.
 * The only 401 in it is `unauthorized`. A seventh member would contradict a
 * graded interface definition AND break L17's PF-498, which asserts the SDK's
 * kind map is key-equal to `API_ERROR_CODES`.
 *
 * So the distinction rides in `details.reason`, machine-readably, against L07's
 * CLOSED `UNAUTHORIZED_REASONS` enum — `expired` | `invalid` | `missing`. That
 * follows the rule L03's PF-069 already established (the 403 puts the missing
 * scope in `details` rather than inventing a code) rather than inventing an
 * escape hatch. `apiErrorBodySchema` is `.strict()` and validates the enum, so
 * an unknown reason fails a test rather than reaching a client.
 *
 * NOTE FOR AN AUDITOR: the lane file (`tickets/plugforge/lane-06-oauth-tokens.md`)
 * used to name these reasons `missing_token` / `invalid_token` / `token_expired`.
 * Those strings PREDATED B14's resolution and would fail L07's schema. The enum
 * L07 shipped is the contract, and the ticket text has now been corrected to
 * match it (2026-08-15, recorded on PF-161) — so the board and this file agree
 * rather than contradicting each other. Behaviour never changed; only the ticket
 * literals did. Note the RFC 6750 challenge on the `WWW-Authenticate` header
 * still reads `error="invalid_token"`, which is a DIFFERENT taxonomy — the wire
 * challenge, not `details.reason` — and is correct as it stands.
 *
 * If the audit reads p.2's "distinct error code" as demanding a distinct
 * `ApiErrorCode`, that is a three-lane conversation (L06, L07, L17) and a spine
 * note — not a local edit adding a seventh member.
 *
 * ---------------------------------------------------------------------------
 * NO SESSION FALLBACK, EVER (PF-164 / L99 F26).
 * ---------------------------------------------------------------------------
 * This middleware reads `Authorization` and NOTHING ELSE. It never looks at
 * `req.cookies`, never at `session_id`, never at `res.locals` populated by the
 * internal stack. A helpful `if (!token) { tryCookie() }` here would:
 *
 *   - make L22's dog-food claim (PF-651) false while APPEARING to work, because
 *     the portal would reach /api/v1 on its browser cookie;
 *   - put a CSRF-able credential on the public write path — and the CSRF skip at
 *     `api/src/app.ts:73` is only safe because the INTERNAL middleware
 *     (`middleware/auth.ts:135`) has this same no-fallback property;
 *   - make the audit row's `client_id` null for an authenticated call, since a
 *     cookie identifies a user and not an app.
 *
 * The absence of a cookie read is the feature. `bearer.test.ts` asserts it by
 * sending a valid session cookie and expecting 401.
 */
import type { Request, Response, NextFunction } from 'express';
import { ApiError, type UnauthorizedReason } from '../api/v1/errors.js';
import type { PlatformAuthContext } from '../scopes/auth-context.js';
import { resolveToken, type ResolveTokenDeps } from './resolve.js';

export type BearerAuthDeps = ResolveTokenDeps;

/**
 * RFC 6750 §3 / §3.1 challenge headers, one per reason.
 *
 * The `error`/`error_description` parameters are what RFC 6750 provides for
 * exactly this distinction, so the expiry case is machine-readable to a
 * standards-aware client through the header AND to our SDK through
 * `details.reason`. Belt and braces, and both are free.
 *
 * The bare `Bearer` challenge for a missing credential is §3's default: no
 * `error` parameter, because the request simply did not authenticate.
 */
const CHALLENGE: Record<UnauthorizedReason, string> = {
  missing: 'Bearer',
  invalid: 'Bearer error="invalid_token", error_description="The access token is invalid"',
  expired: 'Bearer error="invalid_token", error_description="The access token expired"',
};

/**
 * Messages are prose for a human reading a log. NOTHING switches on them — L03's
 * PF-069 established that an SDK cannot switch on message text, which is why
 * `details.reason` exists at all.
 */
const MESSAGE: Record<UnauthorizedReason, string> = {
  missing: 'Authentication required.',
  invalid: 'The access token is invalid.',
  expired: 'The access token has expired.',
};

/**
 * Extracts a bearer credential from an `Authorization` header value.
 *
 * Returns the token, or `null` when no BEARER credential was presented — which
 * covers an absent header, an empty one, a bare `Bearer` with no value, and a
 * different scheme such as `Basic`. All four are "you did not present a bearer
 * token", which is `missing` rather than `invalid`: the client's next move is to
 * attach a credential, not to re-authenticate one it does not have.
 *
 * The scheme comparison is case-insensitive because RFC 7235 §2.1 says the auth
 * scheme is case-insensitive, and a client sending `bearer` is correct.
 */
export function parseBearerHeader(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (trimmed === '') return null;

  // Split on the FIRST run of whitespace only. A token never contains
  // whitespace, so anything after the credential is junk and the value is
  // treated as presented rather than silently repaired.
  const separator = trimmed.search(/\s/);
  if (separator === -1) return null; // a scheme with no credential

  const scheme = trimmed.slice(0, separator);
  const credential = trimmed.slice(separator + 1).trim();

  if (scheme.toLowerCase() !== 'bearer') return null;
  if (credential === '') return null;

  return credential;
}

/**
 * PF-158 — the middleware itself.
 *
 * Composed into `createPublicRouter` through its `bearerAuth` dependency, which
 * puts it at the position `V1_MIDDLEWARE_ORDER` declares: AFTER the audit
 * middleware, so 401s are still audited (L07's PF-193 moved audit above auth
 * precisely because 401s and 429s were never being recorded), and BEFORE the
 * rate limiter and any per-route `requireScope`.
 *
 * Failures go out through `next(ApiError)` rather than by writing a response
 * here. That is what makes an unauthenticated request exercise L07's error
 * middleware, so the body is the same envelope every other failure ships and
 * carries the same `request_id`.
 */
export function bearerTokenMiddleware(deps: BearerAuthDeps) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const fail = (reason: UnauthorizedReason): void => {
      // RFC 6750 §3 requires a challenge on a 401 from a bearer-protected
      // resource. Set before `next` so it survives the error middleware.
      res.setHeader('WWW-Authenticate', CHALLENGE[reason]);
      next(new ApiError('unauthorized', MESSAGE[reason], { details: { reason } }));
    };

    // Only `Authorization`. See the no-session-fallback note in the header.
    const token = parseBearerHeader(req.headers.authorization);
    if (token === null) {
      fail('missing');
      return;
    }

    // `resolveToken` is async; this middleware is not. Express 4 does not
    // forward a rejected promise from a middleware, so the rejection is caught
    // explicitly and routed through `next` — an unhandled rejection here would
    // hang the request until something times out, with no error middleware ever
    // seeing it (the same hazard L07's `asyncRoute` exists to close for routes).
    resolveToken(deps, token).then(
      (result) => {
        if (!result.ok) {
          fail(result.reason);
          return;
        }

        // p.3's Token Middleware row: "populates request with app, user, granted
        // scopes". `res.locals.platformAuth` is the agreed location — L03's
        // `requireScope` reads `.scopes` from it and L12's audit sink reads
        // `.clientId` / `.userId`.
        const context: PlatformAuthContext = result.context;
        res.locals.platformAuth = context;
        next();
      },
      (err: unknown) => {
        // A database failure is a SERVER error, not an auth failure. Reporting
        // it as 401 would tell a client to re-authenticate its way out of our
        // outage, and would file a platform fault as a client error in the
        // audit trail's status column.
        next(err);
      },
    );
  };
}
