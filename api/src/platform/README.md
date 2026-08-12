# platform/ — the public face of Ship (PlugForge, Week 6)

Everything public-facing lives here. Platform modules wrap the **same domain services**
the internal API uses (`api/src/utils/`, `api/src/services/`), attaching authN / authZ /
rate-limit / audit / webhook concerns at this layer only. Nothing under `platform/`
re-implements domain logic, and nothing under `platform/` reaches back into the internal
HTTP surface.

## Module map — one line each (mirrors `docs/architecture.md` "Module Layout")

| Module | Owns |
|---|---|
| `apps/` | `oauth_apps` registry — register, list, rotate; `client_secret` hashed (SHA-256 over 32 bytes CSPRNG), raw shown exactly once |
| `oauth/` | RFC 6749 Authorization Code + RFC 7636 PKCE + RFC 8628 Device Grant; token issuance; one-time-use refresh tokens with family revocation |
| `scopes/` | `ScopeRegistry` — scopes-as-data (documents/issues/sprints × read/write, `webhooks:manage`) + the `requireScope(...)` middleware factory |
| `ratelimit/` | `IRateLimiter` + in-memory token bucket (per-app and per-token); `X-RateLimit-*` on every response, `429` + `Retry-After` |
| `webhooks/` | Event registry (Zod-typed, 8 types), `IEventBus` + `InProcessEventBus`, subscription matcher, HMAC signer, `IWebhookDeliverer`, retry scheduler, delivery log, DLQ + replay |
| `api/v1/` | The **only** public router — fresh middleware stack, `ApiError` envelope, opaque cursor pagination (`{data, next_cursor}`) |
| `openapi/` | Public OpenAPI 3.1 registry, generated from route metadata, served at `/api/v1/openapi.json` |
| `audit/` | Public API call log — timestamp, app `client_id`, `user_id`, route, scope, status, latency, `request_id` |

Each module exposes a barrel `index.ts`. Import a module through its barrel; do not
reach past it into a sibling file of another module.

`clock.ts` sits beside the modules rather than inside one. It is a platform-wide
primitive (`Clock` / `SystemClock` / `FakeClock`) that the retry scheduler, the token
bucket and the OAuth expiry checks all read, so it belongs to none of them. It is not a
module and the layout fitness test does not expect it to be one.

## The public error envelope

Every failure on `/api/v1/*` ships the same four-key body, and nothing else:

```json
{ "code": "forbidden", "message": "Missing required scope: documents:read",
  "details": { "missing_scope": "documents:read" },
  "request_id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }
```

`code` is closed at six values (PRD p.7) and each maps to one status:

| code | status | `details` |
|---|---|---|
| `unauthorized` | 401 | *may* carry `reason` (`expired` \| `invalid` \| `missing`) |
| `forbidden` | 403 | **must carry** `missing_scope`, `granted_scopes`, `scope_description` |
| `not_found` | 404 | **must omit** |
| `validation_failed` | 422 | **must carry** `fields[]` (`{field, message}`) |
| `rate_limited` | 429 | *may* carry `retry_after_seconds` |
| `server_error` | 500 | **must omit** |

**Why the 401 carries a `reason` (dispute B14).** MVP gate item 3 (p.2) requires an
expired token to return "401 with a distinct error code". The distinction lives in
`details.reason`, not in a seventh `ApiErrorCode` — the code union is printed
verbatim on p.7 with six members and L17's PF-498 asserts key-equality against it,
so widening it would make the PRD contradict its own printed interface. The enum is
**closed** (`expired` · `invalid` · `missing`) rather than a free-form string: an
open `reason` would be a second error taxonomy that nothing documents and nothing
validates, which is the exact failure the closed `code` union exists to prevent.
The three values are the three things a caller does differently — refresh,
re-authenticate, attach a credential. L06 sets it; L17 switches on it.

**Why the 403 carries three fields.** Gate item 6 (p.2) forbids an opaque 403:
the missing scope must be "named explicitly in the error body". `missing_scope` is
that name — the brief's own word. `granted_scopes` lets a caller see what it does
have, and `scope_description` is the registry's own prose, so the sentence a
developer reads in the error is the sentence the user was shown at consent. All
three are required; dropping any of them puts the opacity back.

**The `details` policy (answers Pre-Search 2.2, p.16).** The envelope is identical
across all routes. `details` is the only variable part, and its sub-shape is fixed
**per code, never per route**. "No `details` ever" was not available — p.3 requires
a 403 to name the scope it is missing. Per-route detail shapes were available and
were rejected: a consumer who has to learn a different error body per endpoint has
a convention, not an envelope.

`apiErrorBodySchema` in `api/v1/errors.ts` is the single definition of all of the
above — Zod, `.strict()`, discriminated on `code`. The serializer in
`errorMiddleware.ts` and every fitness test import that one schema; there is no
second copy of the shape in the repo, and a test asserts it.

**`validation_failed` is 422, not 400.** The body parsed; the semantics failed. The
only `400` in the PRD is `invalid_grant` on `/oauth/token`, which is RFC 6749's
format on a non-`/api/v1` route and is not an `ApiError`.

**Codes map 6 → 5 onto the SDK's `kind` union, not 1:1.** `unauthorized` and
`forbidden` both surface as `kind: 'auth'`. Published as `SDK_KIND_BY_CODE` so the
SDK imports it rather than restating it.

**`X-Request-Id` is minted server-side on every request, and an inbound one is
ignored.** The header is on every response, success and failure, and on failures it
equals the body's `request_id`. A client-supplied value is never echoed: the id is
the audit trail's join key (p.4), and a caller who picks the key can file two calls
under one row or fabricate a trail that never happened. The value of an audit trail
is that the audited party did not write it.

