# CHANGES

Developer documentation for changes made to this fork. Required by Implementation Rule 8
(brief p.9): *"what was added, how to run it, how to test it, and how to roll it back."*

Written for the next engineer who inherits this, not for a grader. Audit findings live in
`docs/audit/audit-report.md`; this file is only about what changed and how to undo it.

---

## Build once, promote — Rule 5 (closes audit finding F26)

**What was wrong.** Three independent builds of the same source existed and none
promoted any other, so nothing that ran anywhere was traceable to a commit:

| Build | Fate |
|---|---|
| GitLab CI `docker-image` → `$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA` | tag was invalid — **failed every `main` pipeline** |
| GitHub Actions `docker-image` | `push: false` — built, then discarded |
| Render, `runtime_source.docker` | cloned the branch and built its **own** image |
| `scripts/deploy.sh` | compiled on the operator's laptop, `VERSION="v$(date …)"` |

`/health` returned `{"status":"ok"}` with no version, so "which commit is in
production?" had no answer at all.

The GitLab failure was live, not theoretical. `$CI_REGISTRY_IMAGE` expands to the
empty string because **the GitLab instance runs no container registry** —
`labs.gauntletai.com/jwt/auth?service=container_registry` answers
`{"code":"UNAVAILABLE","message":"registry not enabled"}`, and the project's
`container_registry_image_prefix` is null. So the job ran
`docker build -t ":c432768…"` and died with `invalid reference format`, on five
consecutive `main` commits including HEAD. The other eight jobs were green and
this job only runs on `main`, so every lane branch looked clean while the default
branch was red.

**What changed.**

| File | Change |
|---|---|
| `Dockerfile` | `ARG GIT_SHA=unknown` → `LABEL org.opencontainers.image.revision` + `ENV GIT_SHA` |
| `api/src/app.ts` | `/health` returns `{"status":"ok","revision":"<sha>"}` |
| `api/src/routes/health.test.ts` | regression tests for the field and its `unknown` fallback |
| `.github/workflows/ci.yml` | **now the publisher** — builds, verifies provenance three ways, pushes `ghcr.io/joshdrochon/ship:<sha>` |
| `.gitlab-ci.yml` | builds with a valid local tag and asserts the SHA is inside the image; no longer pretends to publish |
| `terraform/render/main.tf` | `runtime_source.docker` → `runtime_source.image`; optional `render_registry_credential.ghcr` |
| `terraform/render/variables.tf` | `repo_url`/`branch`/`dockerfile_path`/`auto_deploy` removed; `image_repository`, `image_tag`, registry auth added |
| `terraform/render/outputs.tf` | `deployed_image`, `verify_deployed_revision` |
| `scripts/deploy.sh` | version label is `git rev-parse HEAD`; refuses a dirty working tree |
| `docs/artifact-lifecycle.md` | new — the lifecycle documentation Rule 5 requires |

**Registry: ghcr.io.** Not a preference — the GitLab registry does not exist (above),
and no credential fixes a service that is not deployed. ghcr.io needs **no credential
to be provisioned**: Actions issues `GITHUB_TOKEN` with `packages: write` to the job.
Pushing to ghcr.io *from* GitLab would have needed a long-lived GitHub PAT in a masked
CI variable, for the same result.

**The substantive fix is the Terraform one.** `runtime_source.image` means Render
pulls the image CI built instead of building a fourth one. A deploy becomes
`terraform apply -var image_tag=<sha>`; a rollback is the same command with an older
SHA. `image_tag` has no default and is validated `^[0-9a-f]{7,40}$`, so `latest` is
refused — a floating tag would re-open the exact question this change closes.

It also removes a Category 8 qualification. The git source required the Render account
to hold a GitHub OAuth consent for the private repo, which Terraform cannot create;
that is why `terraform/render/README.md` said "one credential and one prior consent"
rather than "deployable using only `terraform apply`". Pulling a published image needs
no repo connection.

### How to run it

```bash
# CI publishes on every push. To deploy a published commit:
cd terraform/render
terraform apply -var image_tag=<sha>

# Roll back
terraform apply -var image_tag=<older-sha>
```

