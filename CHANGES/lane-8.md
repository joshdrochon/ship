# Lane 8 — Terraform

Category 8 of the ShipShape Phase 2 improvements. Developer documentation
(implementation rule 8) and reasoning (rule 9) for everything on
`lane-8/terraform-render`.

Kept in `CHANGES/lane-8.md` rather than the root `CHANGES.md`, which several
lanes would otherwise edit at once.

**Status: 6 of 8 requirements done. 8.2, 8.5 and 8.6 are blocked on a Render API
key that is not in this environment.** Details in "What is blocked" below.

---

## What changed

| # | Requirement (brief p.8 / p.11) | Status | Where |
|---|---|---|---|
| 8.1 | Config using `hashicorp/local`, ≥ 2 local resources | **done** — 4 resources | `terraform/local-config/` |
| 8.2 | Config using `render-oss/render`, declaring a web service | **blocked** | — |
| 8.3 | Provider versions pinned in both, and in all modules | **done** — 19/19 pinned | all 5 roots + all 6 modules + `local-config` |
| 8.4 | `terraform plan` on each, output confirmed to match intent | **done for the local config**; blocked for Render | `docs/audit/lane-8-annotated-plan.md` |
| 8.5 | Deployable from a clean machine with only `terraform apply` | **blocked** | — |
| 8.6 | Render deployment replaces the manual deploy steps | **blocked** | — |
| 8.7 | Annotated plan output with blast radius analysis | **done** | `docs/audit/lane-8-annotated-plan.md` |
| 8.8 | Drift detection demonstration | **done** | `docs/audit/lane-8-drift-detection.md` |

Four commits, scoped separately (rule 11):

| Commit | Scope |
|---|---|
| `07b640b` | `.gitignore` — state, tfvars and saved plans at any depth |
| `534fa28` | the `hashicorp/local` config (8.1) |
| `36bdf1d` | exact provider pins across all roots and modules (8.3) |
| `e073978` | annotated plan and drift demonstration (8.4, 8.7, 8.8) |

---

## Before / after (rule 1)

Same script both sides: `docs/audit/scripts/measure-terraform.py`, the audit's
canonical Category 8 measurement. Reproduce the "before" by running the *current*
script against the base tree, so only the input differs:

```bash
mkdir -p /tmp/before/docs/audit/scripts
git archive 2fbc5a4 terraform | tar -x -C /tmp/before
cp docs/audit/scripts/measure-terraform.py /tmp/before/docs/audit/scripts/
(cd /tmp/before && python3 docs/audit/scripts/measure-terraform.py)   # before
python3 docs/audit/scripts/measure-terraform.py                        # after
```

| Metric | Before | After |
|---|---:|---:|
| Provider constraints declared | 9 | **19** |
| — exactly pinned | **0** | **19** |
| — range-constrained | 9 | **0** |
| Modules declaring `required_providers` | 0 of 6 | **6 of 6** |
| Constraint / lock conflicts | 8 | **0** |
| Terraform roots that run with no credentials | **0 of 5** | **1 of 6** |
| Roots with obtainable `terraform plan` output | **0 of 5** | **1 of 6** |
| Local resources under Terraform management | 0 | **4** |
| `.tf` files under `terraform/` | 42 | 52 |
| `resource` blocks | 145 | 150 |
| Lock files tracked in git | 7 | 2 |
| Ignore rules matching a nested `tfplan` | **0** | 2 |

Two rows need a word of explanation.

**Constraint/lock conflicts, 8 → 0.** Before: six module lock files recorded
aws 6.28.0 with no `required_providers` entry declaring it. After: those six files
are deleted and the modules declare pins. This number was briefly a false 0 —
`satisfies_tilde()` in the measurement script returned `None` for anything that
was not a `~>` constraint, because the repo had no exact pins when it was written,
so once every constraint became exact the check silently passed while the module
locks still said 6.28.0. The script now evaluates exact pins, which is what
surfaced the six real conflicts and led to deleting the files.

