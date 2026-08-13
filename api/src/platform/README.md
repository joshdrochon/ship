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

## The public OpenAPI spec (L13)

**`GET /api/v1/openapi.json` is generated at boot and served without credentials.**
It is not hand-written and there is no file to edit: every operation is produced by
the same `declareV1Route()` call that mounts its Express handler, so a route cannot
exist without appearing in the spec and cannot appear in the spec without existing.
`platform/openapi/specParity.ts` asserts both directions over the live router.

| Fact | Where |
|---|---|
| Registry (public, 3.1) | `platform/openapi/registry.ts` — **never** `api/src/openapi/`, which is internal, 3.0, and holds ~130 detached `registerPath()` calls (F12) |
| One-call registration | `platform/api/v1/declareV1Route.ts` → `platform/openapi/operations.ts` |
| Served at | `platform/openapi/route.ts`, mounted through `createPublicRouter`'s `mountUnauthenticated` hook |
| Committed copy | `docs/openapi.json`, written by `pnpm openapi:public`. **Not** `pnpm openapi:generate`, which writes the internal 3.0 spec to `api/openapi.json` |
| Schema validation | `platform/openapi/schemaValidation.ts`, `@hyperjump/json-schema` against `oas/3.1/schema-base` |

**Generation failure at boot refuses the boot.** `createApp()` throws and the process
exits non-zero rather than serving `/api/v1` without its contract. *This is our
decision, not the PRD's* — p.12 only requires the architecture document to answer the
question, and `docs/architecture.md` answers "the process refuses to start". The
defensible alternative is boot-and-serve-503 on the spec route alone, so an unrelated
schema bug cannot take the whole API down mid-demo.

**What the spec route bypasses, and what it does not — read this before filing a bug
against L11 or L12.** It is mounted above `bearerAuth`, which also puts it above the
rate limiter but **below** the audit layer, because F7 moved audit above bearer auth
so that 401s and 429s are audited.

| Layer | Spec route | Why |
|---|---|---|
| `requestIdMiddleware` | applies | it is inside the v1 stack, not mounted on the app |
| `publicAuditMiddleware` | **applies** | a spec fetch writes an audit row with a null `clientId`/`userId` — there is no token to attribute it to |
| `bearerAuth` | bypassed | MVP item 10: a grader cannot resolve a spec that 401s |
| `rateLimitMiddleware` | **bypassed, deliberately** | the buckets are keyed `app:` and `token:`; an anonymous request has neither key, so there is nothing to bucket against. A per-IP bucket is a different limiter with different semantics that no lane owns and the PRD never asks for. The endpoint serves one cached object with no database access |

`route.test.ts` asserts each row of that table, so the exemption cannot quietly widen.

## Two secrets, two treatments — and why that is not an inconsistency (L15 PF-424)

`oauth_apps.client_secret_hash` is a **SHA-256 hash**.
`webhook_subscriptions.secret_ciphertext` is **AES-256-GCM ciphertext**.

The one sentence that explains it: **a client secret is presented back to us and can
therefore be verified by comparing digests, so hashing costs nothing; a webhook signing
secret is used by us to produce a MAC and is never presented, so hashing costs
everything and buys nothing.**

PRD p.3 says the signing secret is *"hashed"*, and p.12's Failure Modes row asks what
happens when *"a subscriber's signing secret is rotated mid-flight"* — which presumes
the server re-signs each attempt with the subscription's current secret. HMAC-SHA256 is
symmetric and a hash is one-way, so the two requirements are not in tension, they are
mutually impossible. That contradiction is the PRD's and is filed as **C3** in
`tickets/plugforge/lane-99-unassigned.md`.

The tempting non-answer — store `sha256(secret)` and sign with *that* — satisfies the
word and is theater: whatever the server signs with **is** the key, so a database dump
forges signatures either way, and it silently breaks p.7's printed
`verifyWebhook(headers, rawBody, secret)` unless the SDK hashes internally.

| | `client_secret` | webhook signing secret |
|---|---|---|
| At rest | SHA-256, unsalted (D1) | AES-256-GCM, key in `WEBHOOK_SECRET_KEY` |
| Key material in the DB? | n/a — one-way | **no**, environment only |
| Shown raw | once, at create and rotate | once, at create and rotate |
| Identified afterwards by | `secret_prefix` (8 chars) | `secret_prefix` (8 chars) |
| Recoverable | never | by the server, with the env key, and by nothing else |
| Rotation | instant invalidation (D3) | instant invalidation (PF-433) |

