# Lane 8 — Annotated `terraform plan` with blast radius analysis

Requirement 8.7 (brief p.11: *"Annotated terraform plan output with blast radius
analysis"*) and 8.4 (p.8: *"Run `terraform plan` on each and confirm the output
matches intent"*).

**This is real plan output**, produced from a clean checkout of the committed
configuration, not a static annotation. That distinction matters here because the
Category 8 audit could not obtain plan output for the AWS stack at all — it needs
state, which needs an SSM lookup and AWS credentials — and substituted `validate`,
`providers` and `graph` rather than fabricating one. The `hashicorp/local` config
has no such dependency, so this document quotes the actual thing.

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
