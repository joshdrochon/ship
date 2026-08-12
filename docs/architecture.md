# Ship Platform Architecture — PlugForge (Week 6)

**Scope.** Ship (Part 1/2) becomes a platform: a versioned public API at `/api/v1/`, OAuth 2.0 (Authorization Code + PKCE, Device Grant), Stripe-style signed webhooks, a typed SDK (`@ship/sdk`), and the FleetGraph agent rewired from privileged insider to platform citizen. Modules marked **(new)** ship this week; unmarked paths exist today.

## Module Layout

```
api/src/platform/            (new) everything public-facing; imports domain services, never route files
  apps/                      oauth_apps registry — create/rotate/list; client_secret hashed (SHA-256, high-entropy), raw shown exactly once
  oauth/                     RFC 6749 Auth Code + 7636 PKCE + 8628 Device Grant; token issuance; one-time-use refresh tokens with family revocation
  scopes/                    ScopeRegistry — scopes-as-data (documents/issues/sprints × read/write, webhooks:manage) + require(scope) middleware factory
                             (public `sprints` maps onto Ship's internal `weeks` model at this layer — the contract name, not the table name)
  ratelimit/                 IRateLimiter + in-memory token bucket (per-app and per-token); emits X-RateLimit-* headers, 429 + Retry-After
  webhooks/                  event registry (Zod-typed, 8 types), IEventBus + InProcessEventBus, subscription matcher, HMAC signer,
                             IWebhookDeliverer, retry scheduler, delivery log, DLQ + replay
  api/v1/                    the ONLY public router — fresh middleware stack, ApiError envelope, opaque cursor pagination ({data, next_cursor})
  openapi/                   public OpenAPI 3.1 registry; generated from route metadata, served at /api/v1/openapi.json
  audit/                     public API call log — timestamp, app client_id, user_id, route, scope, status, latency; queryable in the dev portal
  clock.ts                   Clock / SystemClock / FakeClock — a file, not a module; the retry scheduler, the token bucket and OAuth expiry all read it
sdk/                         (new) @ship/sdk workspace package — see SDK Surface
integrations/cli/            (new) must-ship reference integration (ship login / docs / webhooks tail); imports ONLY @ship/sdk (workspace dep rule)
api/src/routes/, utils/      existing internal surface (/api/*) — session+CSRF auth, unchanged; domain logic in utils/document-crud.ts et al.
web/src/                     existing React UI; the (new) developer portal pages consume /api/v1 like any external client
agent/                       existing FleetGraph agent (LangGraph) — Epic 7 swaps its data path onto the SDK
```

The public/internal split is enforced mechanically, not by convention: an ESLint `no-restricted-imports` boundary rule fails the build if `api/src/platform/api/v1/` imports from internal route files, and `integrations/*` may depend only on `@ship/sdk`.

## SOLID Rationale

- **S — Single Responsibility.** Each platform concern is its own middleware module under `api/src/platform/` (authN in `oauth/`, authZ in `scopes/`, throttling in `ratelimit/`, recording in `audit/`). Domain logic stays where Part 1 put it (`api/src/utils/document-crud.ts`); the platform layer wraps it and never re-implements it.
- **O — Open/Closed.** `ScopeRegistry` (`platform/scopes/registry.ts`) and the event registry (`platform/webhooks/events.ts`) are data. Adding `sprints:write` or `sprint.completed` is a registration at module load — no middleware edit, no route audit. The 403 handler reads the registry to name the missing scope.
- **L — Liskov Substitution.** `InProcessEventBus` (must-ship) and a queue-backed bus are drop-in substitutes behind `IEventBus`; likewise `InMemoryDeliverer` (synchronous, for tests) vs. the HTTP deliverer behind `IWebhookDeliverer`. Tests assert against the interface contract, so swapping in BullMQ later is a composition-root change only.
- **I — Interface Segregation.** The SDK is resource-segregated: `client.documents`, `client.issues`, `client.sprints`, `client.webhooks` (`sdk/src/resources/`). A CLI that only tails webhooks compiles against exactly that client — not a 40-method god object.
- **D — Dependency Inversion.** Domain services publish through `IEventBus` and know nothing about HTTP delivery, signing, or retries; `app.ts` injects concretes. Same for `IRateLimiter`, `ITokenStore` (SDK side), and the clock the retry scheduler reads — which is what makes retry tests deterministic instead of `setTimeout`-flaky.

