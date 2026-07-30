# Lane 8 — Drift detection with the local provider

Requirement 8.8. Brief p.8 bullet 2: *"using the local provider, write a
Terraform config that manages a local file resource. Manually edit the file
outside of Terraform to simulate a drift condition. Re-run `terraform plan` and
capture the diff showing what Terraform detects has changed."* Submission table,
p.11: *"Drift detection demonstration using the local provider."*

Run end to end against the committed configuration at
`terraform/local-config`, not a scratch copy — the audit's earlier demonstration
was deliberately kept outside the repo so it could not be mistaken for the
Phase 2 deliverable. This is the deliverable.

No credentials, no cloud account, no network past the initial provider download.
Terraform v1.15.8, `hashicorp/local` 2.9.0 (exact pin).

Reproduce:

```bash
cd terraform/local-config
terraform init && terraform apply -auto-approve
terraform plan                                        # step 1
echo '{"logging":{"level":"debug"},"port":8080,"service":"shipshape-api"}' \
  > generated/app.config.json                         # step 2
terraform plan                                        # step 3
terraform plan -refresh-only                           # step 4
terraform apply -auto-approve                          # step 5
```

---

## Step 1 — BEFORE: converged, no drift

```
$ terraform plan
random_password.session_secret: Refreshing state... [id=none]
local_file.web_env: Refreshing state... [id=4667c87c0f1a1698adf5ffc0d61136751a5872ff]
local_file.deploy_manifest: Refreshing state... [id=263802162041495f41c845df7b2de522f9363475]
local_file.app_config: Refreshing state... [id=667c5bc75f2ee3064d1682cd6237a3faa8e11d05]
local_sensitive_file.api_env: Refreshing state... [id=439b959008d7d6f100358ad87feaba5d0edc0beb]

No changes. Your infrastructure matches the configuration.

Terraform has compared your real infrastructure against your configuration
and found no differences, so no changes are needed.
```

Baseline hash, from `terraform output`:

```
app_config_sha256 = "9c0fa4d3bba5e55f308b4d1996c34d128ef25da9dead28fb8221f4f4fd4e57e8"
```

## Step 2 — the manual edit, outside Terraform

`port` 3000 → 8080, `logging.level` `info` → `debug`, and every other key
dropped:

```bash
echo '{"logging":{"level":"debug"},"port":8080,"service":"shipshape-api"}' \
  > generated/app.config.json
```

## Step 3 — AFTER: `terraform plan` detects it

```
$ terraform plan

Note: Objects have changed outside of Terraform

Terraform detected the following changes made outside of Terraform since the
last "terraform apply" which may have affected this plan:

  # local_file.app_config has been deleted
  - resource "local_file" "app_config" {
      - content_sha256       = "9c0fa4d3bba5e55f308b4d1996c34d128ef25da9dead28fb8221f4f4fd4e57e8" -> null
        id                   = "667c5bc75f2ee3064d1682cd6237a3faa8e11d05"
        # (9 unchanged attributes hidden)
    }


Unless you have made equivalent changes to your configuration, or ignored the
relevant attributes using ignore_changes, the following plan may include
actions to undo or respond to these changes.

─────────────────────────────────────────────────────────────────────────────

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
      + content_md5          = (known after apply)
      + content_sha256       = (known after apply)
      + directory_permission = "0750"
      + file_permission      = "0644"
      + filename             = "generated/app.config.json"
      + id                   = (known after apply)
    }

Plan: 1 to add, 0 to change, 0 to destroy.

Changes to Outputs:
  ~ app_config_sha256 = "9c0fa4d3bba5e55f308b4d1996c34d128ef25da9dead28fb8221f4f4fd4e57e8" -> (known after apply)
```

Read the verb: **`create`, not `update`.** The provider's Read stores a content
hash and compares it on refresh; when the hash no longer matches it clears the
resource ID, so Terraform concludes the object is *gone* rather than changed.
That is why the drift note says "has been deleted" about a file that is sitting
right there on disk with different contents. Anyone monitoring for drift by
grepping plan output for `~` or `must be replaced` will miss every instance of
this.

The `Changes to Outputs` line is the compact signal: `app_config_sha256` moving
to `(known after apply)` is drift, in one line, without reading the diff.

## Step 4 — `plan -refresh-only` attributes it explicitly

```
$ terraform plan -refresh-only

Note: Objects have changed outside of Terraform

  # local_file.app_config has been deleted
  - resource "local_file" "app_config" {
      - content              = jsonencode(
            {
              - database    = {
                  - connectTimeoutMs = 5000
                  - poolMax          = 5
                  - statementTimeout = 30000
                }
              - environment = "local"
              - http        = {
                  - keepAliveTimeout = 65000
                  - requestTimeoutMs = 30000
                  - shutdownGraceMs  = 10000
                }
              - logging     = {
                  - format = "pretty"
                  - level  = "info"
                }
              - port        = 3000
              - service     = "shipshape-api"
              - session     = {
                  - absoluteTimeoutMinutes = 720
                  - idleTimeoutMinutes     = 15
                }
            }
        ) -> null
      - content_base64sha256 = "nA+k07ul5V8wi00ZlsNNEo7yXanerSj7giH09P1OV+g=" -> null
      - content_md5          = "fcb9a9ba8a7e0fa61fc9b6914cc588c2" -> null
      - content_sha1         = "667c5bc75f2ee3064d1682cd6237a3faa8e11d05" -> null
      - content_sha256       = "9c0fa4d3bba5e55f308b4d1996c34d128ef25da9dead28fb8221f4f4fd4e57e8" -> null
      - directory_permission = "0750" -> null
      - file_permission      = "0644" -> null
      - filename             = "generated/app.config.json" -> null
      - id                   = "667c5bc75f2ee3064d1682cd6237a3faa8e11d05" -> null
    }

This is a refresh-only plan, so Terraform will not take any actions to undo
these.
```

