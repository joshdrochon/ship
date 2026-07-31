# Submission — ShipShape

Map of every deliverable to the file that contains it. Start here.

This is a fork of `US-Department-of-the-Treasury/ship` audited and improved against eight
measurement categories. **`README.md` describes the product; this file describes the work.**

**Live application:** https://shipshape-70uo.onrender.com
**Merged to `main` via merge request, gated on a green pipeline.**

---

## Results

Eight categories, all measured. Seven met their target; Category 3 met the brief's bar
("at least 2 endpoints") on two of four and the two misses are documented rather than
dropped.

| # | Category | Target | Before | After | |
|---|---|---|---:|---:|:-:|
| 1 | Type Safety | −25% violations | 1,009 | **741** | ✅ −26.6% |
| 2 | Bundle Size | −20% initial load | 2,144,744 B | **385,118 B** | ✅ −82.0% |
| 3 | API Response | −20% P95, ≥2 endpoints | 21.41 / 16.58 ms | **14.90 / 13.24 ms** | ✅ −30.4% / −20.1% |
| 4 | DB Queries | −20% on ≥1 flow | 50 queries | **37** | ✅ −26.0% |
| 5 | Test Coverage | 3 flaky + RCA | 3 flaky | **4 fixed** | ✅ |
| 6 | Error Handling | 3 gaps, ≥1 data loss | 3 open | **3 fixed** | ✅ |
| 7 | Accessibility | all Crit/Serious, 3 pages | 69 nodes | **10** | ✅ −85.5% |
| 8 | Terraform | local + Render, pinned | 0 of 9 pinned | **20 of 20** | ✅ |

**Category 3 is a partial and says so.** `/api/projects` (−8.6%) and `/api/documents`
(−2.6%) did not clear 20%. The root cause — response payload size rather than SQL — is in
`docs/audit/raw/cat3-bottleneck-analysis.md`.

---

## Deliverables

| Deliverable (brief p.10–11) | Where |
|---|---|
| **Audit Report** — baselines for all categories, methodology, tools, raw data | [`docs/audit/audit-report.md`](docs/audit/audit-report.md) · 2,410 lines |
| **Improvement Documentation** — before, root cause, fix, after, reproducibility × 8 | [`docs/improvements.md`](docs/improvements.md) |
| **Discovery Write-up** — 3 things learned, with file/line references | [`docs/discoveries.md`](docs/discoveries.md) |
| **AI Cost Analysis** — dev spend + reflection on AI for codebase comprehension | [`docs/ai-cost-analysis.md`](docs/ai-cost-analysis.md) |
| **Terraform Plan Review** — annotated plan, blast radius, drift demo | [`docs/audit/lane-8-annotated-plan.md`](docs/audit/lane-8-annotated-plan.md) · [`docs/audit/lane-8-drift-detection.md`](docs/audit/lane-8-drift-detection.md) |
| **Deployed Application** | https://shipshape-70uo.onrender.com |
| **Developer documentation** (Rule 8) | [`CHANGES.md`](CHANGES.md) + [`CHANGES/`](CHANGES/) — one file per category |
| Implementation Rules, verbatim from p.8–9 | [`docs/audit/implementation-rules.md`](docs/audit/implementation-rules.md) |

### Per-category detail

Each lane owns one category end to end: what changed, why the original was worse, the
tradeoffs accepted, and how to roll it back.

| | | | |
|---|---|---|---|
| [lane-1](CHANGES/lane-1.md) Type Safety | [lane-2](CHANGES/lane-2.md) Bundle | [lane-3](CHANGES/lane-3.md) API | [lane-4](CHANGES/lane-4.md) DB |
| [lane-5](CHANGES/lane-5.md) Tests | [lane-6](CHANGES/lane-6.md) Errors | [lane-6b](CHANGES/lane-6b.md) Regression | [lane-7](CHANGES/lane-7.md) Accessibility |
| [lane-8](CHANGES/lane-8.md) Terraform | | | |

---

## Reproducing the numbers

Every measurement script is committed. Before-sides are frozen at **`2fbc5a4`**, so any
figure above can be re-derived from a clean checkout rather than taken on trust.