## Composition Root

`createApp()` in `api/src/app.ts` is today the single place the app is assembled (helmet → rate limit → session/CSRF → ~30 internal routers). PlugForge extends the same function — it stays the only file that chooses concretes:

```ts
export function createApp(deps = productionDeps()) {
  const { bus, deliverer, limiter, clock, db } = deps;         // injected concretes

  registerScopes(scopeRegistry);                               // scopes-as-data (OCP)
  registerEventTypes(eventRegistry);                           // 8 Zod-typed event types

  const signer   = new HmacSigner();                           // Ship-Signature: t=<unix>,v1=<hex-hmac>
  const retries  = new RetryScheduler(clock, [1, 4, 16, 60, 300, 1800]);  // seconds, + jitter
  const pipeline = new WebhookPipeline(bus, subsRepo(db), signer, deliverer, retries, deliveryLog(db));

  const v1 = createPublicRouter({                              // fresh router — shares NO middleware with /api
    auth:  bearerTokenMiddleware(tokenRepo(db)),               // invalid/missing/expired → 401, distinct codes
    scope: requireScope(scopeRegistry),                        // insufficient → 403 naming the missing scope
    limit: rateLimitMiddleware(limiter),                       // 429 + Retry-After; X-RateLimit-* on every response
    audit: publicAuditMiddleware(auditRepo(db)),
    error: apiErrorMiddleware(),                               // every failure → { code, message, details?, request_id }
  });

  app.use('/oauth', oauthRouter(appsRepo(db), tokenRepo(db), clock));  // concrete flows: authorize, token, device
  app.use('/api/v1', v1);                                      // public, versioned contract
  app.use('/api', internalRouters);                            // Part-1 surface, untouched
  app.get('/api/v1/openapi.json', serveGeneratedSpec());       // generation failure = boot failure (see Failure Modes)
  return app;
}
```

Sibling test wiring — same shape, in-memory concretes, no network and no clock:

```ts
// api/src/deps.ts — the sibling of productionDeps(), same shape, in-memory concretes
export const testDeps = (overrides: Partial<AppDeps> = {}): AppDeps => ({
  bus: new InProcessEventBus(),      deliverer: new InMemoryDeliverer(),   // resolves synchronously
  limiter: new InMemoryTokenBucket({ capacity: 100, refillPerSecond: 100 / 60 }),
  clock: new FakeClock(),  db: pool,  corsOrigin: 'http://localhost:5173',
  ...overrides,
});
createApp(testDeps());   // retry-schedule tests advance FakeClock; no setTimeout anywhere in tests
```

## Public/Internal Boundary

Both surfaces call the **same domain services**; auth/scope/rate-limit/audit/webhook concerns attach only at the public layer. Internal `/api` keeps its session+CSRF stack (`api/src/middleware/auth.ts`) byte-for-byte.

```mermaid
sequenceDiagram
    participant EXT as External app (@ship/sdk)
    participant V1 as /api/v1/documents
    participant PMW as bearer → require('documents:write') → bucket → audit
    participant SVC as documentService (utils/document-crud.ts)
    participant BUS as IEventBus
    participant UI as Ship UI
    participant INT as /api/documents (internal)

    EXT->>V1: POST /api/v1/documents (Bearer)
    V1->>PMW: platform middleware stack
    PMW->>SVC: create(workspaceId, input)
    SVC->>BUS: publish(document.created)  — domain publishes, never the route layer
    SVC-->>V1: document
    V1-->>EXT: 201 {data} + X-RateLimit-* · audit row written
    UI->>INT: POST /api/documents (session + CSRF)
    INT->>SVC: create(workspaceId, input)  — same service, same publish
```

Contract details asserted by fitness tests over every `/api/v1` route: OpenAPI entry exists, a scope is declared, failures ship the `ApiError` shape (`unauthorized | forbidden | not_found | validation_failed | rate_limited | server_error`), list endpoints paginate with opaque base64 cursors over `{id, timestamp}`.

### Error envelope decisions

The code set above is **closed at six** and is printed verbatim in the PRD (p.7). Three
things about it are ours to defend rather than the PRD's to dictate:

