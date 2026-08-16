# Implementation Rules — Week 6 PlugForge

**These are the rules. They are not guidance and they are not negotiable.**

Source: `GFA_Week_6_PlugForge.pdf`, sha `81a3788d…`, 18pp. Extracted page text lives at
`.claude/prd/page-N.txt` (gitignored — third-party assignment text). Every citation below was
verified with `grep -l "<phrase>" .claude/prd/page-*.txt`, not inferred from `full.txt`, whose
whole-document reflow does **not** map to page numbers.

> **Grepping the page files: normalise whitespace first.** The extracted text is hard-wrapped,
> so a quoted sentence that spans a line break will not match a plain `grep -F`. Three of the
> quotes below were once reported as unsourced for exactly this reason. Use:
>
> ```
> for f in .claude/prd/page-*.txt; do tr -s ' \n\t' ' ' < "$f" | grep -qF "<phrase>" && echo "$f"; done
> ```

Predecessor: Week 4 ShipShape's 11 rules are archived at
`docs/audit/archive/implementation-rules-week4-shipshape.md`. They governed a
measure-and-improve audit. Week 6 is a build, so the rule set is different in kind — these are
contract-integrity rules, not improvement-proof rules.

**Read this file after every code change**, before reporting anything as done.

---

## How this file is structured, and why it is not a flat list

PRD p.11 is **8 + 6**: eight numbered Build Strategy priority rules, then six Critical Guidance
bullets. This file mirrors that shape rather than merging it, because a flat 1–12 list makes an
omission invisible — a reader counting eight priority rules can see that eight are here. Part A
and Part B below are p.11 as written. Part C holds the rules this project derives from other
pages; they are numbered separately so nothing in Part C can be mistaken for p.11 text.

---

## Part A — Build Strategy: the eight priority rules (p.11)

All eight. None dropped. Quoted phrasing is p.11's; the "In this repo" line is ours.

**A1. OAuth foundation FIRST.** *"Without working tokens and scope checks, nothing else has a
contract."* Authorization Code + PKCE end-to-end against a Playwright-driven browser on Day 1,
**negative tests (wrong verifier rejected) included**. Device Authorization Grant the same day.
→ In this repo: `api/src/platform/oauth/`; the negative case is Part C rule C4.

**A2. Public/internal API boundary on Day 1.** `/api/v1/` is a fresh router that does **not**
share middleware with the internal API. *"Add the lint rule that fails the build on
cross-imports before you have any cross-imports to lint. This decision is far cheaper to enforce
than to retrofit."*
→ In this repo: `eslint.config.js` fences 1–5, each with a negative fixture under
`eslint-fixtures/` that `pnpm lint:boundary` asserts actually fails.

**A3. Error shape and `ApiError` class before any resource endpoint.** *"Every /api/v1 failure
must ship the same shape. Build the fitness test that enumerates routes and asserts the shape —
that's your TODO list for E2."*
→ In this repo: `api/src/platform/api/v1/errors.ts`; the enumerating fitness test is
`routeFitness.ts`.

**A4. OpenAPI generated from route metadata, never hand-written.** Get the generator working
end-to-end with **one** resource (documents) before adding issues, sprints and me. *"The fitness
test that asserts spec ↔ route parity is the single best defense against drift."*
→ In this repo: `api/src/platform/openapi/registry.ts`.

**A5. Webhooks end-to-end on Day 4.** The seven slices, in order: *"event registry → event bus →
subscriptions → signer → queue deliverer → delivery log → replay."* The signer (HMAC-SHA256 with
Stripe-style timestamp) *"has its own unit test suite — positive, negative, replay, tamper."*
→ In this repo: `api/src/platform/webhooks/`; the signer suite is `signer.test.ts` +
`signatureVectors.test.ts`.

**A6. SDK skeleton + one resource client + auth helpers next.** Iterate by having the CLI (E6)
consume the SDK as you build it. *"The SDK's worst bugs always surface when an actual consumer
compiles against it."*
→ In this repo: `sdk/src/`; the consumer is `integrations/cli/`.

**A7. CLI reference integration (must-ship).** *"The CLI is the proof the platform works."*
`ship login` (device flow), `ship docs create` (write through SDK + public API), `ship webhooks
tail` (the demo moment).

