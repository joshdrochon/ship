# L07 · ApiError Shape & Error Middleware

| | |
|---|---|
| **Agent** | `api-errors` |
| **Tier** | 1 — runs concurrently with L02, L03 |
| **Block** | PF-186–210 (18 allocated, 7 reserved for audit) |
| **Blocks on** | L01 (PF-001 module tree, PF-009/PF-010 boundary lint) |
| **Unblocks** | L08 |
| **MVP gate** | Item 5 (p.2) — *"Consistent ApiError shape … asserted by a fitness test over all /api/v1 routes"* |

**Why this lane runs before any resource endpoint.** PRD Build Strategy §3 (p.11): *"Error shape
and ApiError class before any resource endpoint. Every /api/v1 failure must ship the same shape.
Build the fitness test that enumerates routes and asserts the shape — that's your TODO list for
E2."* The route-enumerating harness this lane builds is not a test of this lane's work; it is
shared infrastructure that L03, L08 and L13 hang their own assertions off (Testing Scenario 4,
p.5, has four clauses — this lane owns clause (c) and the enumerator all four run on). The public
error handler must also be **new code**: the internal `/api` surface has no error middleware at
all — 401 separate `res.status(…).json({ error: '…' })` call sites across `api/src/routes/*.ts`
and `api/src/middleware/auth.ts` do it inline. There is nothing to reuse, and reusing it would
leak the internal `{error: string}` shape into the public contract (p.3, Public API Boundary).

## Tickets

