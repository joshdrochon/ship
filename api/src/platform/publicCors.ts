/**
 * CORS for the PUBLIC surface — L99 F38, closed here.
 *
 * F38: *"`/api/v1` serves no CORS headers. Deliberate… But a browser-based
 * public consumer — including L24's PKCE single-page demo, which is one of the
 * five integrations — needs a policy that does not exist yet. Open item, not a
 * finished decision."* `app.ts`'s own comment names the shape it wanted: *"A
 * browser-based public consumer needs its own CORS policy."* This is it.
 *
 * ── The policy, and why it is `*` ───────────────────────────────────────────
 * `Access-Control-Allow-Origin: *`, with credentials explicitly OFF.
 *
 * That is not the lazy answer, it is the correct one for this surface, and the
 * reasoning is the same one every public API vendor applies:
 *
 *   CORS exists to protect AMBIENT credentials. The danger it addresses is a
 *   browser attaching a cookie the user did not intend to spend, on a request
 *   an attacker's page made. The public surface has no ambient credential to
 *   spend: `/api/v1` authenticates with a `Bearer` token that a script must
 *   possess and attach deliberately, and `/oauth/token` authenticates with a
 *   code plus a PKCE verifier that the caller must already hold. A cross-origin
 *   page that has the token can call the API from a server just as easily; a
 *   page that does not have it learns nothing from being allowed to try.
 *
 * The alternative — reflecting an allowlist built from registered apps'
 * `redirect_uris` — was considered and rejected for this week. It buys no
 * security (see above: there is nothing to protect), it makes every public
 * request depend on a database read on the preflight path, and a preflight
 * carries no `client_id`, so the allowlist could not be keyed on the app making
 * the call anyway. It would be security theatre with a latency bill.
 *
 * ── `credentials: false` is load-bearing, not decoration ────────────────────
 * `Access-Control-Allow-Credentials` is NEVER sent. The browser refuses to pair
 * a wildcard origin with credentials, so this combination is structurally
 * unable to become the dangerous one by a later edit that only widens origins.
 * It also means Ship's own `session_id` cookie can never ride a cross-origin
 * public API call, which keeps the public surface and the internal session
 * model as separate in the browser as PRD p.11 requires them to be on the
 * server.
 *
 * ── Why this is hand-written and not `cors()` ───────────────────────────────
 * `api/src/app.ts` already imports the `cors` package, configured
 * `origin: <the Ship frontend>, credentials: true` for the INTERNAL stack.
 * Reaching for the same helper with the opposite configuration invites exactly
 * one bug: someone edits "the cors options" and moves both. Six lines with no
 * shared configuration object cannot be edited into the internal policy by
 * accident.
 */
import type { RequestHandler } from 'express';

/** Methods the public surface answers. `PATCH` is here for L10's resources. */
export const PUBLIC_CORS_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS';

/**
 * Request headers a cross-origin caller may send.
 *
 * `Idempotency-Key` is on the list because p.4's replay contract passes it
 * through and a subscriber-side tool in a browser would otherwise have it
 * stripped by the preflight.
 */
export const PUBLIC_CORS_REQUEST_HEADERS =
  'Authorization, Content-Type, Idempotency-Key, X-Request-Id';

/**
 * Response headers a cross-origin caller may READ.
 *
 * Without this list a browser consumer can see the status and the body and
 * nothing else — so `X-RateLimit-Remaining` and `Retry-After` (p.4, required to
 * be *carried* on public responses) would be present on the wire and invisible
 * to the only consumer that cannot work around it. An SDK running in a browser
 * would report `rateLimit: null` forever and PF-512 would silently mean nothing
 * there.
 */
export const PUBLIC_CORS_EXPOSED_HEADERS =
  'X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After';

/** Preflight cache, in seconds. Ten minutes — Chrome's own ceiling is 7200. */
export const PUBLIC_CORS_MAX_AGE = '600';

export function publicCors(): RequestHandler {
  return (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', PUBLIC_CORS_EXPOSED_HEADERS);
    // `Vary: Origin` even for a constant `*`: a cache in front of Ship must not
    // serve a public response as though the header were origin-independent if
    // this policy ever narrows.
    res.appendHeader('Vary', 'Origin');

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', PUBLIC_CORS_METHODS);
      res.setHeader('Access-Control-Allow-Headers', PUBLIC_CORS_REQUEST_HEADERS);
      res.setHeader('Access-Control-Max-Age', PUBLIC_CORS_MAX_AGE);
      // 204 and terminate. A preflight must never reach bearer auth, the rate
      // limiter or a grant handler: it carries no credential by design, so
      // letting it through would answer 401 to a request the browser reads as
      // "this endpoint is not reachable" — which is how a working API looks
      // broken from a browser and from nowhere else.
      res.status(204).end();
      return;
    }

    next();
  };
}
