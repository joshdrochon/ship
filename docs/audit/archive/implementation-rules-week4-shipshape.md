# Implementation Rules

**These are the rules. They are not guidance and they are not negotiable.**

Source: ShipShape Week 4 brief, p.8 (rules 1–5) and p.9 (rules 6–11). Reproduced verbatim —
the extracted page text is at `.claude/prd/page-8.txt` and `.claude/prd/page-9.txt` if you need
to check wording. Every rule below was diffed against those files.

They govern Phase 2, which p.8 opens with: *"Improve all 8 categories. Your audit report guides
your priorities, but you must deliver measurable improvement in every category. The passing
threshold for each category is defined by its Improvement Target above."*

**Read this file after every code change.** That is the first order of business, before
reporting anything as done. A change that violates a rule here is not an improvement — it is a
regression with better paperwork.

---

## The 11 rules, verbatim

1. **Before/After proof is mandatory.** Every improvement must include a reproducible benchmark
   or measurement showing the before state and the after state, run under identical conditions.

2. **Tests must still pass.** If any existing test breaks because of your change, you must
   either fix the test (with justification) or revert the change. Any change that causes a
   regression in the CI pipeline must be rolled back immediately — do not merge a PR that
   breaks the build or test suite.

3. **Regression tests are required.** Every bug or vulnerability found during the audit must
   have a corresponding regression test that would have caught it. Tests that mock external
   services must use stable fakes (not live external calls) so they pass consistently in CI
   regardless of network conditions.

4. **CI pipeline required.** Add GitHub Actions workflows that run on every PR and commit:
   build, lint, type-check, test, coverage, dependency audit (pnpm audit), and security scan.
   All checks must pass before a PR can merge. Dependency versions must be pinned in
   package.json and lockfiles committed. Produce a source-code inventory as part of the CI run
   — a list of all packages, their versions, and their license. Any deviation from required
   checks must be documented with written justification.

5. **Build/release/run separation.** Build artifacts (compiled output, Docker images) must be
   produced once and promoted through environments — never rebuilt per environment. The
   artifact produced in CI must be the artifact that runs in production. Tag each artifact with
   the git commit SHA for provenance. Document the artifact lifecycle in your dev docs.

6. **One-command local start.** Write a script (e.g. ./start.sh or a Makefile target) that
   starts the full composed system locally — app, database, and any mock external services —
   with a single command from a clean checkout. This script must be documented in the README
   cold-start guide and must work without any manual setup steps beyond installing dependencies.

7. **Retries, timeouts, and circuit breakers.** Assess the existing codebase for missing retry
   logic, hardcoded timeouts, and missing circuit breaker patterns on outbound service calls
   (database, WebSocket, external APIs). Add or improve these where gaps are found. Document
   each change with the failure mode it protects against.

8. **Dev documentation required.** Every addition or improvement you make must be accompanied
   by developer documentation. This is separate from the audit report and improvement
   documentation — it is written for the next engineer who inherits this codebase. At minimum:
   what was added, how to run it, how to test it, and how to roll it back if it breaks. Store
   this in a CHANGES.md file at the repo root.

9. **Document your reasoning.** For each improvement, write a short explanation of: what you
   changed, why the original code was suboptimal, why your approach is better, and what
   tradeoffs you made.

10. **No cosmetic changes.** Renaming variables, reformatting code, or updating comments do not
    count as improvements unless they directly support a measurable change in one of the 7
    categories.

11. **Commit discipline matters.** Each improvement should be in its own branch or clearly
    separated commit(s) with descriptive messages. We will read your git history.

---

## Checks to run against a change before calling it done

Derived from the rules above. This section is ours, not the brief's.

| Rule | The question to answer | Evidence that settles it |
|---|---|---|
| 1 | Was the *same* script run before and after? | Two runs of one named script, both committed |
| 2 | Does the full suite still pass? | `pnpm test` output, plus `web/` tests — they are not in `pnpm test` |
| 3 | Does a test exist that would have caught the bug? | The test fails on the pre-fix commit |
| 4 | Do CI checks cover build, lint, type-check, test, coverage, `pnpm audit`, security scan, licence inventory? | The workflow file |
| 5 | Is the artifact built once and tagged with the commit SHA? | Dockerfile + CI, plus the lifecycle written down |
| 6 | Does one command start app + database from a clean checkout? | `./start.sh` run against a fresh clone |
| 7 | What failure mode does each retry/timeout/breaker protect against? | Named per change |
| 8 | Is it in `CHANGES.md` with run, test, and rollback steps? | The file |
| 9 | Is the reasoning written — what, why the original was worse, tradeoffs? | Commit body or `CHANGES.md` |
| 10 | Does this change move a measured number? | The number, before and after |
| 11 | Is it separable in git history? | One branch or clearly scoped commits |

### Traps specific to this repository

Each of these has already caused a wrong number in this project. They are recorded so the same
mistake is not paid for twice.

- **`pnpm test` truncates the dev database** (`api/test/setup.ts:14`, no `.env.test` exists).
  Reseed after every unit run, or the next measurement is taken against an empty database.
- **`pnpm test` is api-only.** 151 `web/` tests never run under it, and 13 of them fail. Rule 2
  is not satisfied by a green `pnpm test`.
- **Arithmetic on a measurement is not a measurement.** Rule 1 says *"run under identical
  conditions"* — re-run the tool, do not scale a previous figure.
- **`docker logs` returns the whole history.** Segment by markers *and reset*, or counts
  accumulate across runs. This inflated Category 4 by 4× once already.
- **`du -sh` measures disk allocation, not content.** Use actual byte counts for bundle size.
- **Never `git commit --no-verify`.** `comply` is not installed, so the secrets scan skips with
  a warning — that warning is not permission to bypass the hook.

### One known discrepancy in the brief

Rule 4 says **GitHub Actions**. The submission target is a **GitLab** repository (p.10:
*"Forked repo with all improvements on clearly labeled branches"*), and this fork's origin is
GitLab. Treating rule 4 as GitLab CI (`.gitlab-ci.yml`) with the same seven checks. The rule
text above is left exactly as written; this note records the interpretation rather than
silently editing the requirement.
