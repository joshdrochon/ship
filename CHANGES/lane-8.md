# Lane 8 — Terraform

Category 8 of the ShipShape Phase 2 improvements. Developer documentation
(implementation rule 8) and reasoning (rule 9) for everything on
`lane-8/terraform-render`.

Kept in `CHANGES/lane-8.md` rather than the root `CHANGES.md`, which several
lanes would otherwise edit at once.

**Status: 8 of 8 requirements delivered, with one qualified.** 8.5 is
plan-verified from a clean checkout *and* verified against a live deployment,
but no end-to-end `terraform apply` was run — that creates infrastructure on
someone's account and is their decision. The exact shape of what is and is not
proven is in "8.5, precisely" below. Nothing here is claimed on the strength of
a command that was not run.

---

## What changed

| # | Requirement (brief p.8 / p.11) | Status | Where |
|---|---|---|---|
| 8.1 | Config using `hashicorp/local`, ≥ 2 local resources | **done** — 4 resources | `terraform/local-config/` |
| 8.2 | Config using `render-oss/render`, declaring a web service | **done** — web service + database | `terraform/render/` |
| 8.3 | Provider versions pinned in both, and in all modules | **done** — 20/20 pinned | all 5 AWS roots + all 6 modules + `local-config` + `render` |
| 8.4 | `terraform plan` on each, output confirmed to match intent | **done for both** | `docs/audit/lane-8-annotated-plan.md`, parts 1 and 2 |
| 8.5 | Deployable from a clean machine with only `terraform apply` | **done, qualified** — see below | `terraform/render/README.md`, "What a clean machine still needs" |
| 8.6 | Render deployment replaces the manual deploy steps | **done** — 15 manual steps mapped | `terraform/render/README.md`, "What this replaces" |
| 8.7 | Annotated plan output with blast radius analysis | **done for both** | `docs/audit/lane-8-annotated-plan.md` |
| 8.8 | Drift detection demonstration | **done** | `docs/audit/lane-8-drift-detection.md` |

Six commits, scoped separately (rule 11):

| Commit | Scope |
|---|---|
| `07b640b` | `.gitignore` — state, tfvars and saved plans at any depth |
| `534fa28` | the `hashicorp/local` config (8.1) |
| `36bdf1d` | exact provider pins across all roots and modules (8.3) |
| `e073978` | annotated plan and drift demonstration (8.4, 8.7, 8.8) |
| `f68c449` | the `render-oss/render` config (8.2, 8.5, 8.6) |
| *(this)* | annotated Render plan, blast radius, and this write-up |

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
| Provider constraints declared | 9 | **20** |
| — exactly pinned | **0** | **20** |
| — range-constrained | 9 | **0** |
| Modules declaring `required_providers` | 0 of 6 | **6 of 6** |
| Constraint / lock conflicts | 8 | **0** |
| Terraform roots | 5 | 7 |
| Roots with obtainable `terraform plan` output | **0 of 5** | **2 of 7** |
| Roots that run with no cloud credentials at all | **0 of 5** | **1 of 7** |
| Local resources under Terraform management | 0 | **4** |
| Render resources under Terraform management | 0 | **2** |
| `.tf` files under `terraform/` | 42 | 57 |
| `resource` blocks | 145 | 152 |
| Lock files on disk | 7 | 3 |
| Lock files tracked in git | 7 | 3 |
| Saved plan files tracked in git | **1** | **0** |
| Ignore rules matching a nested `tfplan` | **0** | 2 |

Every number in that table was produced by running the command in this
session — none is carried forward from an earlier pass. Three rows changed
meaning since the previous revision of this file and are corrected here:

- **20, not 19.** The `render` root adds one exactly-pinned constraint.
- **Roots: 5 → 7**, so the "1 of 6" denominators were already stale. Two roots
  now produce plan output: `local-config` (offline) and `render` (against the
  live Render API). Only `local-config` needs no credentials at all; `render`
  needs an API key, which is the honest version of that row.