`scripts/deploy.sh` (the AWS path) is unchanged in usage but now refuses to run with
uncommitted changes — commit or stash first. There is no override flag.

### How to test it

```bash
# Provenance reaches the image and the wire
docker build --build-arg GIT_SHA=test -t ship:test .
docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' ship:test   # test
docker run -d --name p -p 18080:80 -e SESSION_SECRET=x \
  -e DATABASE_URL=postgres://unused:unused@127.0.0.1:5432/unused ship:test node dist/index.js
curl -s localhost:18080/health    # {"status":"ok","revision":"test"}
docker rm -f p

# Local dev is unaffected — no build arg means no lie
docker build -t ship:nosha .
curl -s localhost:18081/health    # {"status":"ok","revision":"unknown"}

# Terraform
cd terraform/render && terraform validate && terraform fmt -check
terraform plan -var image_tag=latest    # refused by the validation rule

# Unit
pnpm --filter @ship/api exec vitest run src/routes/health.test.ts
```

All of the above were run except the last (the database was under a concurrent
benchmark). Results are in the report accompanying this change.

### How to roll it back

| To undo | Do this |
|---|---|
| Everything | `git revert <sha>` — the change is one commit and touches no schema |
| Just the Render promotion | Restore `runtime_source.docker` in `terraform/render/main.tf` and the four `repo_url`/`branch`/`dockerfile_path`/`auto_deploy` variables. Reintroduces the fourth build and the OAuth consent step. |
| Just the `/health` field | Revert the `revision` line in `api/src/app.ts` and the two new cases in `health.test.ts`. Note `terraform output verify_deployed_revision` then has nothing to compare against. |
| Just the dirty-tree gate | Delete the `git status --porcelain` block in `scripts/deploy.sh`. Keep the SHA version label — it is independent. |
| Just the ghcr.io push | Set `push: false` on the GitHub job. Render then points at a tag nobody publishes, so pin `image_tag` to a SHA already in the registry first. |

No migration to reverse. Full lifecycle documentation: `docs/artifact-lifecycle.md`.

---

## Accessibility, after Category 7 was closed

Per-category detail lives in `CHANGES/lane-*.md` and is indexed from `SUBMISSION.md`. This
one gets a line here because it is a **correction to a category that had already been
reported as done**, and someone reading only the root file should not miss that.

Category 7 scoped its scan and its fixes to *"the 3 most important pages"*, which is what
p.7 asks for. Five of its own findings sat outside that scope and were never fixed —
W7-6, W7-7, **W7-8** (eight pages titled "Ship | Ship", WCAG 2.4.2 Level A) and **W7-9**
(a nested `<main>`, no landmark on `/login`, a missing `<h1>`, an empty `<th>`) — and the
lane doc's "still open" table did not list them either. W7-8 and W7-9 are now fixed;
W7-6 and W7-7 are fixed in the e2e suite; **W7-11 is a deliberate non-fix**, recorded with
its numbers.

Reading every page instead of three then turned up three defect sets the audit never
recorded at all: 6 unnamed `<select>`s (one set on the page that grants workspace admin),
8 unnamed icon-only buttons (2 destructive), and an `<li>` in a `role="group"` tree.

**What changed, why the original was worse, the tradeoffs, and how to roll each piece
back: [`CHANGES/lane-7.md`](CHANGES/lane-7.md), §8–§11.** Audit findings, including the
three that were never in it and why they were missed: `docs/audit/audit-report.md`,
Category 7.

---

## Lane 0 — CI, one-command start, and the test suite that blocks them

**Why this went first.** Rule 2 says *"any change that causes a regression in the CI
pipeline must be rolled back immediately"* (p.8). There was no CI pipeline, and 13 of
`web/`'s 151 unit tests were already failing, so "tests still pass" could not be asserted
about anything. Nothing else could be proven until this existed.

### Measured before/after

Every number below comes from re-running the same command before and after. Commands are
in the "How to test" section so they can be reproduced.