| ID | Title | Acceptance criterion | Advances | PRD | Deps |
|---|---|---|---|---|---|
| PF-186 | ☑ `ApiErrorCode` closed union, derived from one data array | `API_ERROR_CODES` in `platform/api/v1/errors.ts` deep-equals exactly `['unauthorized','forbidden','not_found','validation_failed','rate_limited','server_error']`; `ApiErrorCode` is `typeof API_ERROR_CODES[number]` — a unit test asserts the array, so a hand-typed second copy of the union cannot drift | MVP-5 | p.7 | PF-001 |
| PF-187 | ☑ `ApiError` class — code, message, optional details, preserved cause | `new ApiError('not_found', m)` is `instanceof Error` with a usable stack; `.details` omitted (key absent, not `undefined`) when not supplied; an underlying error passed as `cause` is retained for logging but never serialized | MVP-5 | p.6, p.7 | PF-186 |
| PF-188 | ☑ Code → HTTP status map, exhaustive by construction | `STATUS_BY_CODE: Record<ApiErrorCode, number>` — omitting a code fails `pnpm type-check`; a test iterates `API_ERROR_CODES` and asserts a status for each. Fixes the PRD-mandated pairs: `unauthorized`→401, `forbidden`→403 (p.3), `rate_limited`→429 (p.4). **`validation_failed`→422 is our call, not the PRD's** — recorded with rationale in `docs/architecture.md` | MVP-5 | p.3, p.4, p.7 | PF-186 |
| PF-189 | ☑ `ApiErrorCode` → SDK `kind` mapping published as data | Exported `SDK_KIND_BY_CODE` maps the six codes onto the five SDK kinds (`auth \| rate_limit \| not_found \| validation \| server`, p.4); test asserts every code maps to exactly one kind and every kind is reachable. **The mapping is 6→5, not 1:1** — `unauthorized` and `forbidden` both collapse to `auth`; the stale "1:1" comment in `errors.ts` is corrected. L17 imports this, does not restate it | — | p.4, p.7 | PF-186 |
| PF-190 | ☑ `requestIdMiddleware()` mints a UUID per request, first in the v1 stack | `res.locals.requestId` is populated before bearer auth runs — proven by a 401 from an unauthenticated request still carrying a `request_id`; 1000 sequential requests yield 1000 distinct ids | MVP-5 | p.7 | PF-186 |
| PF-191 | ☑ `X-Request-Id` response header on every `/api/v1` response, success and failure | Fitness test asserts the header is present on 2xx **and** on every failure, and that on failures it string-equals the body's `request_id`. A grader reading a 500 can quote one id back to us | — | p.7, p.18 | PF-190 |
| PF-192 | ☑ Inbound `X-Request-Id` is ignored, never echoed | A request sending its own `X-Request-Id: attacker-chosen` receives a different, server-generated id in both header and body. **Decision: mint server-side always** — the id is an audit-trail key (p.4), and a client-controlled key lets a caller collide or forge rows. Documented in `platform/README.md` | — | — | PF-190 |
| PF-193 | ☑ `request_id` handoff contract to the audit sink (L12) | `res.locals.requestId` is the single origin; `PublicApiCallRecord.requestId` is never the `'unknown'` fallback for any request in the fitness test, including 401s and 500s. L12 reads this field and does not generate its own | — | p.4, p.18 | PF-190 |
| PF-194 | ☑ `apiErrorMiddleware()` — the one terminal handler, mounted last on the v1 router only | An `ApiError` thrown from any v1 handler returns its mapped status and the envelope; mounting is inside `createPublicRouter`, never on the internal app — a test asserts an internal `/api/documents` 500 still returns the legacy `{ error: 'Internal server error' }` byte-for-byte | MVP-5 | p.3 | PF-187, PF-188, PF-190 |
| PF-195 | ☑ `asyncRoute()` wrapper so rejected promises reach the handler | Express is pinned at **4.22.1**, which does not forward async rejections — an unwrapped `async` handler that throws hangs the request until timeout. Test: an async handler rejecting with `ApiError('not_found')` returns 404 + envelope in under 100ms. Every v1 handler is registered through the wrapper; a lint or fitness assertion catches a bare `async` handler | MVP-5 | — | PF-194 |
| PF-196 | ☑ Unhandled exception → `server_error` with nothing leaked | A handler throwing `new Error('connect ECONNREFUSED 10.0.0.4:5432 password=hunter2')` yields body `{code:'server_error', message:<fixed generic string>, request_id}` — assert the response text contains none of: the original message, `stack`, a file path, or a `details` key. The same test asserts the server log **does** contain the original error and the `request_id` | MVP-5 | p.2, p.3 | PF-194 |
| PF-197 | ☑ Unknown `/api/v1/*` path → `not_found` envelope, not Express's HTML 404 | `GET /api/v1/does-not-exist` returns `content-type: application/json`, status 404, a schema-valid envelope and an `X-Request-Id`. Express's default HTML 404 page is what ships without this and it violates "every public failure" | MVP-5 | p.2, p.3 | PF-194, PF-190 |
| PF-198 | ☑ `details` policy — per-code, documented, enforced | Answers Pre-Search 2.2 (p.16) explicitly. **Decision: the envelope matches exactly across all routes; `details` is the only variable part, and its sub-shape is fixed per code, not per route.** `validation_failed` MUST carry `details.fields[]`; `forbidden` MUST carry `details.missing_scope` (p.3 requires the 403 name it); `rate_limited` MAY carry `retry_after_seconds`; `unauthorized`, `not_found`, `server_error` MUST omit `details`. Written into `platform/README.md`; PF-199 enforces it | MVP-5 | p.3, p.16 | PF-187 |
| PF-199 | ☑ `apiErrorBodySchema` (Zod, `.strict()`) is the single assertion oracle | The serializer in the middleware and the fitness test import the **same** schema — no second copy of the shape anywhere in the repo (grep proves one definition). `.strict()` rejects an extra top-level key; a discriminated union on `code` enforces the PF-198 per-code `details` rules | MVP-5 | p.6, p.7, p.16 | PF-198 |
| PF-200 | ☑ `enumerateV1Routes(app)` — the reusable route enumerator | Returns `{method, path}` for every route mounted under `/api/v1`, walking nested routers, with no hand-maintained list. Proof it is not stale-able: a test mounts a throwaway route on a test app and asserts it appears in the enumeration without any edit to the harness | MVP-5, TS-4 | p.5, p.11 | PF-194 |
| PF-201 | ☑ Fitness test: every enumerated route ships the envelope on a failure path | For each route from PF-200, an unauthenticated request returns a body that passes `apiErrorBodySchema` with `code: 'unauthorized'`. Test fails (not skips) when the enumeration is empty — an empty enumerator passing vacuously is the failure mode that makes this whole lane theatre | MVP-5, TS-4 | p.2, p.5, p.11 | PF-200, PF-199 |
| PF-202 | ☑ Harness exposes registration seams for Testing Scenario 4 clauses (a)(b)(d) | `registerRouteAssertion(name, fn)` lets L13 (OpenAPI entry), L03 (declares a scope) and L08 (cursor pagination if a list endpoint) add their clause without forking `enumerateV1Routes`. A no-op assertion is registered in-repo to prove the seam runs; the harness README names the owning lane per clause | TS-4 | p.5 | PF-200 |
| PF-203 | ☑ One negative test per code, produced by a real request | A table in the spec file maps each of the six codes to a concrete request that produces it end-to-end (not a synthetic `throw`). Codes whose producing route lands in another lane (`forbidden`→L03, `validation_failed`→L09, `rate_limited`→L11) are `test.todo` naming that lane; the test **fails** if any code has neither a live case nor a todo — so no code silently goes unexercised | MVP-5 | p.5, p.7 | PF-201 |