**A8. Developer portal + agent rewire (Epic 7).** Portal is should-ship and short — it consumes
the public API like any other client. *"The agent rewire is the architectural payoff: replace
direct service calls with SDK calls, behind a feature flag so Part 2's tests pass with the flag
on or off."*

> **A8 is proven in CI. This note used to say the opposite and was left stale.**
>
> p.17 asks *"How does CI prove Part 2's tests pass with the flag both on and off?"* The
> answer is the **`agent-flag-matrix`** job (`.gitlab-ci.yml`, `allow_failure: false`),
> which runs `scripts/agent-flag-matrix.sh`. Both legs, one run, most recently job 69165:
>
>     ── bucket 1, SHIP_AGENT_VIA_SDK=off ──   ok  leg off: 230/230
>     ── bucket 1, SHIP_AGENT_VIA_SDK=on  ──   ok  leg on:  230/230
>     PF-706 ok — bucket 1 is green in BOTH states, 230 tests per leg.
>
> The script carries two anti-vacuity guards, because a matrix that runs zero tests in one
> leg is green and means nothing: each leg asserts a **minimum test count**, and the two
> legs must run the **same file set**. `docs/l23-flag-matrix.md` remains the inventory of
> which tests are flag-sensitive; the job is the proof.
>
> **What this block said until 2026-08-16**, kept because the correction matters more than
> the tidiness: *"No CI job runs the suite in both flag states … `grep -n
> "SHIP_AGENT_VIA_SDK" .gitlab-ci.yml .github/workflows/*.yml` returns nothing … today the
> honest answer is that it does not."* That was true when written and stopped being true
> when the job landed in MR !27. The grep it cites now matches. A caveat nobody re-checks
> becomes a false claim the moment the gap it describes is closed — which is the same
> defect that cost this submission MVP gate item 9, where a correct +4.3% sat underneath a
> summary still reading "not established".

---

## Part B — Critical Guidance: the six bullets (p.11)

**B1. Public/internal split is a one-way door.** *"If you let routes from `/api/` leak into
`/api/v1/` 'just this once,' you have permanently damaged the contract. The lint rule is not
optional."*

**B2. Generate the OpenAPI spec; do not write it.** Every public route's request/response schema
lives in Zod adjacent to the handler; the generator walks them. *"Hand-written specs lie within a
week."*

**B3. Webhook in-memory deliverer for unit tests resolves synchronously.** The real queue-backed
deliverer is tested with deterministic clock injection — *"never with `setTimeout` waits in
tests. Timing-based webhook tests are flaky tests."*
→ Enforced by `retryClockFitness.test.ts`, which greps `platform/webhooks/**` for a bare
`setTimeout(`, `setInterval(`, `Date.now(` or `new Date()` outside `SystemClock`.

**B4. One LLM call per agent turn, period.** The platform never invokes the LLM. *"If you find
yourself wanting platform-layer AI features ('smart suggestions for OAuth scopes'), you're
scope-creeping."*

**B5. External integrations live in `integrations/` and import only `@ship/sdk`** — never
`api/src/`. Enforced by a workspace dependency rule. *"This is what makes 'the agent is a
platform citizen' true rather than aspirational."*
→ `eslint.config.js` fence 3 covers `integrations/**`; fence 5 extends the same rule to
`agent/**`, which predates the directory convention and was not moved.

**B6. Time-to-first-event drill in CI from Day 5 onward.** Once the SDK and one resource exist,
the drill exists. *"It will catch contract regressions faster than any unit test."*

---

## Part C — derived rules from other pages

Numbered separately from Part A/B on purpose: none of these is p.11 text.

**C1. Every `/api/v1` route satisfies all four contract properties**, asserted by a fitness test
that enumerates routes: (a) an OpenAPI entry, (b) a declared scope, (c) the `ApiError` shape on
failure paths, (d) cursor pagination if it is a list endpoint. (**p.5**, Testing Scenario 4)

**C2. Regression vs the Part 1 baseline: ≤ +10%** on P95 latency, bundle size and per-route
query counts. (**p.2**, MVP gate; **p.6**, Performance Targets)

**C3. The performance targets, as numbers.** OAuth Auth Code + PKCE round-trip P95 **< 3 s**;
webhook delivery latency P95, first attempt, **< 2 s**; OpenAPI spec parity **100%**; TTFE
**< 60 s** in CI and **≤ 30 min** on a clean machine. (**p.6**) SDK install size
**< 250 KB** minified + gzipped, production deps only; drill flake rate over 20 consecutive CI
runs **0%** — any flake is a bug in the drill or the platform, never something to retry past.
(**p.9**) Webhook signature verification in the SDK helper **< 1 ms per call**. (**p.8**)

> Corrected 2026-08-15: the 250 KB footprint and the 0% flake target were previously cited to
> p.8. Both are on **p.9**. p.8 carries the drill-stage table, the five-integration checklist
> and the signature-verification target.

**C4. Negative cases are mandatory, not optional.** p.5 says it in those words about PKCE: a
wrong `code_verifier` on the token exchange must return `invalid_grant` (*"negative case is
mandatory, not optional"*). The same standard applies to the webhook helper — a tampered body
must fail, and a timestamp older than 5 min must fail (**p.8**, drill-stage table). (**p.5**,
**p.8**)

**C5. Secrets are shown exactly once and never recoverable thereafter.** `client_secret` on app
creation and rotation, webhook signing secrets on subscription creation. A discarded secret is
not re-derivable; capture it at creation or the flow is dead. (**p.2**: *"client_secret hashed in
the database (raw secret shown exactly once on creation)"*)

> **At rest, `client_secret` is hashed and webhook signing secrets are encrypted, not hashed.**
> That is a knowing departure: p.3 says "hashed" while also requiring the secret be used to
> compute an HMAC, which a hash cannot do. Recorded as decision C3 in
> `docs/architecture.md` → Webhook Pipeline and in `docs/architecture-appendix.md`. Do not
> "fix" the encryption to a hash.

**C6. Expired tokens return 401 with a distinct error code.** MVP gate item 3: *"invalid tokens
return 401, missing tokens return 401, expired tokens return 401 with a distinct error code."*
(**p.2**)

> As shipped, the distinction is `details.reason` (`missing` | `invalid` | `expired`) plus a
> per-reason RFC 6750 `WWW-Authenticate` challenge, not a distinct `ApiErrorCode` member. The
> argument for reading that as satisfying the gate is written out in `docs/architecture.md` →
> Failure Modes and `api/src/platform/oauth/bearer.ts`. If a grader disagrees, the fix is one
> new code member, not a redesign.

**C7. Per-slice branches are preserved.** One branch per slice under `pf/LNN-<slug>`; the PR
description names the acceptance criterion the slice advances and confirms its fitness test
passed. Merged branches are graded evidence and are never pruned before Final Submission.
(**p.12**) Enforced by `.claude/hooks/guard-graded-branches.py` and `.husky/pre-push`. See
`POLICIES.md` §1 for the full mechanism list and for what this project did **not** satisfy.

---

## Standing repo traps

These are not from the PRD. They are this repository's own footguns, and they have each cost a
debugging session already.

- **Never `git commit --no-verify`.** Pre-commit runs `comply opensource`; skipping it is a
  security-compliance violation. Blocked by the PreToolUse guard.
- **`pnpm test` truncates the dev database** (`api/test/setup.ts:14`). Reseed before taking any
  measurement, or the next number is taken against an empty database.
- **Never run `pnpm test:e2e` directly** — 600+ tests crash the session. Use `/e2e-test-runner`.
- **The E2E database resets per spec *file*, not per test** (`e2e/fixtures/isolated-env.ts`).
  A test may rely on a sibling's state within a file, never across files.
- **Empty tests pass silently.** Use `test.fixme()` for unimplemented tests.
- **PostgreSQL comes from Docker on port 5433.** There is no host install, despite what
  `api/.env.local` implies.
- **`docs/architecture.md` is latched by fifteen test files** that read its prose. Edit it
  through the seam at `api/src/test/architectureDoc.ts` and run `pnpm test` afterwards; an
  earlier trim turned 62 tests red at once.