| Metric | Before | After | How measured |
|---|---:|---:|---|
| `web/` unit tests passing | 138 / 151 | **152 / 152** | `pnpm --filter @ship/web exec vitest run` |
| `api/` unit tests passing | 451 / 451 | **451 / 451** | `pnpm test` |
| Critical dependency advisories | 3 | **0** | `pnpm audit --audit-level critical` |
| High / moderate / low advisories | 58 / 64 / 10 | **51 / 55 / 9** | `pnpm audit --json` |
| Lint errors | *no linter existed* | **0** (263 warnings) | `pnpm lint` |
| React hook-order violations | 9 | **0** | `pnpm lint` |
| CI checks | 0 | **8**, on two platforms | `.gitlab-ci.yml`, `.github/workflows/ci.yml` |
| Commands to start from clean checkout | 7 (+ host Node, pnpm, PostgreSQL) | **1** (Docker only) | `./start.sh` |

The advisory drop in high/moderate/low is a side effect of the three version pins, not a
separate effort — pinning `vitest >=4.1.0` pulled forward transitive dependencies that
carried their own advisories.

---

### 1. Fixed 13 failing `web/` unit tests

**What was wrong.** Three test files had drifted from the product. Not flaky — wrong.

| File | Failures | Cause |
|---|---:|---|
| `web/src/lib/document-tabs.test.ts` | 9 | Product renamed the `sprints` tab to `weeks` and gave sprint documents tabs. Tests still asserted `'sprints'` and `toEqual([])`. |
| `web/src/components/editor/DetailsExtension.test.ts` | 3 | `DetailsExtension` declares `content: 'detailsSummary detailsContent'`, but the test built an `Editor` with only `DetailsExtension`, so ProseMirror could not resolve the child node types. |
| `web/src/hooks/useSessionTimeout.test.ts` | 1 | The fetch mock was `{ ok, json }` with no `headers`. `ensureCsrfToken` (`web/src/lib/api.ts:59`) reads `response.headers.get(...)`, which threw, so `apiPost` rejected and the hook took its fail-secure branch and called `onTimeout`. |

**Why the tests were changed rather than the code.** Rule 2 permits *"fix the test (with
justification)"*. In all three cases the product behaviour is correct and deliberate — the
`sprint`→`week` rename is a real product decision, registering all three TipTap extensions
together is what `web/src/components/Editor.tsx:596-598` actually does, and forcing logout
when session extension fails is correct fail-secure behaviour. The tests encoded stale
expectations and an invalid mock.

**Tradeoff.** Two `resolveTabLabels` tests asserted that a count reached the project
`weeks` tab. It never can — that tab's label is a static string. Renaming the id alone
would have made the assertion vacuous, so the dynamic-count case was moved to program
tabs, where the label *is* count-driven. The alternative was deleting the assertion,
which would have silently dropped coverage of dynamic labels.

`useSessionTimeout.test.ts` also gained a `clearCsrfToken()` call in `beforeEach`. The
CSRF token is cached at module scope in `web/src/lib/api.ts:15`, so it leaked between
tests and made results order-dependent.

Net test count is 152, not 151: one test was added asserting that `DetailsSummary` and
`DetailsContent` exist, which is the thing whose absence caused the original failure.

### 2. Fixed 9 React hook-order violations

**What was wrong.** Three components called hooks after an early `return`:

- `web/src/components/UnifiedEditor.tsx` — `if (!user) return null` sat above 7 hooks
- `web/src/components/icons/uswds/Icon.tsx` — invalid-name guard above a `useMemo`
- `web/src/components/review/WeeklyReviewSubNav.tsx` — review-mode guard above a `useMemo`

**Why it matters.** React matches hooks by call order. When the guard condition flips
between renders, the hook count changes and React throws *"Rendered more hooks than
during the previous render."* In `UnifiedEditor` this is latent only because
`ProtectedRoute` currently prevents that subtree rendering while `user` is null — a
routing change would surface it as a hard crash.

**Fix.** Hooks hoisted above the guards. `Icon.tsx` needed the lookup itself to absorb
the invalid case (`isValidIconName(name) ? getLazyIcon(name) : null`) since it now runs
unconditionally.

**Tradeoff.** `Icon` now computes the lazy lookup even for an invalid name. That is a map
read, and the alternative — leaving a hook below a conditional return — is a latent crash.

### 3. Added eslint (`eslint.config.js`)