**Lock files tracked, 7 → 2.** Six stray module lock files removed, one added for
`local-config`. Not a regression: Terraform only reads the lock file of the root
it is invoked from, never one inside a consumed module, so those six were never
load-bearing. Finding W8-4 describes them as artifacts of someone running `init`
inside a module directory that "lock nothing and describe a provider that cannot
be used." The four *root* lock files that are missing are still missing — see
Tradeoffs.

**A second before/after, run directly rather than through the script.** Delete
the lock files from a copy of the base tree and `terraform init` each root:

| Root | Before (base tree, no lock) | After |
|---|---|---|
| `terraform/` | aws 5.100.0, random **3.9.0** | aws 5.100.0, random **3.7.2** |
| `environments/dev` | aws 5.100.0, random **3.9.0** | aws 5.100.0, random **3.7.2** |
| `environments/shadow` | aws 5.100.0, random **3.9.0** | aws 5.100.0, random **3.7.2** |
| `environments/prod` | aws 5.100.0, random **3.9.0** | aws 5.100.0, random **3.7.2** |

`environments/prod`'s committed lock file records random 3.7.2. So before this
change the configuration and the lock disagreed about what a fresh `init` would
select, and the configuration itself guaranteed nothing — only a lock file did,
and four of five roots have none. That is the reproducibility failure W8-4
measured, reproduced and then closed.

---

## 1 · `.gitignore` — state, tfvars and saved plans at any depth (`07b640b`)

**What.** Added recursive `*.tfvars`, `*.tfstate*`, `tfplan`, `*.tfplan` and
`.terraform/` globs to the root and `terraform/` ignore files. Un-ignored
`.terraform.lock.hcl` for the two new config directories.

**Why the original was worse.** The rules were path-anchored one level deep:
`terraform/tfplan` and `terraform/*.tfplan` match a plan saved in `terraform/`
and nothing else. The repo's own README tells operators to run
`terraform plan -out=tfplan` from inside `terraform/environments/<env>/`, so the
documented workflow produced a file the ignore rules never covered. That is how
`terraform/environments/shadow/tfplan` reached git carrying a resolved state
snapshot with the AWS account ID and a named IAM principal in it (finding W8-1).

**Why first.** Terraform writes credentials into state and into saved plans in
plaintext. This had to land before any `terraform init` on this branch.

**Verify:** `git check-ignore -v --no-index terraform/environments/shadow/tfplan`
now reports a match. No currently tracked file becomes newly ignored.

**Roll back:** revert the commit. Nothing depends on it except the committed
`local-config/.terraform.lock.hcl`, which would become ignored again but stays
tracked.

**Still outstanding.** The existing `terraform/environments/shadow/tfplan` is
still tracked — an ignore rule does not untrack, and the content is already in
git history so deleting the file does not remove the disclosure. Removing it and
rewriting history are separate decisions, deliberately left to a human.

## 2 · `terraform/local-config` — environment files as managed resources (`534fa28`)

**What.** A new standalone Terraform root managing four local files plus a
generated password:

| Resource | Renders | Mode |
|---|---|---|
| `local_sensitive_file.api_env` | `api/.env.local` | `0600` |
| `local_file.web_env` | `web/.env.local` | `0644` |
| `local_file.app_config` | `app.config.json` | `0644` |
| `local_file.deploy_manifest` | `deploy-manifest.json` | `0644` |
| `random_password.session_secret` | state only | — |

**Why the original was worse.** `scripts/dev.sh:36` wrote `api/.env.local` with a
`cat >` heredoc containing a literal
`SESSION_SECRET=dev-secret-change-in-production`, and the web env file had no
generator at all. There was no single place that stated what an environment
consists of, no diff when it changed, and no enforced file mode on a file holding
a database URL and a session secret.