`res.locals.requestId` has exactly one origin — `requestIdMiddleware`, first in the
v1 stack. The audit sink and the error handler are consumers; neither mints its own.

**Async handlers must be wrapped in `asyncRoute`.** Express is pinned at 4.22.1,
which does not forward rejected promises: an unwrapped `async` handler that throws
hangs the request until something times out, and no error middleware ever sees it.
The wrapper is what keeps the envelope covering the most common failure path.

## The route-fitness harness — read before writing a route test

`api/v1/routeFitness.ts` enumerates every route mounted under `/api/v1` from the
live app and runs each registered assertion against all of them. Testing Scenario 4
(PRD p.5) is four checks over every route, owned by four lanes:

| clause | assertion | owner | status |
|---|---|---|---|
| (a) | the route has an OpenAPI entry | **L13** | seam ready |
| (b) | the route declares a scope | **L03** | seam ready |
| (c) | failures ship the `ApiError` envelope | **L07** | implemented (`envelopeAssertion.ts`) |
| (d) | list endpoints paginate with an opaque cursor | **L08** | implemented (`paginationAssertion.ts`) |

**Do not write a second route walk.** Three enumerators means three different
definitions of "every route", and the subtly wrong one is the one that passes.
Register your clause instead:

```ts
import { registerRouteAssertion } from '../api/v1/routeFitness.js';

registerRouteAssertion('L03 (b): every route declares a scope', ({ route }) => {
  if (!scopeForRoute(route)) throw new Error(`${route.method} ${route.path} declares no scope`);
});
```

then call `runRouteAssertions(app)` from your spec and assert it returns `[]`.
Assertions may be async, so a clause can issue real requests. `route.handlers`
exposes the raw handler chain for clauses that need to inspect middleware.

`envelopeAssertion.ts` is L07's clause and is registered through the same public
seam rather than wired in privately — it is the worked example to copy.

**Always assert the enumeration is non-empty before believing a pass.** A harness
that enumerates nothing asserts nothing and reports green; that is the one failure
mode which would make all of this theatre.

## Pagination — where the line falls (L08 PF-227)

**A collection endpoint backed by a database table paginates with an opaque
cursor. A collection whose cardinality is bounded by CODE returns `{ data }` with
no `next_cursor` key.**

The test is **bounded-by-code vs. bounded-by-data**, deliberately not "small vs.
large". "Small" is a judgement about today's data that nothing re-checks: a list
of seven feels small, and if it were seven rows in a table then "small" would be a
fact about the current contents rather than a property of the endpoint, and the
day it stopped being true nothing would tell us. A list whose length is a
compile-time constant cannot grow into a pagination bug, because growing it means
editing this repository.

| Endpoint | `list` | Why |
|---|---|---|
| `/api/v1/documents`, `/issues`, `/sprints` | `'cursor'` | rows in `documents` |
| `/api/v1/scopes` | `'none'` | `SCOPES` in `scopes/registry.ts`, an `as const` array |
| `/api/v1/events` | `'none'` | L14's event-type registry, likewise |
| single-resource GETs, every write | `false` | not a collection |

This is not a convention you remember — it is `routeMetadata.declare()`, the field
is **required with no default**, and `createApp()` throws at wiring time naming
`METHOD /path` if a mounted route has no record. A default would make "nobody
thought about pagination" indistinguishable from "this route does not paginate",
and clause (d) below is precisely the check that those are different things.

The declaration is one record per route carrying **every** lane's per-route
metadata — L03's `scope` and L08's `list` on the same object. Two registries would
be two lists that can disagree about which routes exist, and a route missing from
one of them is a route its clause silently skips.

**Cursor contract**, for anyone consuming it: opaque base64url over
`{ id, timestamp, resource }`, keyset over `(created_at, id)` newest-first, page
size `limit` (default 25, max 100, **rejected not clamped** above the max), and
`next_cursor` **present and null** on the last page. The parameter name and the
three numbers are ours — the PRD names none of them.

## The boundary contract

Two rules. Both are mechanical — a violation fails `pnpm lint`, it is not caught in
review.

1. **`platform/**` may not import `api/src/routes/**`.**
   The internal route files *are* the internal HTTP surface. Calling into one from the
   public layer would inherit its session/CSRF assumptions, its response shape and its
   error handling, and the public/internal split would be a naming convention rather
   than an architecture. Call the domain service the route calls.

2. **`platform/**` may not import `api/src/middleware/**`.**
   The public layer has its own stack — bearer auth, scope enforcement, token bucket,
   audit. The internal stack (`middleware/auth.ts`: session cookie + CSRF) does not
   apply to `/api/v1` and must stay byte-for-byte what Part 1 shipped.

A third rule lives outside this directory and belongs to the same contract:

3. **`integrations/**` may import only `@ship/sdk`**, and **`sdk/**` may not import
   anything from this repository at all.
   Integrations and the SDK are what a stranger installs. If a command needs something
   the SDK cannot do, that is an SDK gap — fix it there, never by importing server code.

The lint rules that implement all four fences are in `eslint.config.js`, section
"PlugForge boundary rules". Negative fixtures under `eslint-fixtures/` prove each rule
actually fires; `pnpm exec vitest run boundary-lint` (or the `boundary-lint` CI job)
asserts lint **fails** on each of them. A rule that never fires is an untested rule.

## Composition

Wiring happens in `api/src/app.ts` — the composition root, and the only file that
chooses production concretes (`api/src/deps.ts` → `productionDeps()`). Test wiring
(`testDeps()`) swaps in the in-memory implementations: no network, no wall clock.
