# L11 · Rate Limiting

| | |
|---|---|
| **Agent** | `ratelimit` |
| **Tier** | 3 — runs concurrently with L09, L12 |
| **Block** | PF-301–325 (20 allocated, 5 reserved for audit) |
| **Blocks on** | L08 (public router composition order); consumes L07 PF-186/188/194/198 and L03 PF-067 |
| **Unblocks** | — (L17's `kind: 'rate_limit'` mapping is L07's `SDK_KIND_BY_CODE`, not ours) |
| **MVP gate** | Indirect — no MVP checkbox names rate limiting. The 429 **body** is MVP item 5's problem, and this lane is where the only `rate_limited` producer in the codebase lives |

**Why this lane exists and what it is graded on.** p.4 requires *"Per-app and per-token
token-bucket limits"* with `X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset` on public
responses and `Retry-After` on 429s. p.10 fixes the implementation: *"Token-bucket in-memory
must-ship"*, with `@upstash/ratelimit`, Redis, or Cloudflare edge rules as alternatives — so the
in-memory bucket is the deliverable and `IRateLimiter` is what makes the alternatives a
composition-root swap rather than a rewrite. The measurable target is on **p.6**, not p.5:
*"Public API responses with rate-limit headers"* → **100%**. That number is the reason half this
lane is about responses the limiter never sees.

**The boundary problem is live, not hypothetical.** `api/src/app.ts:168` mounts
`app.use('/api/', apiLimiter)` — an `express-rate-limit` instance. Express prefix-matching means
that mount **already covers `/api/v1/*`**. Measured against `express@4.22.1` + `express-rate-limit@8.2.1`
as pinned in `api/package.json`:

```
GET /api/v1/documents (3rd req, max=2)
  429  ratelimit-limit: 2 · ratelimit-policy: 2;w=60 · ratelimit-remaining: 0 · ratelimit-reset: 60 · retry-after: 60
  body {"error":"Too many requests. Please slow down."}
```

Three violations in one response: the internal `{error: string}` shape on a public route (p.3,
*"Public routes live only at /api/v1"*), a second header family (`RateLimit-*`, no `X-` prefix)
that is not the one p.4 names, and a short-circuit above the public router — so no `request_id`,
no envelope, no audit row. The internal limiter is **not** reusable across the boundary; it has to
be excluded from it (PF-316). Nothing here changes internal `/api` behaviour (PF-317).

## Tickets