`-refresh-only` is the right command for a drift *check* in CI: it separates
"something changed out of band" from "the configuration wants changes," and it
cannot be mistaken for a plan you should apply.

## Step 5 — `apply` restores the declared content

```
$ terraform apply -auto-approve
Apply complete! Resources: 1 added, 0 changed, 0 destroyed.

$ cat generated/app.config.json
{"database":{"connectTimeoutMs":5000,"poolMax":5,"statementTimeout":30000},"environment":"local","http":{"keepAliveTimeout":65000,"requestTimeoutMs":30000,"shutdownGraceMs":10000},"logging":{"format":"pretty","level":"info"},"port":3000,"service":"shipshape-api","session":{"absoluteTimeoutMinutes":720,"idleTimeoutMinutes":15}}

$ terraform plan
No changes. Your infrastructure matches the configuration.
```

Converged. `port` is 3000 again and `logging.level` is `info`.

---

## The limits of this detection

Every row was run, not reasoned about. Two of the five are gaps, and the second
one matters for what p.8 proposes managing with this provider.

| # | Scenario | Detected? | Plan says |
|---|---|---|---|
| 1 | Content edited in place | **yes** | `has been deleted` → `Plan: 1 to add, 0 to change, 0 to destroy` |
| 2 | File deleted outside Terraform | **yes** | `local_file.deploy_manifest will be created` → `Plan: 1 to add` |
| 3 | Content of a `local_sensitive_file` edited | **yes**, and the diff stays redacted | `content = (sensitive value)` → `Plan: 1 to add` |
| 4 | **Permissions changed, content untouched** | **NO** | `No changes.` |
| 5 | **`apply` after a permissions change** | **does not repair** | `Resources: 0 added, 0 changed, 0 destroyed` |

### Scenario 3 — drift in a secret-bearing file stays redacted

The API env file was overwritten with `SESSION_SECRET=attacker-controlled`.
Terraform detects it and the tampered value never reaches the terminal:

```
  # local_sensitive_file.api_env will be created
  + resource "local_sensitive_file" "api_env" {
      + content              = (sensitive value)
      + file_permission      = "0600"
      + filename             = "generated/api/.env.local"
    }

Plan: 1 to add, 0 to change, 0 to destroy.
```

One wrinkle: a plain `plan` shows no "Objects have changed outside of Terraform"
note for this resource, because every changed attribute is sensitive and the note
is elided. `plan -refresh-only` does report it, with `content = (sensitive value)
-> null` and the content hashes in the clear. So drift on a *secret* file is
detected but is less obviously *attributed* to an out-of-band change than drift
on a plain file — worth knowing if you are writing the CI check.

### Scenario 4 and 5 — the permissions blind spot

```
$ chmod 0666 generated/api/.env.local
$ ls -l generated/api/.env.local
-rw-rw-rw-  1 joanmiguel  staff  367  generated/api/.env.local

$ terraform plan
No changes. Your infrastructure matches the configuration.

$ terraform apply -auto-approve
Apply complete! Resources: 0 added, 0 changed, 0 destroyed.

$ ls -l generated/api/.env.local
-rw-rw-rw-  1 joanmiguel  staff  367  generated/api/.env.local
```

The mode stays world-writable through a full plan/apply cycle. Verified rather
than assumed, because it is a claim about provider behaviour: a fresh create from
an absent file *does* honour `file_permission = "0600"` (`-rw-------` confirmed on
disk), and a content edit after the `chmod` is still detected — so the blind spot
is specific to file mode, not a broken demo.

This matters because p.8 proposes managing **environment files** with this
provider, and `local_sensitive_file.api_env` holds a database URL and a session
secret at `0600`. `terraform plan` will not notice if that becomes `0666`, and
`terraform apply` will not fix it. Also note the asymmetry: `file_permission`
forces replacement when *the configuration* changes it (`0644` → `0640` reports
`must be replaced`), but is not read back from disk during refresh. Terraform
tracks the value it wrote, not the value on the filesystem.

If the mode matters, enforce it outside Terraform — the check belongs in
`start.sh` or CI, not in a `plan`.

---

## Wiring this into CI

The reason to prefer `-refresh-only` and a non-zero exit code over eyeballing a
diff:

```bash
cd terraform/local-config
terraform init -input=false
terraform plan -refresh-only -detailed-exitcode -input=false
# exit 0 = no drift, 2 = drift detected, 1 = error
```

Not added to `.gitlab-ci.yml` by this lane — CI ownership sits with the lane that
holds rule 4, and a drift check needs the state file to be somewhere CI can read
it, which this root deliberately does not have. Recorded here as the next step.