**Why this approach is better.** The API env file is declared `0600` and the web
env file `0644`, and both are enforced on create. The API and web URLs derive from
one `locals` block, so the two files cannot disagree about where the API is. And
it is a root with no backend, no remote state and no credentials — it runs
`terraform init && terraform apply` offline on a clean machine, which is the
property the five AWS roots lack: they cannot even `init` without the `aws` CLI
and an SSM lookup to discover the backend bucket name.

**How to run it:** `cd terraform/local-config && terraform init && terraform
apply`. Full instructions, including rendering into the repo instead of
`generated/`, in `terraform/local-config/README.md`.

**How to test it:**

```bash
terraform fmt -check          # clean
terraform validate            # Success
terraform plan                # 5 to add, 0 to change, 0 to destroy
terraform apply -auto-approve
terraform plan                # No changes.
ls -l generated/api/.env.local  # -rw-------
```

**Roll back:** `terraform destroy && rm -rf .terraform generated
terraform.tfstate*`, then delete the directory. Nothing else in the repo reads
anything it produces, and with `output_dir` at its default nothing outside the
directory is touched.

## 3 · Exact provider pins everywhere (`36bdf1d`)

**What.** Every `~> 5.0` → `5.100.0` and `~> 3.6` → `3.7.2` across all five AWS
roots; a new pinned `versions.tf` in each of the six modules, which previously
declared no `required_providers` at all; the six stray module lock files deleted.

**Why the original was worse.** Nine range constraints, zero pins. Demonstrated
above: identical configuration resolved different provider versions depending on
whether a lock file happened to exist. Nothing was broken, and that is the shape
of the risk — a future `init` picks up a new provider minor and changes plan
output under an operator who is mid-incident.

**Why these versions.** aws 5.100.0 is the newest 5.x on the registry, so it is
exactly what `~> 5.0` already selects — pinning it changes nothing today. random
3.7.2 is what `environments/prod`'s committed lock records, so prod needs no lock
regeneration; dev, shadow and the legacy root move 3.9.0 → 3.7.2, toward prod
parity rather than away from it.

**How to test it:** `python3 docs/audit/scripts/measure-terraform.py` — 19
declared, 19 pinned, 0 range-constrained, no constraint/lock conflicts. Plus
`terraform validate` on all five roots against a scratch copy with a local
backend override:

```bash
cp -R terraform /tmp/tfcheck && cd /tmp/tfcheck/terraform
find . -name .terraform.lock.hcl -delete
for d in . bootstrap environments/dev environments/shadow environments/prod; do
  (cd "$d" && printf 'terraform {\n  backend "local" {}\n}\n' > zz_override.tf \
     && terraform init -input=false >/dev/null && terraform validate)
done
```

All five report Success. The single warning
(`aws_s3_bucket_lifecycle_configuration.uploads`, finding W8-8) is pre-existing
and unchanged.

**Roll back:** revert the commit. It restores the six deleted lock files and the
`~>` constraints. No state migration, no resource changes — a provider version
constraint affects only which plugin binary is selected.

## 4 · Audit artifacts (`e073978`)

`docs/audit/lane-8-annotated-plan.md` and `docs/audit/lane-8-drift-detection.md`.
Both are transcripts of commands actually run, reproducible from the recipes at
the top of each file.

---

## Tradeoffs