- **Lock files tracked in git, 7 → 3.** The earlier "7 → 2" for this row was
  measured wrong. `measure-terraform.py` reports `git-tracked: 0` when it runs
  against the extracted `/tmp/before` tree, because there is no git repository
  there for `git ls-files` to consult — the script reports on-disk counts
  correctly and tracked counts only inside a checkout. Measured with git
  instead, on both sides:

  ```bash
  git ls-tree -r 2fbc5a4 --name-only | grep -c terraform.lock.hcl   # 7
  git ls-tree -r HEAD     --name-only | grep -c terraform.lock.hcl   # 3
  git ls-tree -r 2fbc5a4 --name-only | grep -c tfplan                # 1
  git ls-tree -r HEAD     --name-only | grep -c tfplan                # 0
  ```

  Six stray module locks removed, two added (`local-config`, `render`). The
  saved-plan row is the W8-1 file, untracked by commit `8bbfbcf`.

Two more rows need a word of explanation.

**Constraint/lock conflicts, 8 → 0.** Before: six module lock files recorded
aws 6.28.0 with no `required_providers` entry declaring it. After: those six files
are deleted and the modules declare pins. This number was briefly a false 0 —
`satisfies_tilde()` in the measurement script returned `None` for anything that
was not a `~>` constraint, because the repo had no exact pins when it was written,
so once every constraint became exact the check silently passed while the module
locks still said 6.28.0. The script now evaluates exact pins, which is what
surfaced the six real conflicts and led to deleting the files.

**Lock files tracked, 7 → 3.** Six stray module lock files removed, two added,
for `local-config` and `render`. Not a regression: Terraform only reads the lock
file of the root it is invoked from, never one inside a consumed module, so
those six were never load-bearing. Finding W8-4 describes them as artifacts of
someone running `init` inside a module directory that "lock nothing and describe
a provider that cannot be used." The four *root* lock files that are missing are
still missing — see Tradeoffs. The two new configs are the only roots in this
repository whose lock file is both present and tracked.

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

## 5 · `terraform/render` — the deployment (`f68c449`)

**What.** A second standalone root, two resources:

| Resource | Is |
|---|---|
| `render_postgres.ship` | Managed PostgreSQL 16, `free` plan, oregon, `prevent_destroy` |
| `render_web_service.shipshape` | Docker web service, 1 instance, built from the repo's root `Dockerfile` at a named branch |

`render-oss/render` pinned exactly at 1.9.1, lock file committed.

**Why the original was worse.** Deploying ShipShape meant running
`scripts/deploy.sh <env>` and `scripts/deploy-frontend.sh <env>` in the right
order — 292 lines of bash that compile TypeScript on the operator's laptop, zip
`api/dist`, upload to S3, create an Elastic Beanstalk application version,
separately build the frontend, sync it to a different S3 bucket, and invalidate
CloudFront. Three properties of that are worse than they look:

1. **The artifact is whatever was on that laptop.** `deploy.sh:106` builds from
   the working tree, not from a commit. Implementation rule 5 asks for the
   opposite.
2. **Two deploys, two artifacts, one system.** The frontend and the API ship
   separately, so there is a window in which the deployed bundle and the
   deployed API disagree about the API contract.
3. **Secrets are typed by humans.** `DATABASE_URL` and `SESSION_SECRET` are SSM
   parameters someone pastes a value into.

**Why this approach is better.** Render builds the Dockerfile at a git ref, so
the artifact comes from the commit. The image already serves `web/dist` from the
API process (`api/src/app.ts:250-258`), so there is one deploy and no CDN
invalidation. `DATABASE_URL` is
`render_postgres.ship.connection_info.internal_connection_string` — a reference
resolved inside the graph, never typed, never in a variable, never in a file.
`SESSION_SECRET` is `generate_value = true`. And
`wait_for_deploy_completion = true` makes a failed build fail the apply, where
`deploy.sh:220` prints an AWS command for you to go and run yourself. The full
step-by-step mapping — 15 rows — is in `terraform/render/README.md`.

**How to run it:**

```bash
cd terraform/render
export TF_VAR_render_api_key=rnd_...   # or: set -a; source .env; set +a
export TF_VAR_render_owner_id=tea_...
terraform init && terraform apply
```

**How to test it:**

```bash
terraform fmt -check      # clean
terraform validate        # Success
terraform plan            # 2 to add, 0 to change, 0 to destroy
```