`WEBHOOK_SECRET_KEY` is resolved **lazily**, on first use. A deployment missing it boots
and serves every other route; creating a subscription or signing a delivery throws with
the reason. Eager resolution would make one missing variable a total boot failure, which
is a worse outcome than a scoped one — but the failure is still **closed**: nothing is
ever delivered unsigned.

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

## Rate limiting — the three decisions (L11)

The limits themselves are configuration and live in `api/src/deps.ts` (PF-309); this
section records the three judgement calls the PRD does **not** make for us, with the
options that were rejected. All three are policy, not bugs — disagreeing with one is a
change with a documented predecessor, not a defect report.

### What `X-RateLimit-Reset` means (PF-307)

A token bucket has no window boundary, so "reset" has to be *defined*. The shipped
answer is split by outcome:

| response | `X-RateLimit-Reset` is | why |
|---|---|---|
| allowed | unix seconds at which the bucket is **full** again | a client being served wants to know when it can resume its normal rate |
| 429 | unix seconds at which **one** token is available | the earliest useful retry, and it agrees with `Retry-After` |

Rejected:

- **Seconds-remaining rather than an epoch.** Every `X-RateLimit-Reset` in the wild is
  an epoch, and `Retry-After` already carries the relative form on the one response
  that needs it.
- **One-token-available on allowed responses too.** While a bucket is serving, that is
  identical to *now* — which is what the L01 sketch returned (`ceil(now/1000)`) and is
  information a client already has.

Both branches are strictly in the future and rise monotonically as the bucket drains.

### What counts as a "public API response" for the p.6 100% target (PF-313)

PRD p.6 targets **100% of public API responses** carrying the three headers. Taken
literally that includes responses the per-app/per-token limiter never runs for, because
something above it answered first: a 401 from bearer auth, a 404 on an unmatched
`/api/v1` path, and `/api/v1/openapi.json`, which is mounted above bearer auth by
design (PF-216) and which L13 measured (finding F45) as bypassing the limiter entirely.

**Shipped: option (b) — an unauthenticated fallback bucket keyed by client IP**,
mounted as `v1_anon_rate_limit` above both the unauthenticated mount and bearer auth.
The literal 100% becomes true, and those responses carry a real decision rather than a
back-filled placeholder. It is also protection the surface wanted anyway: before it,
an anonymous caller could hammer the spec endpoint and the 401 path with no limit at
all.

Rejected:

- **(a) Scope the target to authenticated responses and document the deviation.**
  Defensible, and it is what we would have written down if (b) had been expensive. It
  is not — one middleware and one bucket — and it leaves the spec endpoint unthrottled.
- **(c) A header-emitting shim that runs first and back-fills from the decision when
  there is one.** The headers on a 401 would then be a placeholder describing no
  actual limit. A number that does not correspond to a bucket is worse than a missing
  header, because a client will plan against it.

**The knock-on, stated rather than left to be found.** The anon bucket charges *every*
request, authenticated ones included, so its ceiling is configured deliberately **above**
the per-app ceiling (1200/min vs 600/min by default) — a backstop that binds before the
real limit is not a backstop. The residual caveat is real: a very large single-egress
deployment (one NAT, many users) can still meet it, and the fix there is to raise
`PUBLIC_RATE_LIMIT_ANON_PER_MINUTE` or to run the limiter off a header the load
balancer sets.

### Bucket state is per-process, and therefore per-instance (PF-315)

`InMemoryTokenBucket` keeps its buckets in a `Map` in one Node process. On the
single-service topology this deploys to, the configured limit **is** the real limit. On
N instances behind a load balancer it becomes **N × the configured rate**, because each
instance counts only the traffic it happened to receive.

This is not a defect to be discovered at defense; it is the cost of PRD p.10's
"Token-bucket in-memory must-ship". The mitigation is the interface, not the
implementation: `IRateLimiter` is what makes p.10's own alternatives —
`@upstash/ratelimit`, a Redis bucket, Cloudflare edge rules — a `productionDeps()` edit
rather than a rewrite. `peek` and `consume` are both single-key operations with no
in-process assumption, which is what keeps that true.

The same applies to eviction: `sweep()` drops only buckets that are provably at
capacity, so it can never loosen a limit, and `maxKeys` bounds the map without a
scheduler. Bucket keys include **token ids**, which rotate on every refresh (L06), so an
unbounded map was a real leak rather than a theoretical one.

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
