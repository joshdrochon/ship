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
