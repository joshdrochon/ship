# Implementation Rules — Week 6 PlugForge

**These are the rules. They are not guidance and they are not negotiable.**

Source: `GFA_Week_6_PlugForge.pdf`, sha `81a3788d…`, 18pp. Extracted page text lives at
`.claude/prd/page-N.txt` (gitignored — third-party assignment text). Every citation below was
verified with `grep -l "<phrase>" .claude/prd/page-*.txt`, not inferred from `full.txt`, whose
whole-document reflow does **not** map to page numbers.

Predecessor: Week 4 ShipShape's 11 rules are archived at
`docs/audit/archive/implementation-rules-week4-shipshape.md`. They governed a
measure-and-improve audit. Week 6 is a build, so the rule set is different in kind — these are
contract-integrity rules, not improvement-proof rules.

**Read this file after every code change**, before reporting anything as done.

---

## The rules

### Contract integrity

1. **The public/internal split is a one-way door.** No route or handler under `/api/v1/` may
   import from `api/src/routes/` or internal middleware. The lint rule ships *before* there is
   anything to lint. *"If you let routes from `/api/` leak into `/api/v1/` 'just this once', you
   have permanently damaged the contract. The lint rule is not optional."* (p.11)

2. **Generate the OpenAPI spec; never write it.** Every public route's request/response schema
   lives in Zod adjacent to the handler; the generator walks them. *"Hand-written specs lie
   within a week."* (p.11)

3. **Every `/api/v1` route satisfies all four contract properties**, asserted by fitness test:
   an OpenAPI entry, a declared scope, the `ApiError` shape on failure paths, and cursor
   pagination if it is a list endpoint. (p.5)

4. **`integrations/` imports only `@ship/sdk`** — never `api/src/`. Enforced by a workspace
   dependency rule. *"This is what makes 'the agent is a platform citizen' true rather than
   aspirational."* (p.11)

### Test discipline

5. **No `setTimeout` waits in webhook or retry tests.** The queue-backed deliverer is tested
   with deterministic clock injection. *"Timing-based webhook tests are flaky tests."* (p.11)

6. **Negative cases are mandatory, not optional.** A wrong `code_verifier` must return
   `invalid_grant`; a tampered webhook body must fail verification; an expired timestamp must
   fail. The PRD names the PKCE negative test as mandatory in so many words. (p.5)

7. **The TTFE drill runs in CI from Day 5 onward.** Once the SDK and one resource exist, the
   drill exists. *"It will catch contract regressions faster than any unit test."* (p.11)
   Drill flake rate target over 20 consecutive runs is **0%** — any flake is a bug in the drill
   or in the platform, never something to retry past. (p.8)

### Budgets — these are numbers, not aspirations

8. **Regression vs the Part 1 baseline: ≤ +10%** on P95 latency, bundle size, and per-route
   query counts. (p.2, p.6)

9. **SDK install footprint < 250 KB** minified + gzipped, production deps only, enforced in CI.
   Webhook delivery P95 < 2s first attempt. OAuth Auth Code + PKCE round-trip P95 < 3s.
   TTFE drill < 60s in CI. (p.6, p.8)

10. **The platform does zero AI work.** One LLM call per agent turn, and only on user-initiated
    turns. *"If you find yourself wanting platform-layer AI features ('smart suggestions for
    OAuth scopes'), you're scope-creeping."* (p.11)

### Secrets and evidence

11. **Secrets are hashed at rest and shown exactly once** — `client_secret` on app creation and
    rotation, webhook signing secrets on subscription creation. Never recoverable thereafter.
    A discarded secret is not re-derivable; capture it at creation or the flow is dead. (p.2)

12. **Per-slice branches are preserved.** One branch per slice under `pf/LNN-<slug>`; the PR
    description names the acceptance criterion the slice advances and confirms its fitness test
    passed. Merged branches are graded evidence and are never pruned before Final Submission.
    (p.12) Enforced by `.claude/hooks/guard-graded-branches.py` and `.husky/pre-push`.

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