| ID | Title | Acceptance criterion | Advances | PRD | Deps |
|---|---|---|---|---|---|
| PF-301 | ☐ `IRateLimiter` + `RateDecision` are the only contract the router knows | `platform/ratelimit/limiter.ts` exports `IRateLimiter { consume(key): RateDecision }`; a test substitutes an `AlwaysDenyLimiter` and a `NullLimiter` into `createPublicRouter` with no edit to router or middleware — the Liskov proof that the p.10 alternatives (`@upstash/ratelimit`, Redis bucket, Cloudflare edge) are a composition-root swap | — | p.10, p.12 | PF-001 |
| PF-302 | ☐ `InMemoryTokenBucket` — continuous refill, injected clock, **no default clock** | Constructor takes `{capacity, refillPerSecond}` and a `Clock` as a **required** argument. The current sketch defaults to `new SystemClock()`, which lets a test silently read wall time and go flaky; removing the default makes that a type error | — | p.10 | PF-301, PF-017 |
| PF-303 | ☐ Bucket arithmetic proven over `FakeClock`, never `setTimeout` | Table test: a burst of exactly `capacity` is allowed and `capacity+1` denied; after `advance(1000/refillPerSecond)` exactly one more is allowed; tokens never exceed `capacity` after an idle hour; `remaining` is a non-negative integer at every step. Zero `setTimeout` in the spec file | — | p.10 | PF-302 |
| PF-304 | ☐ Per-app and per-token are two independent limiters with disjoint key namespaces | Two `IRateLimiter` instances, keyed `app:<appId>` and `token:<tokenId>`. Proof both directions: exhausting token A's bucket leaves token B (same app) serving; exhausting the app bucket denies every token under it. One shared instance would make these indistinguishable, which is the failure this ticket exists to prevent | — | p.4 | PF-302 |
| PF-305 | ☐ A denied request must not spend the other bucket | The sketch calls `perApp.consume()` and `perToken.consume()` unconditionally, so a request the **app** bucket rejects still burns a per-token token — a client that is app-limited quietly loses its own quota too. Fixed by peek-then-commit (or refund). Test: with the app bucket empty and the token bucket full, 50 rejected requests leave `token:` remaining unchanged | — | — | PF-304 |
| PF-306 | ☐ `Retry-After` comes from the bucket that actually denied, and is the max when both did | The sketch picks the decision with the lower `remaining`, which can select an **allowed** decision whose `retryAfterSeconds` is `null` and then falls back to `?? 1`. Test: app bucket needs 30 s to refill while the token bucket is allowed → `Retry-After: 30`, never `1`. `Retry-After` is an integer ≥ 1 second on every 429 | — | p.4 | PF-305 |
| PF-307 | ☐ **Decision:** what `X-RateLimit-Reset` means for a bucket that has no window | A token bucket has no window boundary, so "reset" needs a definition. Today the code returns `ceil(now/1000)` for every allowed request — i.e. *now* — which is useless to a client. Options: (a) unix seconds at which **one** token is available (identical to now while allowed), (b) unix seconds at which the bucket is **full** again, (c) seconds-remaining rather than an epoch. **Lean: (b) for allowed responses, (a) for 429s** — a client that reads Reset wants to know when it can resume its normal rate, and on a 429 it wants the earliest retry. Recorded in `platform/README.md` with the rejected options; a test asserts a monotone, strictly-future value on an allowed response | — | p.4 | PF-302 |
| PF-308 | ☐ Bucket maps are bounded — idle buckets are evicted | `Map<string, BucketState>` keyed by token id grows for the life of the process, and token ids rotate (L06 refresh rotation). Sweep buckets that have been at full capacity for longer than `capacity/refillPerSecond`; a full bucket carries no state worth keeping. Test: 10 000 distinct keys consumed once, one sweep, map size returns to ~0 and limits still enforce correctly afterward | — | — | PF-302 |
| PF-309 | ☐ Limits are configuration chosen in the composition root, not constants in the module | `capacity` / `refillPerSecond` for both limiters come from env with documented defaults and are selected in `productionDeps()`; `testDeps()` supplies a tiny bucket so tests can exhaust it in a few requests. Grep proves no numeric literal limit inside `ratelimit/`. The env var names match what L21 declares in `variables.tf` | — | p.12 | PF-015, PF-016, PF-302 |
| PF-310 | ☐ All three `X-RateLimit-*` headers on every **allowed** public response | A 2xx from any `/api/v1` route carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, all integer-valued, with `Remaining` strictly decreasing across successive requests on one token. Header names are exactly the p.4 spelling — `X-` prefixed, not the `RateLimit-*` draft family `express-rate-limit` emits | — | p.4 | PF-304 |
| PF-311 | ☐ 429 body is the `ApiError` envelope, produced by L07's terminal handler | The limiter never writes a response: it calls `next(new ApiError('rate_limited', …))`. The 429 body validates against `apiErrorBodySchema` with `code:'rate_limited'` and a real `request_id`; per PF-198 it MAY carry `details.retry_after_seconds`, and if it does the value equals the `Retry-After` header | MVP-5 | p.2, p.4, p.7 | PF-186, PF-188, PF-194, PF-198 |
| PF-312 | ☐ Headers set before `next(err)` survive the error path | Headers are written with `res.setHeader` before the throw, and the error middleware must not clear them. Test asserts a real 429 response carries all four rate-limit headers **and** `X-Request-Id` — the regression this guards is an error handler that calls `res.writeHead` and drops everything set earlier | MVP-5 | p.4, p.7 | PF-311 |
| PF-313 | ☐ **Decision:** what counts as a "public API response" for the 100% header target | p.6 targets 100% of public API responses carrying rate-limit headers. Taken literally that includes responses the limiter never runs for: 401 from bearer auth (rejects first), 404 on an unmatched `/api/v1` path, and 500. Options: (a) scope the target to authenticated responses and document the deviation, (b) an unauthenticated fallback bucket keyed by client IP so every `/api/v1` response is limited and therefore headed, (c) a header-emitting shim that runs first and back-fills from the decision when there is one. **Lean: (b)** — it makes the literal 100% true, and an unauthenticated bucket is protection the public surface wants anyway; (a) is defensible only if written down. Decision recorded in `platform/README.md` and in `docs/architecture.md` | — | p.6 | PF-310 |
| PF-314 | ☐ Fitness test: 100% header coverage over enumerated routes × response classes | Built on L07's `enumerateV1Routes` via the `registerRouteAssertion` seam — no second route walk. For every enumerated route it drives 2xx, 401, 404 and 429 and asserts the three headers on each response class the PF-313 decision includes. **Fails, not skips, on an empty enumeration** — a vacuously green 100% is the exact way this target gets faked | — | p.5, p.6 | PF-200, PF-202, PF-313 |
| PF-315 | ☐ Single-process scope of the limiter is stated, not assumed | `platform/README.md` records that bucket state is per-process and therefore per-instance: on the single-service Render topology the limit is the real limit; on N instances it becomes N× the configured rate. The mitigation is the interface (PF-301), and the p.10 alternatives are named as the swap. A limit that silently multiplies by replica count is the kind of thing a grader asks about at defense | — | p.10 | PF-301 |
| PF-316 | ☐ The internal `express-rate-limit` mount must not reach `/api/v1` | `app.use('/api/', apiLimiter)` (`api/src/app.ts:168`) matches `/api/v1/*` today — measured: 429 with body `{"error":"Too many requests. Please slow down."}` and `ratelimit-*` headers, above the public router, so no envelope, no `request_id`, no audit row. Fix so the internal limiter cannot see `/api/v1`. Test: a v1 429 never carries a bare `RateLimit-Limit` header and never the legacy `{error}` body, at any request volume | MVP-5 | p.3, p.4 | PF-311 |
| PF-317 | ☐ Internal `/api` limiting is byte-for-byte unchanged | The login limiter (5/15 min, `skipSuccessfulRequests`) and the general `/api` limiter (100/min prod, `API_RATE_LIMIT_MAX` override) keep their limits, their `standardHeaders: true` draft headers and their `{error}` message. Diff on the internal limiter config is empty apart from the mount path; the existing Playwright regression suite passes via `/e2e-test-runner` | MVP-9 | p.2, p.3 | PF-316, PF-018 |
| PF-318 | ☐ A 429 is still audited — the limiter sits **after** the audit middleware | `rateLimitMiddleware` short-circuits with `next(err)`, so anything registered after it never runs. In the current `router.ts` sketch the audit middleware is registered *after* the limiter, which means a rate-limited request writes no audit row. The declared composition order (owned by L08) puts audit first; this ticket asserts the consequence: exhausting a bucket produces exactly one audit record with `status: 429`. L12 asserts the same fact from its side | — | p.4, p.12 | PF-311 |
| PF-319 | ☐ Limiter position asserted on the composed router, not read off the source | A test builds the real public router and proves position by behaviour: an invalid token yields 401 with no rate-limit consumption (auth is upstream), and a valid token over the limit never reaches the handler (handler spy uncalled). p.13's interview question — *"Why is each a separate middleware?"* — is answerable only if the order is a tested property | — | p.12, p.13 | PF-318 |
| PF-320 | ☐ `rate_limited` negative case, produced by a real request, closes L07's todo | PF-203 leaves `rate_limited` as a `test.todo` naming this lane. Replace it with a live case: a token bucket of capacity 1 in `testDeps()`, two requests, second returns 429 + envelope + `Retry-After` + `X-RateLimit-Remaining: 0`. Satisfies Testing Scenario 4 clause (c) for the one failure path no other lane can produce | TS-4 | p.5, p.7 | PF-203, PF-311, PF-316 |

