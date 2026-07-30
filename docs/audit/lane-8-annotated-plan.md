# Lane 8 — Annotated `terraform plan` with blast radius analysis

Requirement 8.7 (brief p.11: *"Annotated terraform plan output with blast radius
analysis"*) and 8.4 (p.8: *"Run `terraform plan` on each and confirm the output
matches intent"*).

p.8 says *"each"*, so this covers both configurations:

| Part | Config | Provider | Plan |
|---|---|---|---|
| **1** (below) | `terraform/local-config` | `hashicorp/local` 2.9.0 + `hashicorp/random` 3.9.0 | `5 to add, 0 to change, 0 to destroy` |
| **2** (end of file) | `terraform/render` | `render-oss/render` 1.9.1 | `2 to add, 0 to change, 0 to destroy` |

**This is real plan output**, produced from a clean checkout of the committed
configuration, not a static annotation. That distinction matters here because the
Category 8 audit could not obtain plan output for the AWS stack at all — it needs
state, which needs an SSM lookup and AWS credentials — and substituted `validate`,
`providers` and `graph` rather than fabricating one. The `hashicorp/local` config
has no such dependency, so this document quotes the actual thing. Part 2's plan is
a live call to the Render API, authenticated with a real key.

---

# Part 1 — `terraform/local-config` (`hashicorp/local`)

Reproduce it:

```bash
git archive HEAD terraform/local-config | tar -x -C /tmp/clean
cd /tmp/clean/terraform/local-config
terraform init && terraform plan
```

Environment: Terraform v1.15.8 (darwin_arm64, `hashicorp/tap`),
`hashicorp/local` 2.9.0, `hashicorp/random` 3.9.0 — both exact pins, both
recorded in the committed `.terraform.lock.hcl`.

---

## Summary

```
Plan: 5 to add, 0 to change, 0 to destroy.
```

Five resources, which is intent: four managed local files plus the random
password that feeds one of them. p.8 asks for at least two local resources.

| # | Address | Renders | Mode | Sensitive |
|---|---|---|---|---|
| 1 | `local_sensitive_file.api_env` | `api/.env.local` | `0600` | yes |
| 2 | `local_file.web_env` | `web/.env.local` | `0644` | no |
| 3 | `local_file.app_config` | `app.config.json` | `0644` | no |
| 4 | `local_file.deploy_manifest` | `deploy-manifest.json` | `0644` | no |
| 5 | `random_password.session_secret` | state only | — | yes |

`0 to change` and `0 to destroy` on a clean checkout is the assertion worth
making: nothing pre-exists, so a first `apply` cannot remove anything.

---

## Every resource, and whether the change is safe

Brief p.8 bullet 2: *"for every resource it will create, modify, or destroy,
write one sentence explaining what it is and whether the change is safe."*

### 1 · `local_sensitive_file.api_env` — create

The API's environment file: `DATABASE_URL`, `SESSION_SECRET`, `PORT`,
`NODE_ENV`, `ENVIRONMENT`, `CORS_ORIGIN`, `APP_BASE_URL`.

**Safe to create; the riskiest resource to change.** Creation writes a file that
does not exist, at `0600`. It is the riskiest to *modify* because it carries the
session secret, and because the local provider replaces rather than updates (see
below) — the file is unlinked and rewritten, so a process reading it in that
window sees it missing.

```
  # local_sensitive_file.api_env will be created
  + resource "local_sensitive_file" "api_env" {
      + content              = (sensitive value)      <-- redacted, as intended
      + content_base64sha256 = (known after apply)
      + content_md5          = (known after apply)
      + content_sha256       = (known after apply)
      + directory_permission = "0750"
      + file_permission      = "0600"
      + filename             = "generated/api/.env.local"
      + id                   = (known after apply)
    }
```

`content = (sensitive value)` is requirement 8's security check passing in
practice: `database_url` and `session_secret` are declared `sensitive = true`, so
the plan is safe to paste into a review or a CI log. **The content hashes are
not redacted.** They are hashes of the whole file so they disclose nothing
directly, but they are a confirmation oracle for a guessed value — one more
reason not to commit a saved plan.

### 2 · `local_file.web_env` — create

`VITE_API_URL`, `VITE_WS_URL`, `VITE_APP_ENV` for the Vite build. **Safe.**
Deliberately `local_file`, not `local_sensitive_file`: Vite inlines every
`VITE_`-prefixed variable into the browser bundle, so nothing secret may live
here, and rendering it in the clear makes that reviewable. The URLs derive from
the same `locals` block as `api_env`, so the two files cannot disagree about
where the API is.

### 3 · `local_file.app_config` — create

Runtime configuration: log level and format, HTTP request/shutdown/keep-alive
timeouts, database pool size and connect/statement timeouts, session idle and
absolute timeouts. **Safe.** `jsonencode` guarantees the file is valid JSON and
makes the plan diff structural — Terraform renders it key by key, which is what
makes the drift demonstration legible.

### 4 · `local_file.deploy_manifest` — create

Provenance: git SHA, environment, the exact provider versions that rendered this
set, and the list of files rendered. **Safe** — nothing reads it at runtime. It
exists so a rendered environment can be traced back to a commit
(implementation rule 5).

### 5 · `random_password.session_secret` — create

48-character base62 password, `keepers = { environment = var.environment }`.
**Safe on create; the one genuinely dangerous change in this config.** The
keeper means changing `var.environment` regenerates it, which rewrites
`api_env`, which invalidates every live session at once. Held in state, so pass
`-var session_secret=...` from a secrets manager anywhere the value must outlive
the state file.

---

## Blast radius

Brief p.8 bullet 3 asks for the worst case. The central fact:

> **The local provider has no in-place update path. Every writable attribute of
> `local_file` and `local_sensitive_file` forces replacement.**

Verified empirically, one attribute at a time, against real state — not read off
documentation:

| Change | Verb Terraform reports | Evidence |
|---|---|---|
| `content` (via `-var log_level=debug`) | `must be replaced` | `} # forces replacement`, `Plan: 1 to add, 0 to change, 1 to destroy` |
| `filename` (via `-var output_dir=elsewhere`) | `must be replaced` ×4 | `~ filename = "generated/…" -> "elsewhere/…" # forces replacement` |
| `file_permission` (`0644` → `0640`) | `must be replaced` ×3 | `~ file_permission = "0644" -> "0640" # forces replacement` |
| `var.environment` (`local` → `dev`) | `must be replaced` ×5 | rotates the `keepers`, so the password goes too |

`0 to change` is therefore not a property of this plan — it is a property of the
provider. No edit to this configuration will ever produce an in-place update.

### Per-resource classification

| Class | Resources | Consequence |
|---|---|---|
| **Recreated (destroy + create)** | all 4 files, on any content, filename or mode change | The file is unlinked and rewritten. Not atomic: a reader in that window gets ENOENT, not a stale value. Sub-millisecond locally, but it is a real window, and `app.config.json` is the file a running process would re-read. |
| **Recreated, with a consequence beyond the file** | `random_password.session_secret` | Replacement cascades into `api_env`. Every signed session becomes invalid at once — the same failure the audit flags on `aws_ssm_parameter.SESSION_SECRET`. Guarded by `keepers`, which is the only reason a routine `apply` does not do this. |
| **Modified in place** | none, ever | The provider offers no update path. |
| **No-op** | all 5, on a converged tree | Confirmed: a second `plan` after `apply` reports `No changes. Your infrastructure matches the configuration.` |

### Worst realistic case

`terraform destroy`, or an `apply` after someone edits `output_dir`, with
`output_dir` pointed at the repo (`-var 'output_dir=../..'`). That deletes a
developer's `api/.env.local` and `web/.env.local`.

Bounded three ways, deliberately:

1. `output_dir` defaults to `generated/`, which is `.gitignore`d and which
   nothing in the app reads. Rendering into the repo is opt-in.
2. The blast radius is four files in one directory. There is no cloud resource,
   no shared state, no other environment reachable from this root.
3. Recovery is `terraform apply`, or `pnpm dev` — which writes `api/.env.local`
   itself when it is missing.

Compare the same question asked of the existing AWS root, from the audit: worst
case there is `aws_rds_cluster` replacement destroying the production database,
with `deletion_protection` unset and `skip_final_snapshot` deciding whether a
backup survives. Both are `terraform apply`. That asymmetry is the argument for
keeping this root separate from that one rather than folding it in.

### What the plan does *not* tell you

- **A permissions change is invisible.** `chmod 0666` on the `0600` env file
  reports `No changes`, and `apply` does not repair the mode. Verified, not
  assumed — see `lane-8-drift-detection.md`. For a file holding a session secret
  that is a real gap, and it is a property of the provider, not of this config.
- **`sensitive = true` is a display control, not storage encryption.** The
  redacted values are written to `terraform.tfstate` in plaintext, and would be
  written to a saved plan in plaintext. `*.tfstate*`, `tfplan` and `*.tfplan` are
  ignored at any depth as of commit `07b640b`; finding W8-1 is what happens
  without that.

---

## Confirming the output matches intent (8.4)

| Intent | Assertion | Result |
|---|---|---|
| At least two local resources (p.8) | count of `local_*` resources in the plan | 4 |
| Nothing destroyed on first apply | `Plan:` line | `5 to add, 0 to change, 0 to destroy` |
| Secrets absent from plan output | `api_env.content` | `(sensitive value)` |
| Env file not world-readable | `api_env.file_permission` | `0600` (confirmed on disk: `-rw-------`) |
| Web env file readable, non-secret | `web_env.file_permission` | `0644` (`-rw-r--r--`) |
| Containing directories not world-readable | `directory_permission` | `0750` (`drwxr-x---`) |
| Provider versions exactly pinned | `terraform providers` / lock | `local 2.9.0`, `random 3.9.0` |
| Converges | second `plan` after `apply` | `No changes.` |
| Clean-machine runnable | `init` + `apply` with no credentials | 5 added, offline after provider download |

## Plan output for the AWS roots is still not obtainable

Unchanged from the audit, and stated here so this document is not mistaken for
covering the whole `terraform/` tree. `terraform plan` against the five AWS roots
needs remote state, which needs the backend bucket name from SSM, which needs AWS
credentials and the `aws` CLI. Neither exists on this machine. What is verified
for those roots by this lane is `terraform fmt -recursive -check` (clean) and
`terraform validate` (Success on all five, one pre-existing warning, finding
W8-8), run against a scratch copy with a local backend override so that neither
the repo's missing lock files nor its real backend were touched. The audit's
static blast-radius annotation for those 74 resources remains the coverage there.

---

## Full plan output, verbatim

From a clean checkout, `terraform plan`, `-no-color`:

```
Terraform used the selected providers to generate the following execution
plan. Resource actions are indicated with the following symbols:
  + create

Terraform will perform the following actions:

  # local_file.app_config will be created
  + resource "local_file" "app_config" {
      + content              = jsonencode(
            {
              + database    = {
                  + connectTimeoutMs = 5000
                  + poolMax          = 5
                  + statementTimeout = 30000
                }
              + environment = "local"
              + http        = {
                  + keepAliveTimeout = 65000
                  + requestTimeoutMs = 30000
                  + shutdownGraceMs  = 10000
                }
              + logging     = {
                  + format = "pretty"
                  + level  = "info"
                }
              + port        = 3000
              + service     = "shipshape-api"
              + session     = {
                  + absoluteTimeoutMinutes = 720
                  + idleTimeoutMinutes     = 15
                }
            }
        )
      + content_base64sha256 = (known after apply)
      + content_base64sha512 = (known after apply)
      + content_md5          = (known after apply)
      + content_sha1         = (known after apply)
      + content_sha256       = (known after apply)
      + content_sha512       = (known after apply)
      + directory_permission = "0750"
      + file_permission      = "0644"
      + filename             = "generated/app.config.json"
      + id                   = (known after apply)
    }

  # local_file.deploy_manifest will be created
  + resource "local_file" "deploy_manifest" {
      + content              = jsonencode(
            {
              + environment = "local"
              + gitSha      = "unknown"
              + providers   = {
                  + "hashicorp/local"  = "2.9.0"
                  + "hashicorp/random" = "3.9.0"
                }
              + renders     = [
                  + "api/.env.local",
                  + "web/.env.local",
                  + "app.config.json",
                ]
              + service     = "shipshape"
            }
        )
      + content_base64sha256 = (known after apply)
      + content_base64sha512 = (known after apply)
      + content_md5          = (known after apply)
      + content_sha1         = (known after apply)
      + content_sha256       = (known after apply)
      + content_sha512       = (known after apply)
      + directory_permission = "0750"
      + file_permission      = "0644"
      + filename             = "generated/deploy-manifest.json"
      + id                   = (known after apply)
    }

  # local_file.web_env will be created
  + resource "local_file" "web_env" {
      + content              = <<-EOT
            # Generated by terraform/local-config — do not edit by hand. Run 'terraform apply' in that directory to regenerate.
            VITE_API_URL=http://localhost:3000
            VITE_WS_URL=ws://localhost:3000
            VITE_APP_ENV=local
        EOT
      + content_base64sha256 = (known after apply)
      + content_base64sha512 = (known after apply)
      + content_md5          = (known after apply)
      + content_sha1         = (known after apply)
      + content_sha256       = (known after apply)
      + content_sha512       = (known after apply)
      + directory_permission = "0750"
      + file_permission      = "0644"
      + filename             = "generated/web/.env.local"
      + id                   = (known after apply)
    }

  # local_sensitive_file.api_env will be created
  + resource "local_sensitive_file" "api_env" {
      + content              = (sensitive value)
      + content_base64sha256 = (known after apply)
      + content_base64sha512 = (known after apply)
      + content_md5          = (known after apply)
      + content_sha1         = (known after apply)
      + content_sha256       = (known after apply)
      + content_sha512       = (known after apply)
      + directory_permission = "0750"
      + file_permission      = "0600"
      + filename             = "generated/api/.env.local"
      + id                   = (known after apply)
    }

  # random_password.session_secret will be created
  + resource "random_password" "session_secret" {
      + bcrypt_hash = (sensitive value)
      + id          = (known after apply)
      + keepers     = {
          + "environment" = "local"
        }
      + length      = 48
      + lower       = true
      + min_lower   = 0
      + min_numeric = 0
      + min_special = 0
      + min_upper   = 0
      + number      = true
      + numeric     = true
      + result      = (sensitive value)
      + special     = false
      + upper       = true
    }

Plan: 5 to add, 0 to change, 0 to destroy.

Changes to Outputs:
  + api_base_url      = "http://localhost:3000"
  + app_config_sha256 = (known after apply)
  + rendered_files    = {
      + api_env         = {
          + mode = "0600"
          + path = "generated/api/.env.local"
        }
      + app_config      = {
          + mode = "0644"
          + path = "generated/app.config.json"
        }
      + deploy_manifest = {
          + mode = "0644"
          + path = "generated/deploy-manifest.json"
        }
      + web_env         = {
          + mode = "0644"
          + path = "generated/web/.env.local"
        }
    }
  + session_secret    = (sensitive value)
```

`apply`, then `ls -l`:

```
Apply complete! Resources: 5 added, 0 changed, 0 destroyed.

-rw-------  1 joanmiguel  staff  367  generated/api/.env.local
-rw-r--r--  1 joanmiguel  staff  204  generated/web/.env.local
-rw-r--r--  1 joanmiguel  staff  328  generated/app.config.json
-rw-r--r--  1 joanmiguel  staff  195  generated/deploy-manifest.json
drwxr-x---  3 joanmiguel  staff   96  generated/api
```

---
---

# Part 2 — `terraform/render` (`render-oss/render`)

Requirement 8.2 (a second config declaring a Render web service), 8.4 (plan
output confirmed to match intent) and 8.7 (blast radius) for the Render half.
Requirements 8.5 and 8.6 are argued in `terraform/render/README.md`; the
evidence for 8.5 is the two sections below, "From a clean checkout" and
"Verifying against the live deployment".

Reproduce it:

```bash
git archive HEAD terraform/render | tar -x -C /tmp/clean
cd /tmp/clean/terraform/render
export TF_VAR_render_api_key=rnd_...     # or: set -a; source .env; set +a
export TF_VAR_render_owner_id=tea_...
terraform init && terraform plan
```

Environment: Terraform v1.15.8 (darwin_arm64), `render-oss/render` 1.9.1 —
exact pin, recorded in the committed `.terraform.lock.hcl`, verified as
partner-signed on install (key ID `E056C177173659B4`).

**Unlike Part 1, this plan is a live authenticated call to `api.render.com`.**
It is not obtainable without a working key, which is why it was recorded as
blocked until one was available. Nothing was applied — see "Why nothing was
applied" at the end.

## A note on redaction

Render resource identifiers (`srv-…`, `dpg-…`) are replaced with
`srv-<redacted>` / `dpg-<redacted>` wherever they appear in quoted output
below. They are account-scoped identifiers, not credentials, and this is the
same class of value as the AWS account ID that finding **W8-1** leaked through
a committed `tfplan`. The public service URL is left intact — it is a URL
anyone can already fetch. Everything else is verbatim.

---

## Summary

```
Plan: 2 to add, 0 to change, 0 to destroy.
```

| # | Address | Is | Replaces |
|---|---|---|---|
| 1 | `render_postgres.ship` | Managed PostgreSQL 16, `free` plan, oregon | Aurora + the hand-written `/ship/{env}/DATABASE_URL` SSM parameter |
| 2 | `render_web_service.shipshape` | Docker web service, 1 instance, built from the repo's root `Dockerfile` | Elastic Beanstalk + S3 + CloudFront, i.e. both deploy scripts |

Two resources rather than one because the brief's requirement is that the fork
is *deployable* from a clean machine, and ShipShape does not boot without a
database — `api/src/db/client.ts` connects at import and the container runs
`migrate` then `seed` before `node dist/index.js`. A config that declared only
the web service would plan cleanly and produce a crash-looping service.

---

## Every resource, and whether the change is safe

Brief p.8 bullet 2: *"for every resource it will create, modify, or destroy,
write one sentence explaining what it is and whether the change is safe."*

### 1 · `render_postgres.ship` — create

Managed PostgreSQL 16. **Safe to create; the only unrecoverable resource in
this configuration.** Render deletes the volume with the instance and the
`free` plan has no backups, which is why it carries `prevent_destroy = true`.

```
  # render_postgres.ship will be created
  + resource "render_postgres" "ship" {
      + connection_info           = (sensitive value)      <-- the whole object, not just the password
      + database_name             = (known after apply)    <-- deliberately unmanaged; see below
      + database_user             = (known after apply)
      + disk_size_gb              = (known after apply)
      + high_availability_enabled = (known after apply)
      + id                        = (known after apply)
      + ip_allow_list             = (known after apply)
      + log_stream_override       = (known after apply)
      + name                      = "ship-db"
      + plan                      = "free"
      + primary_postgres_id       = (known after apply)
      + region                    = "oregon"
      + role                      = (known after apply)
      + version                   = "16"
    }
```

`database_name` and `database_user` show `(known after apply)` because the
config does not set them, and that is the fix for a measured bug rather than an
omission. Render disambiguates the database name on create — ask for `ship` and
you get `ship_<suffix>` — so a literal in the config can never match what comes
back, and the attribute forces replacement. The transcript of that failure is in
"Verifying against the live deployment" below. It is the single most dangerous
thing that can be written in this file, and it looked completely innocuous.

### 2 · `render_web_service.shipshape` — create

The application: one Docker container serving the API, the WebSocket
collaboration endpoint and the built frontend from one origin. **Safe to
create.** Nothing pre-exists in this state, so a first apply cannot remove
anything.

```
  # render_web_service.shipshape will be created
  + resource "render_web_service" "shipshape" {
      + env_vars                      = {
          + "DATABASE_URL" = {
              + generate_value = false
              + value          = (sensitive value)
            },
          + "NODE_ENV" = {
              + generate_value = false
              + value          = (sensitive value)
            },
          + "SESSION_SECRET" = (sensitive value)
        }
      + health_check_path             = "/health"
      + max_shutdown_delay_seconds    = 60
      + name                          = "shipshape"
      + num_instances                 = 1
      + plan                          = "free"
      + region                        = "oregon"
      + runtime_source                = {
          + docker = {
              + auto_deploy         = false
              + auto_deploy_trigger = (known after apply)
              + branch              = "deploy/render"
              + context             = "."
              + dockerfile_path     = "./Dockerfile"
              + repo_url            = "https://github.com/joshdrochon/ship"
            }
        }
      + slug                          = (known after apply)
      + url                           = (known after apply)
    }
```

Three things in that block are worth reading closely.

**`DATABASE_URL` is `(sensitive value)`, not a string.** It is
`render_postgres.ship.connection_info.internal_connection_string` — a reference
resolved inside the graph. No connection string is typed by a human, stored in
a variable, or written to a `tfvars` file. The AWS path solves the same problem
with an SSM parameter somebody pastes a value into.

**`SESSION_SECRET` renders as a bare `(sensitive value)` rather than an object.**
That is `generate_value = true`: Render generates it. `api/src/app.ts:43` throws
at boot if it is missing under `NODE_ENV=production`, so it cannot be skipped,
and generating it is what keeps a clean-machine apply down to one credential.

**`NODE_ENV` is redacted too, and it is `"production"`.** The provider marks the
entire `value` attribute sensitive, so the plan cannot be used to review
non-secret configuration. That is the right default and a real cost: a reviewer
cannot tell from this plan whether `NODE_ENV` says `production` or `porduction`.
`terraform console` or the Render dashboard is where that gets checked.

---

## Blast radius

Brief p.8 bullet 3 asks for the worst case. Measured, one variable at a time,
by planning the committed config against the **live** service and database with
`import` blocks — so each row is what Terraform actually reported about real
infrastructure, not a reading of the provider docs.

```bash
# in a scratch copy, never in the repo
cat > zz_import.tf <<'EOF'
import { to = render_postgres.ship,          id = var.adopt_postgres_id }
import { to = render_web_service.shipshape,  id = var.adopt_service_id }
variable "adopt_postgres_id" { type = string }
variable "adopt_service_id"  { type = string }
EOF
terraform plan -var <one attribute changed>
```

| Changed | Verb Terraform reported | Plan line |
|---|---|---|
| *(nothing)* | import, one in-place update | `2 to import, 0 to add, 1 to change, 0 to destroy` |
| `service_plan` `free` → `starter` | update in place | `2 to import, 0 to add, 1 to change, 0 to destroy` |
| `service_name` | update in place | `2 to import, 0 to add, 1 to change, 0 to destroy` |
| `branch` → `main` | update in place | `2 to import, 0 to add, 1 to change, 0 to destroy` |
| `auto_deploy` → `true` | update in place | `2 to import, 0 to add, 1 to change, 0 to destroy` |
| `app_base_url` set | update in place | `2 to import, 0 to add, 1 to change, 0 to destroy` |
| `database_plan` → `basic_256mb` | update in place, **both** resources | `2 to import, 0 to add, 2 to change, 0 to destroy` |
| `postgres_version` `16` → `17` | **must be replaced** | `1 to import, 1 to add, 0 to change, 1 to destroy` — **blocked by `prevent_destroy`** |
| `render_region` → `ohio` | **both must be replaced** | `2 to import, 2 to add, 0 to change, 2 to destroy` — **blocked by `prevent_destroy`** |

The exact markers, from the region run:

```
  # render_postgres.ship must be replaced
      ~ region                    = "oregon" -> "ohio" # forces replacement
  # render_web_service.shipshape must be replaced
      ~ region                        = "oregon" -> "ohio" # forces replacement
Plan: 2 to import, 2 to add, 0 to change, 2 to destroy.
```

and from the version run:

```
      ~ version                   = "16" -> "17" # forces replacement
```

### Per-resource classification

| Class | Attributes | Consequence |
|---|---|---|
| **Modified in place** | web service: `plan`, `name`, `branch`, `auto_deploy`, `health_check_path`, `num_instances`, `max_shutdown_delay_seconds`, every `env_vars` entry. Database: `plan`, `disk_size_gb` | A new deploy, or a database resize. The service is briefly rolled; `health_check_path` gates the new instance, so a broken build does not take the old one down. |
| **Recreated (destroy + create)** | database: `region`, `version`, `database_name`, `database_user` | **Total, unrecoverable data loss.** Render deletes the volume. No `skip_final_snapshot` equivalent exists to argue about — there is no snapshot. |
| **Recreated** | web service: `region` | New service, new `onrender.com` URL, so every bookmark and any registered OAuth redirect URI breaks. Recoverable; not silent. |
| **No-op** | everything else, on a converged tree | The baseline import row above is the check: with the config unchanged, the database imports with **zero** planned changes. |

### Worst realistic case

Someone edits `render_region` — a one-word change that reads like a
relocation — and applies. That destroys the database and every document in it,
and moves the service to a new URL.

Bounded three ways:

1. **`prevent_destroy = true` on the database turns it into an error, not an
   outage.** This is not a hypothetical guard. It fired during the development
   of this configuration and caught a real bug, transcript below.
2. The apply stops at the first prevented destroy, so the web service is not
   replaced either — the failure is atomic in the direction that matters.
3. The blast radius is one Render account with one service and one database.
   There is no shared state, no other environment reachable from this root, and
   the AWS production stack is not in this configuration at all.

Compare the same question asked of `terraform/environments/prod`: worst case
there is `aws_rds_cluster` replacement destroying the Treasury database, with
`deletion_protection` unset — the audit's finding. Both are `terraform apply`.
The difference is that this root says `prevent_destroy` and that one does not.

### What the plan does *not* tell you

- **It does not tell you the deploy will succeed.** `plan` validates the Render
  API's view of the resource. Whether the Dockerfile builds, whether migrations
  apply, whether the process binds `$PORT` — none of that is visible until
  `apply`. `wait_for_deploy_completion = true` is what converts that into a
  failed apply instead of a green apply and a dead service.
- **Env var values are unreviewable.** All of them, secret or not, print as
  `(sensitive value)`.
- **State holds everything in plaintext.** `connection_info`, including the
  database password, and the generated `SESSION_SECRET`, are written to
  `terraform.tfstate` unencrypted, and would be written to a saved plan the same
  way. `*.tfstate*`, `tfplan` and `*.tfplan` are ignored at any depth as of
  commit `07b640b`. **No plan was ever saved with `-out=` while writing this
  document**, deliberately: finding W8-1 is what a saved plan in git looks like,
  and a Render API key is strictly worse than an account ID.

---

## Confirming the output matches intent (8.4)

| Intent | Assertion | Result |
|---|---|---|
| A config using the Render provider declaring a web service (p.8) | `render_web_service` resources in the plan | 1 |
| Nothing destroyed on first apply | `Plan:` line | `2 to add, 0 to change, 0 to destroy` |
| Provider version exactly pinned | `versions.tf` / lock | `render-oss/render 1.9.1`, `constraints = "1.9.1"` |
| Builds the repo's real image | `runtime_source.docker.dockerfile_path` | `./Dockerfile` |
| Deploys this fork | `runtime_source.docker.repo_url` / `branch` | `github.com/joshdrochon/ship` @ `deploy/render` |
| API key absent from plan output | any `rnd_` string in the plan | none — `sensitive = true` |
| Database URL absent from plan output | `env_vars["DATABASE_URL"].value` | `(sensitive value)` |
| Connection string absent from outputs | `outputs.tf` | `connection_info` is not exported |
| Health gate on rollout | `health_check_path` | `/health` |
| Single instance, given in-process Yjs state | `num_instances` | `1`, with a `validation` block refusing anything else |
| Database cannot be casually destroyed | `lifecycle.prevent_destroy` | `Error: Instance cannot be destroyed`, demonstrated twice above |

---

## From a clean checkout (8.5, first half)

The plan above was produced this way — `git archive HEAD`, so only committed
files exist, in a directory Terraform has never run in, with an environment
scrubbed down to two variables:

```bash
git archive HEAD terraform/render | tar -x -C /tmp/clean
cd /tmp/clean/terraform/render
env -i PATH="$PATH" HOME="$HOME" \
    TF_VAR_render_api_key=… TF_VAR_render_owner_id=… \
    terraform init
env -i PATH="$PATH" HOME="$HOME" \
    TF_VAR_render_api_key=… TF_VAR_render_owner_id=… \
    terraform plan
```

`env -i` is the point: no `AWS_PROFILE`, no `~/.aws`, no `.env`, no shell
history, nothing but `PATH` and `HOME`. Result:

```
- Reusing previous version of render-oss/render from the dependency lock file
- Installing render-oss/render v1.9.1...
- Installed render-oss/render v1.9.1 (signed by a HashiCorp partner, key ID E056C177173659B4)
Terraform has been successfully initialized!
...
Plan: 2 to add, 0 to change, 0 to destroy.
```

"Reusing previous version … from the dependency lock file" is the committed lock
doing its job: the version is chosen by the file in git, not by whatever the
registry serves today. Contrast the five AWS roots, four of which have no lock
file and none of which can `init` at all without the `aws` CLI and an SSM lookup
to find the backend bucket.

## Verifying against the live deployment (8.5, second half)

A create plan proves the config is *valid*. It does not prove it describes a
deployment that actually works. That needs a comparison against something
running.

There is one: this fork is deployed on Render right now, at
**https://shipshape-70uo.onrender.com**, serving `{"status":"ok"}` on `/health`,
from commit `6d8c505` — which is an ancestor of this branch. It was deployed by
hand, through the dashboard, before this configuration existed. That makes it
exactly the right thing to check the configuration against.

The check is `terraform plan` with `import` blocks: Terraform reads the live
resources and reports the difference between them and the config. It is
read-only — nothing is written to state without `apply`.

```
Plan: 2 to import, 0 to add, 1 to change, 0 to destroy.
```

**`0 to add, 0 to destroy`** is the claim. Every structural attribute matches
the running deployment: name, plan, region, repo, branch, Dockerfile path,
build context, PostgreSQL version. The database imports with no changes at all.

The `1 to change` is the web service, and every line of it is a deliberate
difference rather than a mismatch:

```
      ~ health_check_path             = "" -> "/health"
      + max_shutdown_delay_seconds    = 60
      + num_instances                 = 1
      ~ env_vars                      = {
          - "APP_BASE_URL" = { … } -> null
          - "CDN_DOMAIN"   = { … } -> null
          - "CORS_ORIGIN"  = { … } -> null
          ~ "SESSION_SECRET" = (sensitive value)
        }
        url                           = "https://shipshape-70uo.onrender.com"
        runtime_source                = { docker = { branch = "deploy/render", … } }   # unchanged
```

| Difference | Why |
|---|---|
| `health_check_path "" -> "/health"` | The live service has no health gate. Adding one is the improvement, not a transcription of what exists. |
| `max_shutdown_delay_seconds = 60` | Lets the collaboration server drain WebSockets instead of dropping them. |
| `num_instances = 1` | Made explicit so the `validation` block can enforce it. |
| Three env vars removed | `APP_BASE_URL`, `CORS_ORIGIN` and `CDN_DOMAIN` default to null and are omitted. `app_base_url` is restored on the documented second apply, once `terraform output service_url` exists. **Adopting this config against the live service without that second apply would remove them** — stated here because it is the one genuinely lossy line in the diff. |
| `SESSION_SECRET` shape change | `generate_value = true` regenerates it, which invalidates every live session at once. Pass `-var session_secret=…` to adopt without that. |

`url` is unchanged, which is the load-bearing detail: adopting this
configuration does not move the service.

### The bug this found

The first version of this check did not come back clean. It came back like
this:

```
  # render_postgres.ship must be replaced
  # (imported from "dpg-<redacted>")
  # Warning: this will destroy the imported resource
-/+ resource "render_postgres" "ship" {
      ~ database_name             = "ship_<suffix>" -> "ship" # forces replacement
        …
    }

Plan: 1 to import, 1 to add, 0 to change, 1 to destroy.

Error: Instance cannot be destroyed

  Resource render_postgres.ship has lifecycle.prevent_destroy set, but the plan
  calls for this resource to be destroyed.
```

The config said `database_name = "ship"`. Render had named the database
`ship_<suffix>`. A three-word line, `terraform validate` clean, `terraform plan`
clean against an empty state — and a planned destruction of a live database the
first time it met one. `prevent_destroy` is the only reason that is a paragraph
in a document rather than an incident. Both attributes are now unset, and the
comment in `main.tf` records why so the next engineer does not "tidy" them back
in.

That is also the honest answer to how much a create-only plan is worth: this
configuration passed one, and was still wrong.

## Why nothing was applied

`terraform apply` was **not** run. Two reasons, in order:

1. It creates infrastructure on someone's account. The plans in this document
   are `free`-tier, but that is a default in a variable, and the decision to
   spend belongs to the account owner rather than to whoever is running
   Terraform.
2. There is already a healthy deployment of this fork on that account. A create
   apply would stand up a *second* service and a *second* database next to it,
   and the `free` Postgres plan is limited per account.

What that leaves unproven is stated plainly: the create path has been verified
as far as `plan`, and its declared shape has been verified against a live
service that is serving traffic — but no `terraform apply` in this
configuration has ever built an image end to end. `terraform apply` against the
existing service, via the `import` blocks above, is the low-risk way to close
that gap, and it is a decision for the account owner.