**What was added.** eslint 9 flat config with `typescript-eslint` and
`eslint-plugin-react-hooks`. Root scripts `lint` and `lint:fix`.

**Why this shape.** The repo had no linter and 312 of 315 source files fail
`prettier --check`. Two obvious options were both wrong: gating on prettier means
reformatting 312 files, which Rule 10 explicitly excludes (*"reformatting code... do not
count as improvements"*, p.9) and would collide with every other lane's diff; and a config
that flags nothing is theatre.

The line drawn: **errors are things that are defects regardless of style** —
`no-fallthrough`, `no-unreachable`, `no-dupe-keys`, `react-hooks/rules-of-hooks`.
Everything that is debt already owned by a named improvement lane is a warning, with the
owner in a comment. Result: 0 errors, 263 warnings, and the warning count is the number to
drive down.

Deliberately **not** using `recommendedTypeChecked`. It needs a TypeScript program per
package and roughly triples lint time, and `pnpm type-check` already runs `tsc --noEmit`
across all three packages in CI.

Rules turned off with reasons, rather than silently:

| Rule | Why off | Where |
|---|---|---|
| `@typescript-eslint/no-namespace` | Declaration merging is the only way to augment Express's `Request` type | `api/src/middleware/auth.ts:8` and 2 route files |
| `no-empty-pattern` | Playwright's worker-fixture signature is `async ({}, use, workerInfo)` — the empty destructure is required by the API | `e2e/fixtures/isolated-env.ts:109` |
| `no-empty` (tests only) | `.catch(() => {})` is how these specs express "may or may not exist" | 15 sites in `e2e/` |
| `no-undef` (TS only) | `tsc` already enforces it; duplicating doubles the report | — |

**How to tighten.** Move a rule from `warn` to `error` once its count reaches zero.
`@typescript-eslint/no-explicit-any` is the one Lane 1 will drive down.

### 4. Fixed 3 critical dependency advisories

`pnpm.overrides` in `package.json`:

| Package | Pinned | Advisory | Reached via |
|---|---|---|---|
| `fast-xml-parser` | `>=5.3.5` | Entity encoding bypass via regex injection | `@aws-sdk/client-bedrock-runtime` |
| `protobufjs` | `>=7.5.5` | Arbitrary code execution | `testcontainers > dockerode` |
| `vitest` | `>=4.1.0` | Arbitrary file read/execute when the UI server is listening | direct dev dependency |

All three were transitive or dev-only with patched versions available. `vitest` needed an
override rather than a version bump because `api/` and `web/` declare `^4.0.16`
independently and the lockfile had pinned 4.0.17, inside the advisory window.

**Tradeoff.** `vitest` went 4.0.17 → 4.1.10, a minor bump across both suites. Verified:
603 tests still pass (451 api + 152 web).

### 5. Added CI (`.gitlab-ci.yml` and `.github/workflows/ci.yml`)

**The Rule 4 / p.10 conflict, and how it was resolved.** Rule 4 says *"Add GitHub Actions
workflows"* (p.8). The submission target is *"Forked repo with all improvements on clearly
labeled branches"* in a GitLab repository (p.10), and this fork's `origin` is GitLab.
Earlier notes treated these as incompatible and planned to document a deviation. They are
not incompatible — this repo has both remotes configured, so **both pipelines exist and
run the same eight checks.** `.gitlab-ci.yml` is the gate that blocks merges on the
submitted repository; the Actions workflow satisfies Rule 4 literally on the platform it
names. No deviation needed. If the two drift, `.gitlab-ci.yml` wins.

All eight Rule 4 checks, on both platforms:

| Check | Job | Notes |
|---|---|---|
| build | `build` | Runs once; every later job consumes the artifact (Rule 5) |
| lint | `lint` | `pnpm lint` — 0 errors required |
| type-check | `type-check` | `tsc --noEmit` × 3 packages |
| test | `test` | **Both** suites. `pnpm test` alone is api-only and leaves 151 web tests unrun |
| coverage | `coverage` | `web` needs `--coverage.reportOnFailure`; vitest defaults it false |
| dependency audit | `dependency-audit` | Gates on zero critical |
| security scan | `security-scan` | gitleaks |
| source-code inventory | `license-inventory` | 1018 packages, 14 licences |

**Two documented deviations** (Rule 4 permits them *"with written justification"*):

1. **The audit gate is critical-only, not all severities.** 51 high and 55 moderate
   advisories remain, effectively all transitive ReDoS reports in dev tooling with no
   patched path today. Gating on them would block every merge for reasons unrelated to
   the change under review. Instead `scripts/audit-summary.mjs` diffs against
   `audit-baseline.json` (105 known advisories) and reports anything new, so a genuinely
   new advisory is still visible. Refresh the baseline deliberately with
   `node scripts/audit-summary.mjs --write-baseline`.
2. **gitleaks instead of `comply`.** `comply` is the organisation's scanner and what
   `.husky/pre-commit` expects, but it is not installable in either CI image — and it is
   not installed locally either, so the pre-commit secrets scan has been skipping with a
   warning on every commit. gitleaks actually runs.

Also: `--frozen-lockfile` everywhere, so lockfile drift fails the pipeline rather than
silently installing something else. That is what enforces Rule 4's pinning requirement.

`DATABASE_URL` is set explicitly in both pipelines and points at a throwaway service
container. This is deliberate: `api/src/test/setup.ts:14` truncates 15 tables in a
`beforeAll` against whatever `DATABASE_URL` resolves to, so it must never be allowed to
inherit a real value.

### 6. Added one-command local start (`./start.sh`)

**What was wrong.** README setup was 7 steps and required host Node, pnpm, and a
PostgreSQL the developer installed themselves. `docker-compose.yml` starts only
PostgreSQL. `docker-compose.local.yml` did already run all three services — so the gap
was narrower than the audit's F29 implied — but nothing wrapped it, nothing waited for
readiness, and there was no mock for the one external dependency.

**What was added.**

- `start.sh` — checks Docker is installed *and running*, handles both `docker compose` and
  `docker-compose`, brings the stack up, polls `/health` until the API answers (migrations
  and seeding happen on API start, so a fixed sleep is wrong), then prints URLs,
  credentials, and the seeded document count. On timeout it dumps the failing container's
  last 40 log lines and leaves the stack up for inspection.
- `docker-compose.mocks.yml` + `mocks/bedrock-expectations.json` — mock AWS Bedrock, so
  the AI quality banners work without AWS credentials. Layered as an override; skip it
  with `--no-mocks`.
- `api/src/services/ai-analysis.ts` — reads `BEDROCK_ENDPOINT` and passes it to the
  Bedrock client. Unset in production, where the SDK resolves the real regional endpoint
  exactly as before. This one-line product change is what makes the mock reachable.
- README cold-start guide rewritten. Host setup is preserved under a `<details>` block
  with the two footguns named: partial migrations exiting 0, and `pnpm test` truncating
  the dev database.

**Two defects found by running it, not by reading it.** Both are worth knowing about
because the second one is a trap anyone extending these compose files will hit.

1. **The two compose files collide on container name.** `docker-compose.yml` and
   `docker-compose.local.yml` both declare a service called `postgres`. Under the default
   compose project name (the directory, `ship`) they resolve to the same container,
   `ship-postgres-1` — so bringing up the local stack *recreated* the plain stack's
   container and moved the database from port 5432 to 5433, silently breaking `pnpm dev`
   on the host. The first run of `start.sh` did exactly this. Fixed by giving the script
   its own project (`-p ship-local`), so it gets its own containers and its own volume
   and the two paths coexist. The shared `postgres_data` volume name is why no data was
   lost when it happened.
2. **The mockserver image is distroless.** The healthcheck was written as `CMD-SHELL`
   with `curl`, and the image has neither a shell nor curl, so the container reported
   unhealthy forever while serving correctly — and `condition: service_healthy` then
   blocked the API from starting at all. Docker has no shell-free HTTP probe, so the
   healthcheck was removed. Strict ordering was never needed: `ai-analysis.ts` builds its
   client lazily on the first analysis request and returns null on failure, so the API
   boots regardless.

**Tradeoff.** `./start.sh` runs everything in containers, so hot-reload is slower than
`pnpm dev` on the host. Both paths are documented; `pnpm dev` is still there and unchanged.
Because the containerised stack now has its own volume, its database is separate from the
host one — seeded independently, and unaffected by `pnpm test` truncating the host DB.

**Scope boundary.** The mock is not a Bedrock emulator — it answers non-streaming
`InvokeModel` with a fixed well-formed payload and ignores SigV4. Adding retries,
timeouts, and a circuit breaker around this call is Rule 7 work and belongs to the error
handling lane, not here.

---

## How to run it

```bash
./start.sh                  # full stack: postgres + api + web + mock bedrock
./start.sh --clean          # discard the database volume and re-seed
./start.sh --down           # stop
```

Then http://localhost:5173, log in `dev@ship.local` / `admin123`.

CI runs on push and pull/merge request on both platforms. No manual trigger.

## How to test it

```bash
# The before/after numbers in the table above, reproduced:
pnpm --filter @ship/web exec vitest run     # expect 152 passed
pnpm test                                   # expect 451 passed  (TRUNCATES the dev DB)
pnpm db:seed                                # put the 257 seed documents back
pnpm type-check                             # expect exit 0
pnpm lint                                   # expect 0 errors
pnpm audit --audit-level critical           # expect exit 0
pnpm build                                  # expect exit 0

# Source-code inventory
pnpm licenses list --json > licenses.json && node scripts/license-inventory.mjs

# Dependency audit summary + new-advisory check
pnpm audit --json > pnpm-audit.json || true
node scripts/audit-summary.mjs

# One-command start, from scratch
./start.sh --clean
curl -fsS http://localhost:3000/health
```

**`pnpm test` truncates whatever `DATABASE_URL` points at.** Re-seed after running it or
the next measurement is taken against an empty database.

## How to roll it back

Everything here is additive except four edited files, and it is separable (Rule 11).

| To undo | Do this |
|---|---|
| CI, both platforms | `rm .gitlab-ci.yml .github/workflows/ci.yml` |
| eslint | `rm eslint.config.js`; remove `lint`/`lint:fix` from root `package.json`; `pnpm remove -Dw eslint typescript-eslint @eslint/js globals eslint-plugin-react-hooks` |
| Dependency pins | Delete the `pnpm.overrides` block from `package.json`, then `pnpm install`. Reintroduces 3 critical advisories. |
| One-command start | `rm start.sh docker-compose.mocks.yml`; `rm -rf mocks/`; revert the README section |
| Bedrock endpoint override | Revert `getClient()` in `api/src/services/ai-analysis.ts`. Safe — the variable is unset outside local dev. |
| Test fixes | `git checkout <pre-change-sha> -- web/src/lib/document-tabs.test.ts web/src/components/editor/DetailsExtension.test.ts web/src/hooks/useSessionTimeout.test.ts`. Restores 13 failures. |
| Hook-order fixes | Revert `UnifiedEditor.tsx`, `Icon.tsx`, `WeeklyReviewSubNav.tsx`. **Not recommended** — reintroduces a latent crash. |
| Inventory/audit scripts | `rm scripts/license-inventory.mjs scripts/audit-summary.mjs audit-baseline.json` |

Nothing here changes the database schema, so there is no migration to reverse.

### Files touched

**Added:** `.gitlab-ci.yml` · `.github/workflows/ci.yml` · `eslint.config.js` ·
`start.sh` · `docker-compose.mocks.yml` · `mocks/bedrock-expectations.json` ·
`scripts/license-inventory.mjs` · `scripts/audit-summary.mjs` · `audit-baseline.json` ·
`CHANGES.md`

**Edited:** `package.json` (scripts, overrides, devDeps) · `web/package.json`
(`test:coverage`) · `shared/package.json` (no-op `test`) · `README.md` (cold start) ·
`api/src/services/ai-analysis.ts` (endpoint override) ·
`web/src/components/UnifiedEditor.tsx` · `web/src/components/icons/uswds/Icon.tsx` ·
`web/src/components/review/WeeklyReviewSubNav.tsx` · the three test files above ·
`e2e/manager-reviews-visual.spec.ts` (redundant escapes)