**`validation_failed` → 422, not 400.** The PRD names statuses only for 401 (p.2, p.3),
403 (p.3) and 429 (p.4). 422 is the honest code for the case: the request body parsed
fine, so the syntax was never in question — what failed is the semantics. The single
`400` in the PRD (p.2) is `invalid_grant` on `/oauth/token`, which is RFC 6749's error
format on a route that is not under `/api/v1` and is not an `ApiError` at all; the code
union deliberately has no `invalid_grant` member. Anyone reading a 400 from this API is
therefore reading an OAuth error, and anyone reading a 422 is reading a validation
error — the two never blur.

**The envelope is identical everywhere; `details` is the only variable part, and its
sub-shape is fixed per CODE, not per route.** `validation_failed` carries
`details.fields[]`; `forbidden` carries `details.{missing_scope, granted_scopes,
scope_description}` (p.2 requires the 403 to name the missing scope, which is what
forces `details` to exist at all); `rate_limited` may carry
`details.retry_after_seconds`; `unauthorized` may carry `details.reason` — a closed
enum of `expired | invalid | missing` that satisfies MVP gate item 3's "401 with a
distinct error code" without adding a seventh `ApiErrorCode` to a union the PRD prints
verbatim on p.7 (dispute B14); `not_found` and `server_error` omit
`details` entirely. Per-route detail shapes were available and were rejected: a consumer
that has to learn a different error body per endpoint has no envelope, only a
convention. `apiErrorBodySchema` (Zod, `.strict()`, discriminated on `code`) is the one
definition of this, and both the serializer and the fitness harness import it.

**Codes map 6 → 5 onto the SDK's `kind` union, not 1:1.** `unauthorized` and `forbidden`
both surface as `kind: 'auth'`, because the question an SDK consumer's `catch` block is
actually asking is "would a better token fix this?" — and for both, it would. The
mapping is published as data (`SDK_KIND_BY_CODE`) so the SDK imports it rather than
restating it.

**`request_id` is minted server-side, always, and an inbound `X-Request-Id` is ignored.**
It is the join key for the audit trail (p.4). A client-supplied key lets a caller collide
its rows with another app's, or forge a trail that never happened, and the value of an
audit trail is exactly that the audited party did not write it.

**A body-parser failure is a client error, not a server error.** `express.json()`
rejects an oversized or malformed body by calling `next(err)` with an error that is not
an `ApiError`, and the terminal handler correctly scrubs anything it does not recognise
into `server_error`/500. That is the wrong answer here and it costs a consumer real
time: 500 means "we broke, retry", so an SDK with a retry ladder retries a 2 MB body at
exponentially increasing intervals until it gives up. `bodyErrors.ts` translates them
into `validation_failed` with `details.fields[{ field: 'body' }]`. **422 and not 413** —
HTTP's answer is 413, but the code set is closed at six and the status is derived from
the code, so a 413 would require a seventh member of a union the PRD prints verbatim.
That is a real cost of the closed set, and it is recorded here rather than hidden: the
status is imprecise, the code and message are not.

### Pagination and versioning decisions (L08)

**Where the pagination line falls.** A collection endpoint backed by a database table
paginates with an opaque cursor; a collection whose cardinality is bounded by CODE
returns `{ data }` with no `next_cursor`. The test is **bounded-by-code vs.
bounded-by-data**, not small vs. large — "small" is a judgement about today's contents
that nothing re-checks, while a list whose length is a compile-time constant cannot grow
into a pagination bug without someone editing this repository. `/api/v1/scopes` and
`/api/v1/events` are `as const` arrays and declare `list: 'none'`; the document-backed
collections declare `'cursor'`. The field is required with no default and `createApp()`
throws at wiring time on a route that omits it, because "nobody thought about it" and
"it does not paginate" must not look the same to Testing Scenario 4's clause (d).

**The sort key is `(created_at, id)`, and it is not `position`.** The internal list sorts
by `ORDER BY position ASC, created_at DESC` over a column drag-reorder rewrites
(`api/src/routes/documents.ts:120`). Paginating on a mutable column means a user
reordering a sidebar corrupts a concurrent API walk, which is exactly what "cursors are
stable across reordering operations" (p.3) forbids. The keyset is a row comparison —
`(created_at, id) < ($1, $2)` — because the logically equivalent `OR` form plans as a
bitmap-or or a seq scan rather than an ordered index range scan; migration 063 ships the
covering index and `assertKeysetIndexed` EXPLAINs the real page query to keep it honest.