| Decision | Alternative | Why this way |
|---|---|---|
| `output_dir` defaults to `generated/` | Render straight into the repo | A plain `apply` cannot clobber a developer's working `api/.env.local`. Costs one `-var` flag; avoids a destructive default. |
| `session_secret` generated by default, overridable | Always require one | Zero-setup for local and dev. For anything real the value must outlive the state file, so it is a `sensitive` variable you pass in. |
| Exact pins *inside* the six modules | Permissive ranges in modules, pin only at roots | Ranges in modules is the correct general practice, and it is what a published module should do. These six are consumed only by roots in this repository, and p.11 requires pins "in all modules". Written into each module's `versions.tf` so the next engineer does not have to rediscover the reasoning. |
| The four missing **root** lock files are not generated | `terraform init` in each root and commit the results | Generating them means running `init` in the repo, and their absence is a measured audit finding another lane may still be reporting against. An exact `=` pin already gives version determinism; what a lock adds on top is provider hash verification. Recorded as the next step, not done here. |
| Six stray **module** lock files deleted | Left in place | They recorded aws 6.28.0 next to a new 5.100.0 pin. Terraform never reads them. Leaving them would mean shipping a file that contradicts the line above it. |
| `git_sha` is a variable | An `external` data source shelling out to git | A data source would make `plan` fail outside a git checkout and re-read on every refresh. |
| Measurement script extended rather than left alone | Report pinning only in prose | Its `satisfies_tilde()` would have reported a false "no conflicts" once every constraint became exact. A metric that cannot see the thing you changed is worse than no metric. |
| AWS stack left otherwise untouched | Fix W8-1 … W8-9 in this lane | The p.8 target is additive: two *new* configs, not a refactor. None of W8-1 through W8-9 is on the critical path, and they are changes to live infrastructure for a Treasury-deployed system. Pinning is the one place the target and the findings overlap, and that is the part this lane did. |

## Rules that do not apply to this lane, and why

| Rule | Why |
|---|---|
| 2 — tests still pass | No application source, dependency or test file is touched. `git diff --stat 2fbc5a4..HEAD` is confined to `terraform/`, `.gitignore`, `docs/audit/` and `CHANGES/`. `pnpm test` was deliberately not run: it truncates the dev database (`api/test/setup.ts:14`) and would corrupt another lane's measurements for no information gain. |
| 3 — regression test | The finding fixed here (W8-1, an ignore-rule gap) has no unit-test surface. Its regression check is `git check-ignore -v --no-index terraform/environments/shadow/tfplan`, given in section 1. A `terraform plan -refresh-only -detailed-exitcode` drift check is the closest thing to a CI test and is specified at the end of the drift document, unwired — CI ownership sits with the lane holding rule 4. |
| 4 — CI pipeline | Not this lane. |
| 6 — one-command local start | Already delivered (`./start.sh`, commit `b876ee7`). `local-config` does not replace it; with `-var 'output_dir=../..'` it can render the env files `start.sh` expects. |
| 7 — retries, timeouts, breakers | No outbound service calls added. The timeout values in `app.config.json` are rendered configuration, not an implementation of rule 7. |

---

## What is blocked

**8.2, 8.5 and 8.6 need a Render API key that is not in this environment.**
Checked `TF_VAR_render_api_key` and `RENDER_API_KEY`: both unset, and no
`render`-prefixed variable is present. Nothing was stubbed, and no placeholder
key was written anywhere, because a placeholder in a `.tf` file is the thing that
later gets committed.

The `render-oss/render` provider is real and reachable — the registry lists
versions through 1.9.1 — so the blocker is only the credential.

What remains, once a key is available in the environment:

1. `terraform/render/` declaring `render_web_service` for the API, with the
   provider pinned exactly, `api_key` declared `sensitive = true` with no default,
   and no `*.tfvars` file committed.
2. `terraform init` and `terraform plan` in that directory, output reviewed for
   secrets, then annotated the same way as `lane-8-annotated-plan.md`.
3. A decision that is not a Terraform decision, flagged by the audit as W8-10:
   ShipShape runs on Aurora PostgreSQL and terminates Yjs WebSocket
   collaboration with document state in module-level `Map`s. A single Render web
   service does not port that without deciding what happens to the database and
   to the in-process collaboration state. 8.6 — "replaces any manual deploy
   steps" — cannot be honestly claimed until that is answered, and it is a
   product decision.

`PHASE2_ROOTS` in `docs/audit/scripts/measure-terraform.py` already lists
`render`, and skips it while the directory does not exist, so the measurement
picks the config up automatically once it lands.