`plan` is a live authenticated call to `api.render.com`, so a clean plan is also
an authentication check. Full annotated output, the blast radius matrix and the
clean-checkout transcript are in `docs/audit/lane-8-annotated-plan.md`, part 2.

**Roll back:** `terraform destroy` — which stops on the database, by design
(`prevent_destroy`). To walk away without deleting anything:
`terraform state rm render_web_service.shipshape render_postgres.ship && rm -rf
.terraform terraform.tfstate*`. Nothing outside `terraform/render/` changed;
`scripts/deploy.sh` works exactly as before.

**The bug this found.** The first draft set `database_name = "ship"`. Render
disambiguates the name on create — ask for `ship`, get `ship_<suffix>` — so that
attribute could never match reality and it forces replacement. Planned against a
live database it reported `1 to import, 1 to add, 0 to change, 1 to destroy`, and
`prevent_destroy` is the only reason that is a note here rather than a data-loss
incident. Both `database_name` and `database_user` are now unset, with the reason
written into `main.tf` so nobody tidies them back in.

## 6 · Storage — a Render disk rather than S3

### What is needed, and why

Ship accepts file uploads. `api/src/routes/files.ts:421` writes them to S3 only when
`NODE_ENV=production` **and** `S3_UPLOADS_BUCKET` is set; with either missing it falls
through to `UPLOADS_DIR`, which resolves to `/app/api/uploads` inside the container.

On Render that filesystem is ephemeral — discarded on every deploy, restart and instance
move. The `files` rows are in Postgres and survive, so **the UI keeps listing attachments
whose bytes are gone**. The user sees the file, clicks it, and gets nothing. Nothing
reports a failure.

That is the same class as W6-9: silent loss where the interface asserts the work is safe.
It is not in the audit — it was found while writing up what Render replaced in the AWS
stack — and it is recorded here rather than left for someone to hit.

The requirement is narrow. Uploaded bytes must survive a deploy and a restart, and the app
must not need a second cloud account to run. Not required: CDN edges, lifecycle rules,
cross-region replication, or public presigned URLs at volume. Attachments are served to
authenticated users of one workspace, through Express, from a single instance.

### Why the disk and not the bucket

The deciding factor is the credential, not the storage.

S3 is already implemented — that code path ships and works. Enabling it means putting a
long-lived AWS access key and secret into Render's environment, unrotated, for one feature.
W8-1 in this audit is a leaked AWS account identifier committed through a saved Terraform
plan. Introducing real credentials raises the cost of the next mistake of that shape.

A Render disk needs no credential. It is three attributes on a resource this config already
manages, and it keeps the property Category 8 was for: the app runs on Render without an
AWS account. Reaching back to S3 for uploads would mean the deployment moved off AWS but
the application still cannot start without it.

```hcl
disk = var.uploads_disk_size_gb == null ? null : {
  name       = "${var.service_name}-uploads"
  mount_path = "/app/api/uploads"
  size_gb    = var.uploads_disk_size_gb
}
```

### What it costs

- **One instance, permanently.** A Render disk attaches to a single instance, so the
  service cannot scale horizontally. Here that is free: `num_instances` is already
  validated to exactly 1, because the collaboration server keeps Yjs document state in
  module-level `Map`s (`api/src/collaboration/index.ts`) and two instances would serve
  divergent documents. The disk constraint and the application constraint are the same
  constraint. If that Yjs state is ever externalised, the disk becomes the next blocker and
  S3 becomes the right answer.
- **Not available on `free`.** Render disks require `starter` or above. The variable
  therefore defaults to `null`, so a free-plan apply from a clean machine still works and
  Rule 6 is unaffected. Attaching is opt-in: `-var uploads_disk_size_gb=1`.
- **No CDN.** Every read goes through the Express process. S3 with CloudFront would offload
  it. At this read volume that is not a cost worth an AWS dependency; at a volume where it
  is, it is the same migration as the horizontal-scale one.

**Not applied.** The variable defaults to `null`, so the committed config plans no disk and
the live free-plan service is unchanged. Attaching one is a plan the account owner runs.

## 8.5, precisely

The brief says *"deployable from a clean machine using only `terraform apply`"*.
Here is exactly what was verified, and what was not.