**Four things the PRD does not name, and our answers:** the page-size parameter is
`limit`; the default is 25; the maximum is 100; the order is newest-first. An
out-of-range `limit` is **rejected, not clamped** — clamping is the more common industry
choice and it turns the loop a CLI author actually writes,
`while (data.length === limit)`, into an infinite one. Query parameters are a **strict
allowlist**: `offset`, `page`, `per_page`, `fields`, `sort` and `order` each return 422
with a message pointing at what to use instead. That is a strong policy with a real cost
— a future optional parameter is a breaking change for a caller already sending it — and
it is the only cheap way to make "sparse fieldsets are out of scope" verifiable rather
than merely asserted.

**Versioning past `/api/v1/`: additive-only within v1; a breaking change goes to
`/api/v2/`; no deprecation or sunset headers this week.** Pre-Search 2.2 (p.16) poses the
question and offers three answers without choosing. Additive-only means a new optional
response field or a new endpoint may land in v1, while removing a field, renaming one,
narrowing a type, or tightening validation may not. Deprecation headers were rejected
because they are a promise about a lifecycle — a sunset date, a migration guide, a
support window — and by Sunday there are no external consumers to make that promise to.
Shipping the header without the lifecycle would be a claim the project cannot keep.
Enforced structurally rather than by convention: a test asserts the public router is
mounted at exactly one version prefix and that no registered route path contains a
second version segment.

## OAuth Flows

```mermaid
sequenceDiagram
    participant App as Registered web app
    participant B as Browser (user)
    participant AZ as /oauth/authorize
    participant TK as /oauth/token
    App->>B: redirect: client_id, scopes, code_challenge (S256)
    B->>AZ: login + consent screen
    AZ-->>B: 302 redirect_uri?code=…   (challenge + method stored server-side)
    App->>TK: POST code + code_verifier
    Note over TK: ★ PKCE validated HERE — S256(verifier) ≟ stored challenge.<br/>Mismatch → 400 invalid_grant (mandatory negative Playwright test)
    TK-->>App: access_token + refresh_token (one-time-use)
    App->>TK: POST grant_type=refresh_token
    Note over TK: ★ rotation HERE — new pair issued, old spent.<br/>Reuse of a spent refresh token revokes the whole family (theft signal)
```

```mermaid
sequenceDiagram
    participant CLI as ship CLI
    participant DC as /oauth/device/code
    participant U as User (any browser)
    participant TK as /oauth/token
    CLI->>DC: POST client_id, scopes
    DC-->>CLI: device_code, user_code, verification_uri, interval
    CLI-->>U: prints user_code + URL
    U->>DC: /oauth/device/verify — enters code, consents
    loop poll every `interval` s
        CLI->>TK: grant_type=urn:…:device_code
        TK-->>CLI: authorization_pending · slow_down (client backs off — honored, tested)
    end
    TK-->>CLI: access_token + refresh_token (same rotation rules as above)
```

Access tokens are opaque high-entropy strings stored hashed (same discipline as the existing `api_tokens` table); the bearer middleware resolves token → app + user + granted scopes on every `/api/v1/*` request.

## Webhook Pipeline

```mermaid
flowchart LR
    W["domain write<br/>(documentService.create)"] -->|publish| B["IEventBus<br/>(InProcessEventBus must-ship)"]
    B --> M["subscription matcher<br/>(active subs per event type)"]
    M --> S["signer ★<br/>HMAC-SHA256(secret, t + '.' + rawBody)<br/>Ship-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;"]
    S --> D["IWebhookDeliverer<br/>POST target_url"]
    D -->|2xx| L[("delivery log<br/>(every attempt: status, latency, excerpt)")]
    D -->|5xx / timeout| R["retry scheduler<br/>1s·4s·16s·1m·5m·30m + jitter"]
    R --> D
    D -->|4xx permanent, or 6th failure| Q[("dead-letter queue")]
    Q -->|portal replay ◆| B
```

★ **Signature is computed at send time, per attempt**, with the subscription's secret (hashed at rest, shown once on creation) — the timestamp in the signed payload is what defeats replay; the SDK verifier rejects signatures older than 300 s by default. ◆ **Idempotency-Key originates at the event's first delivery** (derived from `event_id`), and is carried unchanged through every retry and portal replay — that key is the subscriber's dedupe contract.

