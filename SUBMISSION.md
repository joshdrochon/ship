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
| 2 | Bundle Size | −20% initial load | 2,144,744 B | **386,072 B** | ✅ −82.0% |
| 3 | API Response | −20% P95, ≥2 endpoints | 1275.7 / 899.1 ms | **102.8 / 25.9 ms** | ✅ −91.9% / −97.1% |
| 4 | DB Queries | −20% on ≥1 flow | 50 queries | **37** | ✅ −26.0% |
| 5 | Test Coverage | 3 flaky + RCA | 3 flaky | **4 fixed** | ✅ |
| 6 | Error Handling | 3 gaps, ≥1 data loss | 3 open | **3 fixed** | ✅ |
| 7 | Accessibility | all Crit/Serious, 3 pages | 69 nodes | **10** | ✅ −85.5% |
| 8 | Terraform | local + Render, pinned | 0 of 9 pinned | **20 of 20** | ✅ |

**Category 3's row is at 50 simultaneous connections** — the load p.4 specifies — with both
builds running at the same instant against one database, 0% failures on either side. At the
low fixed arrival rate the first measurement used, the same two endpoints read −30.4% and
−20.1%; the server was ~97% idle there, so the fix barely showed. Both numbers are in
`docs/improvements.md` §3.

**It is still a partial and says so.** `/api/projects` and `/api/documents` clear 20% at no
concurrency level. The root cause — response payload size rather than SQL — is in
`docs/audit/raw/cat3-bottleneck-analysis.md`, whose own headline conclusion is marked
superseded there: it was drawn from two sequential runs on a loaded machine, and its
untouched control endpoint had drifted +23% in the same direction.

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

Every measurement script is committed. Every lane branches from the frozen commit
**`2fbc5a4`**, so any figure above can be re-derived from a clean checkout rather than taken
on trust. Four categories took their before-measurement at a descendant of the freeze that
adds measurement tooling and no application source — Cat 2 at `ecc2b15`, Cat 3 and Cat 5 at
`767aa2f`, Cat 4 at `c398a9c`. The per-category table is in
[`docs/improvements.md`](docs/improvements.md).

```bash
docs/audit/scripts/count-type-violations.py     # Cat 1
docs/audit/scripts/measure-initial-load.py      # Cat 2
docs/audit/scripts/bench-api-concurrency.sh      # Cat 3 at 10/25/50 simultaneous connections
docs/audit/scripts/bench-api-paired.sh          # Cat 3 at a fixed arrival rate
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
pnpm test                                    555 passed   (api, needs PostgreSQL)
pnpm --filter @ship/web exec vitest run      241 passed   (web)
scripts/check-type-violations.sh             742, at ceiling
pnpm test:e2e                                874 executed · see below
```

**`pnpm test` skips rather than fails without PostgreSQL.** With no database reachable it
reports `555 skipped` and exits non-zero on setup, which is easy to misread. Treat any run
that does not report `555 passed` as void.

**On the E2E line.** An earlier revision of this file read
`871 executed · 865 passed · 0 failed`. That was true of the tree it was measured on —
`c432768`, before the remediation branch landed — and it is not true of `main`. It is
corrected rather than quietly dropped.

Four post-submission changes are in `CHANGES.md` ("E2E truth"). Two were broken tests. One
bounds an unsaved-title window at 3 s and ships. **The fourth was shipped, measured, and
reverted** — it opened the CRDT path before the WebSocket connected, which sent a new
document's title into a client-only `Y.Doc` while the server stored `title = null`. On the
four specs that cover that path, `--workers=4 --repeat-each=3 --retries=0`: 6 failed / 72
with it, 0 / 72 without.

**Worker count must be pinned to compare two E2E runs.** `playwright.config.ts` derives it
from free memory at launch, so the same command ran at 1 worker and at 10 on the same tree
within an hour — a 24.5-minute serial run against a 6-minute run that left 47 tests
unexecuted. Set `PLAYWRIGHT_WORKERS` explicitly, and treat any run reporting
`did not run` as void.

**Latest complete run**, `PLAYWRIGHT_WORKERS=4 pnpm exec playwright test --retries=0`, all
874 accounted for, 7.7 min:

```
872 passed · 2 failed · 0 did not run
```

Both failures were `drag-handle.spec.ts:300` and `team-mode.spec.ts:408`, already in
`docs/audit/raw/known-flakes.txt`. Both are now fixed at the cause rather than retried
past:

| | cause | before | after |
|---|---|---|---|
| `team-mode` | the seed left exactly **one** person unassigned, and sibling tests assign `.first()` unassigned row under `fullyParallel` — assign that one and the group header stops existing | 6 failed / 195 | **0 / 195** |
| `drag-handle` | `expect(handle).toBeVisible()` followed by `page.$`, a one-shot query, on an element that exists only while hovered | (same run) | |

A third surfaced only under the CI configuration: `document-workflows.spec.ts` set a title
and slept a fixed 1 s. The client's fallback debounce on a new document is 1.5 s, so the
sleep expired before anything was written — the editor showed the title, the database did
not, and any assertion reading server data failed. It now waits on
`expectDocumentTitleSaved`, which polls the API. 20 of 20 on re-run.

`pnpm test:e2e` sets `retries: 1` locally and `2` in CI. The figures above use
`--retries=0` deliberately, because retries hide exactly this class of defect.

**E2E is now a blocking gate on both pipelines**, in the `verify` stage alongside `test`
and `coverage`. It runs against an ordinary Postgres service rather than testcontainers:
testcontainers needs a Docker daemon, reaching one inside a CI job means
docker-in-docker, and that needs a runner granting privileged mode — which made the gate a
property of one machine's configuration rather than of the commit. `E2E_DATABASE_URL`
switches `e2e/fixtures/isolated-env.ts` onto a database per worker; unset locally, so a
developer's run is unchanged. The job is wrapped in `scripts/assert-tests-ran.sh 874`, so a
worker that drops tests exits 2 instead of reading as a pass.

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
  ran against a different database. −26.0% is computed against what was measured — and 50
  is the *kinder* denominator of the two, since 48 → 37 is −22.9%. Both clear the 20% bar.

A measured near-miss reported plainly is more useful than a pass that cannot be
substantiated.