## Slices

One branch and one PR per slice, per PRD p.12. Branch name is `pf/L11-<slug>`; the PR body names
the acceptance criterion each slice advances and confirms its fitness test passed.

| Slice | Branch | Tickets | Advances | Fitness test |
|---|---|---|---|---|
| S1 | `pf/L11-bucket` | PF-301–303 | `IRateLimiter` + deterministic in-memory token bucket (p.10 must-ship) | Burst/refill table over `FakeClock`; substitute limiters swap without touching the router |
| S2 | `pf/L11-two-keys` | PF-304–309 | Per-app **and** per-token limits that are correct under denial, with bounded memory and configured limits | Sibling-token isolation both directions; app-denied request leaves token bucket untouched; `Retry-After` from the denying bucket |
| S3 | `pf/L11-headers` | PF-310–315 | Rate-limit headers on public responses and the p.6 100% target defined and measured | Header fitness test over the enumerator × response classes; fails on empty enumeration |
| S4 | `pf/L11-boundary-and-order` | PF-316–320 | The 429 is a public-contract response: right envelope, right position, audited, negative-tested | v1 429 carries no legacy header/body; exhausted bucket writes one audit row at 429; internal suite green |

## Notes for the audit agent

Read the full PRD, not just the pages cited above. Known thin spots and the calls made, so you can
confirm or refute rather than rediscover:

- **`Advances` is mostly `—` in this lane, on purpose.** No MVP checkbox and no Testing Scenario
  names rate limiting. The four cells that carry a criterion earn it through the *shape* of the
  429 (MVP-5), the untouched internal surface (MVP-9), and Testing Scenario 4 clause (c) (PF-320).
  The 100% header target is a **Performance Target on p.6**, which the spine's convention does not
  treat as an acceptance criterion. If you think p.6 should count as gradeable, that is a spine
  change — raise it against `TICKETS-PLUGFORGE.md`, not by editing cells here.
- **The p.6 citation is p.6, not p.5.** `Public API responses with rate-limit headers · 100%` is in
  the Performance Targets table on page 6. Testing Scenarios are page 5. `full.txt` reflows the two
  tables close together; grep the page files.
- **The internal-limiter finding is measured, not inferred.** `app.use('/api/', apiLimiter)` in
  `api/src/app.ts` was run against the pinned `express@4.22.1` / `express-rate-limit@8.2.1` and
  confirmed to fire on `/api/v1/documents`, returning `{"error":"Too many requests. Please slow
  down."}` with `ratelimit-limit` / `ratelimit-policy` / `ratelimit-remaining` / `ratelimit-reset`
  and no `X-` prefixed headers. Re-run it before believing any claim that the mount is already
  scoped. The answer to "can the internal limiter be shared?" is **no, and worse — today it is
  shared by accident.**
- **Pre-Search 1.1 and 1.2 do not touch rate limiting.** 1.1's fanout bullet (p.15) asks at what
  fanout the *in-memory deliverer* misses the < 2 s P95 — that is L16's number, not ours. 1.2's
  runaway-cost bullet (p.15) is about the *webhook deliverer's queue*, also L16. Neither was
  stretched to fit this lane. The nearest true analogue is PF-308 (unbounded bucket map), which is
  a repo finding with no PRD citation and is marked `—` accordingly. If the audit wants a
  rate-limit-shaped ingress ceiling recorded in the Pre-Search, that belongs to L25 as a
  cross-lane finding, not here.
- **PF-307 and PF-313 are decisions, not requirements.** The PRD names the three header fields and
  a 100% target; it defines neither `Reset` semantics for a windowless bucket nor which responses
  the denominator includes. Both tickets state a lean and record the rejected options. If the audit
  disagrees with the lean, that is a policy change with a documented predecessor, not a bug.
- **Five sketch bugs are ticketed, not assumed fixed.** `platform/ratelimit/limiter.ts` exists from
  L01 scaffolding and already sets the three headers, which reads as done. It has: a default
  `SystemClock` (PF-302), unconditional double consume (PF-305), `binding` selected by lowest
  `remaining` so `Retry-After` can come from an allowed bucket (PF-306), `Reset` = now on allowed
  requests (PF-307), and an unbounded bucket map (PF-308). Do not mark those closed because the
  file compiles.
- **Ordering is L08's to declare, ours to assert.** PF-318/PF-319 do not mount anything; they
  assert positions in the router L08 composes. The current `router.ts` sketch has the limiter
  before the audit middleware, which silences the audit row for every 429 — if L08 ships that
  order, PF-318 fails and the fix is in L08's composition ticket, not here. L12 asserts the same
  invariant from the audit side by design; two lanes asserting it is intentional, since either one
  landing alone leaves the hole open.
- **Not covered here, on purpose:** the SDK's `kind: 'rate_limit'` mapping and client-side backoff
  (L07 `SDK_KIND_BY_CODE` + L17), rate-limit ceilings as Terraform env vars (L21 PF-625), showing
  per-app usage in the portal (L22), and the agent's rate limits being *the same* limits as any
  other app (p.1) — that is L23's assertion to make, using this lane's limiter unchanged. If any of
  those is unowned at audit time it goes to `lane-99-unassigned.md`, not into this file.