**Verified.** `git archive HEAD terraform/render` into an empty directory, then
`init` and `plan` under `env -i` with nothing in the environment but `PATH`,
`HOME` and two `TF_VAR_` values. The lock file was honoured (*"Reusing previous
version of render-oss/render from the dependency lock file"*) and the plan came
back `2 to add, 0 to change, 0 to destroy` against the real Render API.

**Also verified, and stronger.** This fork is *already deployed* on Render, at
https://shipshape-70uo.onrender.com, serving `{"status":"ok"}` on `/health` from
commit `6d8c505` — an ancestor of this branch. It was deployed by hand before
this configuration existed. Planning the committed configuration against those
live resources with `import` blocks reports:

```
Plan: 2 to import, 0 to add, 1 to change, 0 to destroy.
```

Zero to add, zero to destroy: every structural attribute of the configuration
matches a deployment that is currently serving traffic. The database imports
with no changes at all. The one in-place change is the web service, and it is
four deliberate additions (`health_check_path`, `max_shutdown_delay_seconds`,
explicit `num_instances`, regenerated `SESSION_SECRET`) plus three env vars that
default to null. Itemised in the annotated plan.

**Not verified.** No `terraform apply` was run from this configuration, so no
image has been built end-to-end *by Terraform*. It was not run because it
creates infrastructure on the user's Render account, and because a create apply
would stand up a second service and database alongside the healthy ones.

**One caveat that is not about applying.** `joshdrochon/ship` is private, so the
Render account must already have its GitHub OAuth connection authorised.
Terraform cannot create that — it is a browser consent flow. So the accurate
claim is "one credential and one prior consent", not "only `terraform apply`".
A public repo or a published container image would each remove it.

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
| **Render config manages the database too** | Web service only, database URL as a variable | p.8 asks for a fork *deployable* from a clean machine. ShipShape does not boot without a database — the container runs `migrate` then `seed` before serving. A web-service-only config would plan cleanly and produce a crash loop. Managing both also means `DATABASE_URL` is a graph reference, so no connection string is ever typed. |
| `prevent_destroy` on the database | Nothing, or `create_before_destroy` | Render deletes the volume with the instance and the `free` plan has no backups, so there is no recovery to design — only prevention. It earned its place: it caught a planned destroy of the live database during development. `create_before_destroy` does not apply; you cannot have two databases at one name. |
| `database_name` / `database_user` left unmanaged | Set them explicitly, as the live service does | Render disambiguates the name on create, so a literal never matches what comes back and the attribute forces replacement. Explicit-is-better loses to a config that plans a data-loss on every run. |
| `num_instances` validated to exactly 1 | Leave it configurable and document the risk | The failure it prevents is silent: two instances serve divergent Yjs documents and neither user is told. A `validation` block turns a silent data-divergence bug into a `terraform plan` error, and the comment names the file to fix first. |
| `SESSION_SECRET` provider-generated by default | Require one | Keeps a clean-machine apply down to one credential, which is the 8.5 requirement. Overridable with `-var session_secret=…` for anywhere the value must outlive the state file — same shape as `local-config`. |
| `repo_url` has a default; `render_owner_id` does not | Default both, or neither | The owner id is an account identifier used with the API key — the same class of value as the AWS account ID that W8-1 leaked, so it stays in the environment. A repository URL is not a credential, and a config that claims to deploy "your improved fork" has to name the fork. |
| `auto_deploy = false` | Redeploy on every push | A push to a branch should not mutate a running deployment without a decision. Terraform is the thing making the decision here; letting Render also make it means the resource drifts under you between plan and apply. |
| `wait_for_deploy_completion = true` | Return as soon as the API accepts | Makes a failed build fail the apply. Costs several minutes per apply, buys the one safety property `scripts/deploy.sh` never had — it returns on acceptance and prints a `describe-environments` command for you to run yourself. |
| `connection_info` not exported as an output | Output it for convenience | Every output lands in `terraform.tfstate` in plaintext and prints unredacted unless marked sensitive — and marking it sensitive still leaves it plaintext in state. Nothing downstream needs it; the web service reads it through a graph reference that never surfaces the value. |
| Render IDs redacted in the audit document | Quote the plan byte-for-byte | Same class of value as the AWS account ID in W8-1. The public service URL is left intact because anyone can already fetch it. The redaction is stated at the top of the section rather than done silently. |
| **Uploads on a Render persistent disk** | Set `S3_UPLOADS_BUCKET` and use the S3 path that already ships | S3 costs a long-lived AWS key pair in Render's environment, unrotated, for one feature — on a repo where W8-1 is a leaked AWS account identifier. A disk needs no credential and keeps the property this lane exists for: the app runs on Render without an AWS account. The price is single-instance forever, which `num_instances` already enforces for an unrelated reason (Yjs state in module-level Maps), so it costs nothing today. Section 6. |
| `uploads_disk_size_gb` defaults to `null` | Attach a disk by default | Render disks need `starter` or above. A default disk would make a clean-machine free-plan `apply` fail, which is the Rule 6 property. Opt in with `-var uploads_disk_size_gb=1`. |
| No `terraform apply` run | Apply to prove 8.5 end to end | It spends someone else's money on someone else's account, and there is already a healthy deployment there to duplicate. The gap this leaves is stated in "8.5, precisely" rather than papered over. |

## Rules that do not apply to this lane, and why

| Rule | Why |
|---|---|
| 2 — tests still pass | No application source, dependency or test file is touched. `git diff --stat 2fbc5a4..HEAD` is confined to `terraform/`, `.gitignore`, `docs/audit/` and `CHANGES/`. `pnpm test` was deliberately not run: it truncates the dev database (`api/test/setup.ts:14`) and would corrupt another lane's measurements for no information gain. |
| 3 — regression test | The finding fixed here (W8-1, an ignore-rule gap) has no unit-test surface. Its regression check is `git check-ignore -v --no-index terraform/environments/shadow/tfplan`, given in section 1. A `terraform plan -refresh-only -detailed-exitcode` drift check is the closest thing to a CI test and is specified at the end of the drift document, unwired — CI ownership sits with the lane holding rule 4. |
| 4 — CI pipeline | Not this lane. |
| 6 — one-command local start | Already delivered (`./start.sh`, commit `b876ee7`). `local-config` does not replace it; with `-var 'output_dir=../..'` it can render the env files `start.sh` expects. |
| 7 — retries, timeouts, breakers | No outbound service calls added. The timeout values in `app.config.json` are rendered configuration, not an implementation of rule 7. |

---
## What is still open

The credential blocker recorded in the previous revision of this file is gone.
`TF_VAR_render_api_key` is present in the environment, `terraform/render/` is
written, and `terraform plan` against the real Render API is in the annotated
plan document. What remains is smaller and none of it is a credential problem.

**1 · No `terraform apply` has been run from this configuration.** Deliberate,
not blocked. It creates infrastructure on the user's Render account, and a
create apply would stand up a second service and database beside the healthy
ones already there. The low-risk way to close it is `terraform apply` with the
`import` blocks — adopting the existing service rather than creating a new one —
and that is the account owner's call. See "8.5, precisely" above for exactly
what is and is not proven without it.

**2 · The GitHub OAuth connection is a prerequisite Terraform cannot create.**
`joshdrochon/ship` is private, so the Render account must already have it
authorised through a browser consent flow. A public repo, or a
`runtime_source.image` pointing at a published container image, removes this.
Recorded rather than fixed because publishing the repo is not a Terraform
decision.

**3 · W8-10 is answered for the Render target only, and narrowly.** The audit
flagged that ShipShape runs on Aurora and terminates Yjs WebSocket
collaboration with document state in module-level `Map`s
(`api/src/collaboration/index.ts`), so a single Render web service does not
port the Treasury deployment. That is still true and this lane does not claim
otherwise. What it does instead: `num_instances` carries a `validation` block
that refuses any value but `1`, so the config cannot be scaled into the
divergent-document failure by accident, and the reason is written next to the
rule. Moving Yjs state out of process memory is application work, not
Terraform work.

**4 · The four missing *root* lock files are still missing.** Unchanged from
the previous revision, and still deliberate — see Tradeoffs. `local-config` and
`render` are the only two roots in this repository with a lock file that is both
present and tracked.

**5 · `terraform/environments/shadow/tfplan` is out of the working tree but
still in git history.** Commit `8bbfbcf` untracked it; that does not remove the
disclosure. Rewriting history is a human decision and was left alone.