## SDK Surface

`@ship/sdk` (new workspace package). **Stable for the week:** `ShipClient` with resource clients (`documents`, `issues`, `sprints`, `webhooks` — method signatures fitness-tested against the OpenAPI spec, drift fails CI); `ShipClient.authorizationCodeFlow()` and `ShipClient.deviceLogin()`; async-iterator pagination (`for await (const doc of client.documents.iterate())` — consumers never see cursors); `verifyWebhook(headers, rawBody, secret, toleranceSec = 300)` → boolean in one call; typed error union discriminated on `kind: 'auth' | 'rate_limit' | 'not_found' | 'validation' | 'server'`. **Pre-1.0 (may move):** `ITokenStore` implementations beyond in-memory/file, OAuth helper option bags, CLI internals. Install footprint budget: < 250 KB min+gzip, production deps only, enforced in CI.

## Agent-as-Citizen (Epic 7)

Today FleetGraph is a privileged insider by construction — two separate back doors:

```mermaid
flowchart TB
    subgraph Before["BEFORE — privileged insider"]
        A1[FleetGraph agent] -->|"in-process import (api → @ship/agent,<br/>routes/fleetgraph/agentBridge.ts)"| API1[internal routes]
        A1 -->|"direct SQL — agent/src/data/pool.ts,<br/>boundary.ts"| DB1[(Postgres)]
    end
    subgraph After["AFTER — platform citizen"]
        A2[FleetGraph agent] -->|"@ship/sdk"| V1["/api/v1/*"]
        V1 -->|"bearer + scopes + rate limit + audit ★"| SVC[same domain services]
        SVC --> DB2[(Postgres)]
    end
```

The agent authenticates as a first-party OAuth app (seeded by migration, so it provably exists in deployed environments), requesting only the scopes its detectors and actions need — least privilege, not `*`. The swap lives behind a feature flag; CI runs the Part 2 regression suite with the flag **on and off**, which is what makes the rewire a refactor rather than a rewrite. ★ **The payoff is the audit trail:** every agent action now lands in the public audit log under the agent app's `client_id` — "the agent went through the front door" is provable with one query, not a claim. One LLM call per agent turn is unchanged; the platform itself does zero AI work.

## Failure Modes

**Token store corrupted (SDK side).** `ITokenStore` reads that fail or return garbage are treated as logged-out, never as a retry loop: the next call surfaces `{ kind: 'auth' }` and the helper flows re-authenticate cleanly. Corruption is a client-local event — the server sees at worst a 401'd request, and no partial credential is ever written back.

**Signing secret rotated mid-flight.** Rotation takes effect at the next delivery attempt: the signer reads the subscription's current secret at send time, so in-flight failures re-sign with the new secret on retry. A subscriber that hasn't updated its env verifies against the old secret, fails, and the retry ladder (30 min tail) covers the update window; the pathological case parks in the DLQ, replayable from the portal with the original Idempotency-Key.

**Queue deliverer crashes.** The contract is at-least-once + Idempotency-Key dedupe — never silent at-most-once. Undelivered attempts are reconstructable because the delivery log (durable, Postgres) records every attempt; on restart, incomplete deliveries are re-driven from the log/DLQ and subscribers dedupe on the key. The in-process must-ship deliverer restarts with the process; the queue-backed drop-in inherits the same recovery semantics through the log.

**OpenAPI generator throws at boot.** Fail fast: the process refuses to start. The spec is the contract artifact — serving traffic without it is exactly the drift the fitness test exists to prevent. In practice this never reaches production: spec generation + validation against the OpenAPI 3.1 schema runs as a unit test, and the spec↔route parity fitness test fails the PR first.

## Deployment Topology (Terraform)

Live topology is `terraform/render/main.tf` (pinned `render-oss/render` provider + lock file): one web service (Docker, health-checked at `/health`), managed Postgres, env groups, and the FleetGraph cron. **PlugForge adds zero new infrastructure resources in must-ship form** — OAuth apps, tokens, subscriptions, delivery log, and audit rows are Postgres tables inside the existing database, and the deliverer runs in-process. The Terraform delta is env-group entries only, so the destroy-redeploy drill's blast radius is unchanged: web service + database + cron, re-creatable from config alone (annotated plan: `terraform/render/PLAN-ANNOTATED.md`).
