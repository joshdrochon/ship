# FleetGraph — Engineering Requirements

Verbatim from the Week 5 brief (`GFA_Week_5_FleetGraph_Updated.pdf`, p.4). This file is the
committed record the `implementation-rules-check.py` hook points at, so the rules travel with
the repository rather than living only in a PDF in someone's Downloads folder.

The source PDF is extracted to `.claude/prd/` (gitignored) by `.claude/hooks/extract-prd.sh`.
The citation hook re-hashes it on every check, so a stale extraction reports itself.

> The following requirements apply to all FleetGraph implementations. They are graded
> alongside the agent functionality and are not optional.

---

## 1. Regression tests with rollback

> Every agent behaviour defined in your use cases must have a corresponding regression test.
> If a CI run fails, the deployment must be rolled back automatically — do not allow a failing
> build to remain deployed. Document the rollback trigger and procedure in FLEETGRAPH.md.

**Reading:** six use cases in `PRESEARCH.md` Q9 means six regression tests, minimum. The
rollback is automatic and CI-triggered — not a documented manual procedure someone follows.

## 2. End-to-end tests for critical user workflows

> Write E2E tests covering both the proactive and on-demand modes. At minimum: (1) an event
> is introduced into Ship and the agent surfaces it within the detection latency window, and
> (2) a user invokes the agent from a context-aware chat interface and receives a grounded
> response. Both tests must run in CI.

**Reading:** test (1) is also how the < 5 minute detection latency goal gets proved — the brief
says elsewhere that latency "will be verified with a timed test run."

## 3. Mock external services using stable fakes

> Tests that call Ship APIs or LLM providers must use stable fakes or recorded fixtures — not
> live services — so they pass consistently in CI regardless of network state or API
> availability. The MVP requirement of "running against real Ship data" applies to the running
> agent; the test suite must be independently reproducible.

**Reading:** this resolves the apparent conflict with MVP requirement 6. The deployed agent
runs against real Ship data; the test suite never does. `mocks/bedrock-expectations.json` and
the `BEDROCK_ENDPOINT` override already implement this pattern.

## 4. Retries, timeouts, and circuit breakers

> All outbound calls from the agent (to Ship APIs, LLM providers, and any external tools) must
> implement explicit timeouts and retry logic with exponential backoff. The agent must degrade
> gracefully if Ship is unreachable — it should not crash or hang indefinitely. Document the
> retry strategy and fallback behaviour in FLEETGRAPH.md, and demonstrate graceful degradation
> in your Architecture Defense.

**Reading:** "all outbound calls" is every one — the Ship API client and the LLM client both.
`api/src/services/circuitBreaker.ts` already implements this for Bedrock at 3s connect / 20s
request / 3 attempts / 5-failure threshold / 60s cooldown. Reuse it; do not write a second one.

## 5. Developer documentation

> Maintain a CHANGES.md at the repo root documenting every significant addition: what was
> built, how to run and test it locally, and how to roll it back if it fails. This is separate
> from FLEETGRAPH.md and is written for the next engineer inheriting the codebase, not for
> graders.

**Reading:** audience is explicitly not the grader. `CHANGES.md` already exists from Week 4 and
continues rather than restarts.

---

## Still in force from the repository, not the brief

These are project standing rules, not Week 5 requirements. They did not expire.

- **Never `git commit --no-verify`.** See `/ship-security-compliance`.
- **No pushing straight to `main`.** Everything lands via a merge request.
- **`pnpm test` truncates the dev database** (`api/test/setup.ts:14`). Reseed before taking any
  measurement, or the number is taken against an empty database.
- **Never run `pnpm test:e2e` directly** — use `/e2e-test-runner`. 600+ tests crash the session.
- **The test database resets per spec file, not per test** (`e2e/fixtures/isolated-env.ts`).