```bash
docs/audit/scripts/count-type-violations.py     # Cat 1
docs/audit/scripts/measure-initial-load.py      # Cat 2
docs/audit/scripts/bench-api-paired.sh          # Cat 3
docs/audit/scripts/run-cat4-paired.sh           # Cat 4
docs/audit/scripts/measure-a11y.py              # Cat 7
docs/audit/scripts/measure-terraform.py         # Cat 8
```

Raw output for both sides lives in [`docs/audit/raw/`](docs/audit/raw/).

Two tools exist because measurement itself was the hard part:

- **`scripts/measure-lock.sh`** — a filesystem mutex serialising benchmarks across ten
  parallel worktrees. A benchmark taken while five agents compile measures the load, not
  the change.
- **`scripts/assert-tests-ran.sh`** — exits **2** when zero tests run, distinct from 1, so
  "the run was void" can never be misread as "tests ran and failed." It caught a 2-of-3 run
  that would otherwise have read as a partial pass.

---

## Verification

```
pnpm type-check · pnpm lint · pnpm build     exit 0
pnpm test                                    553 passed   (api)
pnpm --filter @ship/web exec vitest run      227 passed   (web)
pnpm test:e2e                                871 executed · 865 passed · 0 failed · 0 did not run
```

Six E2E tests are flaky (green on retry) and each is attributed against
`docs/audit/raw/known-flakes.txt`. The flake count rose from 3 to 6 and **that is not
claimed as an improvement** — two explanations fit and the run cannot separate them.

### CI

Rule 4 requires build, lint, type-check, test, coverage, `pnpm audit`, security scan, and a
source-code inventory. **All eight run and pass on both platforms.**

| | |
|---|---|
| [`.gitlab-ci.yml`](.gitlab-ci.yml) | **primary** — 8 jobs / 4 stages, the gate on this repo |
| [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | the same 8 checks, on the platform Rule 4 names literally |

Merge requests are gated: `only_allow_merge_if_pipeline_succeeds` is enabled, and every MR
into `main` waited for green.

### On the GitLab runner

**This instance has shared runners disabled**, so no pipeline could execute at all —
they queued as `pending` indefinitely. Enabling shared runners was attempted through the
API with Owner rights and the setting does not persist; it is controlled at the instance
level.

The project therefore registers **its own project-scoped runner** (Docker executor,
`node:22-bookworm`), which is ordinary GitLab practice rather than a workaround. That is
what makes Rule 4 satisfiable here: a pipeline definition that has never executed is a
claim, not a result.

Pipeline history in GitLab is permanent, so the green runs remain visible whether or not
that runner is currently connected.

**Documented deviations** (Rule 4 permits these with written justification):

- **Platform.** Rule 4 names GitHub Actions; p.10 requires a GitLab repository. Both
  pipelines exist rather than one being traded away — GitLab is the gate on the submitted
  repo, GitHub satisfies the rule as literally written. If the two ever disagree,
  `.gitlab-ci.yml` wins.
- `comply` is not installable in the CI image; `gitleaks` is substituted. It scans full
  history — 617 commits, no leaks.
- High/moderate advisories are recorded but not gated. Only **critical** blocks, and that
  count is **0**.

---

## Cold start

One command, no manual steps beyond Docker (Rule 6):

```bash
./start.sh
```

Details in [`README.md`](README.md#cold-start--one-command).

---

## A note on how to read this

Several numbers here are smaller than an earlier draft claimed, because they were
re-measured and corrected. Those corrections are left visible in
[`docs/improvements.md`](docs/improvements.md) rather than quietly overwritten:

- **Category 7** is −85.5%, not −89.9%. The larger figure compared against the audit's
  baseline, taken at a different seed volume on a different day.
- **Category 1** hit its target, silently lost it at 758 after a merge — over the 756
  ceiling, with type-check, lint, build and 553 unit tests all green — and was restored to
  741 by removing 17 `as any` mocks rather than by editing a count.
- **Category 4's** baseline is 50, not the 48 in the frozen baseline file, because the pair
  ran against a different database. −26.0% is computed against what was measured.

A measured near-miss reported plainly is more useful than a pass that cannot be
substantiated.