## Slices

One branch and one PR per slice, per PRD p.12. Branch name is `pf/L07-<slug>`; the PR body names
the acceptance criterion each slice advances and confirms its fitness test passed.

| Slice | Branch | Tickets | Advances | Fitness test |
|---|---|---|---|---|
| S1 | `pf/L07-error-type` | PF-186–189 | The closed six-code contract exists as data, with status and SDK-kind mappings derived from it | Unit: `API_ERROR_CODES` deep-equals the p.7 union; status map and kind map exhaustive over it |
| S2 | `pf/L07-request-id` | PF-190–193 | `request_id` originates in one place and reaches body, header, and audit row | Unauthenticated 401 carries a `request_id`; header equals body; audit record never `'unknown'` |
| S3 | `pf/L07-error-middleware` | PF-194–197 | Every v1 failure — thrown, rejected, unhandled, or unrouted — leaves in the envelope | Async rejection → 404 envelope; secret-bearing throw → scrubbed `server_error`; unknown path → JSON not HTML |
| S4 | `pf/L07-details-policy` | PF-198–199 | `details` variance is bounded and machine-checked (Pre-Search 2.2 answered) | `apiErrorBodySchema.strict()` rejects extra keys and wrong per-code `details` |
| S5 | `pf/L07-fitness-harness` | PF-200–203 | MVP gate item 5: the shape asserted over **all** /api/v1 routes, with seams for L03/L08/L13 | Route enumerator picks up a newly mounted route unaided; shape assertion runs over every route; six-code negative table complete |

## Notes for the audit agent

Read the full PRD, not just the pages cited above. Known thin spots, and the calls made so you
can confirm or refute rather than rediscover:

- **`details` policy (PF-198) is a decision, not a PRD requirement.** Pre-Search 2.2 (p.16) asks
  the question — *"will some routes carry richer details? If both, where is the line and is it
  documented?"* — and does not answer it. We answered: envelope identical everywhere, `details`
  sub-shape fixed **per code**, never per route. The p.3 requirement that a 403 name the missing
  scope forces `details` to exist at all, so "no details ever" was not available. If the audit
  finds a route that needs route-specific `details`, that is a policy change, not a bug fix.
- **`validation_failed` → 422 is ours.** The PRD names statuses only for 401 (p.2, p.3), 403
  (p.3) and 429 (p.4). The one `400` in the PRD (p.2) is `invalid_grant` on `/oauth/token`, which
  is RFC 6749's error format on a **non-`/api/v1`** route and is *not* an `ApiError` — the code
  union has no `invalid_grant`. Confirm L04/L05/L06 are not trying to route OAuth errors through
  this envelope; if they are, that is a cross-lane finding for `lane-99-unassigned.md`.
- **`request_id` ownership vs L12.** Decided: generated here (PF-190), in the first middleware of
  the v1 stack; L12's audit sink is a **consumer** via `res.locals.requestId` and generates
  nothing. The current `platform/audit/audit.ts` stub has an `?? 'unknown'` fallback — PF-193
  asserts that branch is unreachable for v1 requests, but it does not delete the fallback. If the
  audit pass thinks the fallback should be an assertion failure instead, say so; that is a
  deliberate soft edge, not an oversight.
- **PF-195 (`asyncRoute`) has no PRD citation** and is marked `—`. It comes from a verified repo
  constraint: `api/package.json` pins `express` at `4.22.1`, which does not forward async handler
  rejections. If L08 or L09 register handlers without the wrapper, the envelope silently stops
  applying to the most common failure path in the codebase. Worth re-verifying the pin at audit.
- **The enumerator (PF-200) is load-bearing for three other lanes** and is the single point where
  Testing Scenario 4 can go vacuously green. PF-201 asserts a non-empty enumeration for that
  reason. Check that L13's spec-parity test and L08's pagination test actually consume
  `registerRouteAssertion` rather than writing their own walk — three enumerators means three
  different definitions of "every route."
- **Not covered here, on purpose:** the `ApiError` schema's appearance as a reusable OpenAPI
  component (L13), the 403 body actually naming the missing scope (L03 produces it, we only fix
  its shape), and rate-limit headers on 429 (L11). If any of those is unowned at audit time, it
  goes to `lane-99-unassigned.md`, not into this file.
- An `errors.ts` stub already exists on disk from L01's scaffolding with roughly PF-186/187/188/
  190/194/196/197 sketched in. It is a sketch: no Zod schema, no `details` policy, no async
  wrapper, no enumerator, a stale "1:1" SDK-mapping comment, and `randomUUID()` duplicated as a
  fallback inside the error handler. Do not mark those tickets done because the file exists.
