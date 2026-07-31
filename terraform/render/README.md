# `terraform/render` — ShipShape on Render

One `terraform apply` stands up the whole deployment: a managed PostgreSQL 16
instance, a web service running the container image CI published, and the wiring
between them. Requirements 8.2, 8.5 and 8.6 of the Category 8 improvement target.

**This directory does not build anything.** It deploys
`ghcr.io/joshdrochon/ship:<commit-sha>`, which `.github/workflows/ci.yml` built,
verified and pushed. That is Implementation Rule 5 — the artifact produced in CI
is the artifact that runs. Full lifecycle, including rollback, in
[`docs/artifact-lifecycle.md`](../../docs/artifact-lifecycle.md).

| | |
|---|---|
| Provider | `render-oss/render` **1.9.1**, exact `=` pin |
| Resources | `render_postgres.ship`, `render_web_service.shipshape`, optional `render_registry_credential.ghcr` |
| Credentials | one: a Render API key, from the environment (plus a `read:packages` PAT only if the image is private) |
| Source | a published image tag, not a git branch |
| State | local. No backend block, no S3, no SSM lookup |

---

## How to run it

```bash
cd terraform/render
export TF_VAR_render_api_key=rnd_...          # Render dashboard → Account → API Keys
export TF_VAR_render_owner_id=tea_...         # or usr_..., the owning team/user
terraform init
terraform plan  -var image_tag=<commit-sha>   # 2 to add, 0 to change, 0 to destroy
terraform apply -var image_tag=<commit-sha>
```

`image_tag` has no default and must be a git commit SHA — 7 to 40 lowercase hex.
Terraform refuses `latest` and every other floating tag:

```
image_tag must be a git commit SHA (7-40 lowercase hex). Floating tags like
'latest' are refused — pin the commit.
```

Both are deliberate. A deploy should be an explicit statement about which commit
goes live rather than something that happens by omission, and a floating tag
would make "which commit is running?" unanswerable — the question this whole
arrangement exists to answer. Use any SHA whose CI run published an image; the
job summary in Actions prints the exact command.

The repo root `.env` already exports the two credentials under those names, so
`set -a; source .env; set +a` is equivalent. `.env` is gitignored.

Then, once, to fill in the URL that only exists after the first apply:

```bash
terraform apply -var "app_base_url=$(terraform output -raw service_url)"
```

`APP_BASE_URL` is read by `api/src/services/caia.ts` to derive the OAuth
redirect URI. Nothing else needs it, so the app boots and serves without this
second apply — it is required only for the CAIA login path.

## How to test it

```bash
terraform fmt -check                              # clean
terraform validate                                # Success
terraform plan -var image_tag=<sha>               # 2 to add, 0 to change, 0 to destroy
terraform output -raw deployed_image              # ghcr.io/joshdrochon/ship:<sha>
curl -sf "$(terraform output -raw service_url)/health"
# {"status":"ok","revision":"<sha>"}
terraform plan -var image_tag=<sha>               # No changes, after an apply
```

The `revision` in that `/health` response and the tag in `deployed_image` must be
the same string. That is the end-to-end check that the artifact was promoted
rather than rebuilt: the SHA is baked into the image by the `Dockerfile`, so the
running process can only report it if it *is* the image CI built.
`terraform output verify_deployed_revision` prints the `curl` with the expected
answer already filled in.

`terraform plan` reaches the real Render API and fails on a bad key, so a clean
plan is also an authentication check.

To check this configuration against a service that already exists — the
fidelity test described under 8.5 below — see
`docs/audit/lane-8-annotated-plan.md`, "Verifying against the live deployment".

## How to roll it back

Two different things are called "roll back". Usually you want the first.

**Roll the app back to an earlier commit** — keep the service and database:

```bash
terraform apply -var image_tag=<older-sha>
```

That is the whole procedure. Nothing is rebuilt, so it cannot fail the way a
redeploy can: the image already exists, was already verified in CI, and already
ran. Confirm with `curl "$(terraform output -raw service_url)/health"`.

Caveat that belongs to the app, not to this configuration: **migrations do not
roll back.** The container runs `node dist/db/migrate.js` at start and there are
no down migrations, so reverting to an image from before a schema change leaves
the new schema in place. Fine for additive migrations, not for destructive ones.

Render's dashboard can also redeploy a previous deploy. Prefer the `apply` — the
dashboard route leaves the live service disagreeing with Terraform state.

**Tear the whole deployment down:**

```bash
terraform destroy
```

`render_postgres.ship` carries `prevent_destroy = true`, so `destroy` stops with
`Instance cannot be destroyed` and takes nothing with it. That is deliberate:
the free plan has no backups and Render deletes the volume with the instance.
To really remove the database, delete the `lifecycle` block, then `destroy` —
two steps, because it should be two decisions.

To abandon the Terraform-managed deployment without deleting anything:

```bash
terraform state rm render_web_service.shipshape render_postgres.ship
rm -rf .terraform terraform.tfstate*
```

The AWS path is untouched by all of this. `scripts/deploy.sh` still works
exactly as before; nothing in `terraform/` outside this directory changed.

---

## What this replaces (requirement 8.6)

The manual path is two scripts, 292 lines, and they must be run in the right
order against infrastructure that already exists.

| Manual step | `scripts/…` | Replaced by |
|---|---|---|
| Pull environment config from SSM | `deploy.sh:69` → `sync-terraform-config.sh` | Terraform variables, resolved from the graph |
| `pnpm build:shared && pnpm build:api` on the operator's laptop | `deploy.sh:106` | `Dockerfile` stage 1, in CI — once, not per environment |
| Verify `schema.sql` and migration counts survived the build | `deploy.sh:110-127` | `Dockerfile` `RUN test -f …` assertions, at build time |
| Local Docker build + container smoke test | `deploy.sh:129-174` | the CI `docker-image` job builds and smoke-tests it; `health_check_path = "/health"` gates the rollout |
| `zip -r /tmp/api-$VERSION.zip …` | `deploy.sh:179` | none — the container image *is* the bundle, pulled by tag |
| `aws s3 cp` the bundle | `deploy.sh:205` | none |
| `aws elasticbeanstalk create-application-version` | `deploy.sh:207` | Render deploy, created by the provider |
| `aws elasticbeanstalk update-environment` | `deploy.sh:213` | same apply |
| `pnpm build:web` | `deploy-frontend.sh:52` | `Dockerfile` stage 1, same single CI build |
| `aws s3 sync web/dist/ s3://…` | `deploy-frontend.sh:56` | none — `api/src/app.ts:250-258` serves `web/dist` from the same process |
| `aws s3 cp index.html` with a shorter cache header | `deploy-frontend.sh:59` | same |
| CloudFront invalidation | `deploy-frontend.sh:63` | none — no CDN in front of it |
| Create `/ship/{env}/DATABASE_URL` in SSM by hand | out of band | `render_postgres.ship.connection_info.internal_connection_string`, read through the graph |
| Create `/ship/{env}/SESSION_SECRET` by hand | out of band | `generate_value = true` |
| Watch `describe-environments` for health | `deploy.sh:220` | `wait_for_deploy_completion = true` — the apply blocks and fails on a failed build |

Four things change in kind, not just in tooling:

1. **The artifact is not built here at all — it is promoted.** `deploy.sh`
   compiles locally and zips `api/dist`, so what reaches production is whatever
   was on that laptop. This directory deploys
   `ghcr.io/joshdrochon/ship:<sha>`, the image CI already built and verified.

   Note the earlier draft of this file claimed the win was that Render "builds
   the Dockerfile at a named branch… built from the git ref, not the operator's
   working tree." That is a genuine improvement over `deploy.sh` but it is **not
   Implementation Rule 5.** Building from a ref is still rebuilding per
   environment: Render's builder and CI's builder can produce different images
   from the same commit, and nothing ever compared them. Rule 5 asks for the CI
   artifact to *be* the production artifact, which needs an image source, not a
   git source.
2. **The frontend is not deployed separately.** One image, one origin, one
   deploy. There is no window in which the S3 bundle and the API disagree about
   the API contract, and no CloudFront invalidation to forget. Same-origin is
   also load-bearing rather than incidental: the session cookie is
   `sameSite: 'strict'`, so a frontend on another domain could never send it.
3. **No secret is typed by a human.** The database URL is a resource reference;
   the session secret is provider-generated. The SSM path required someone to
   paste a connection string into a parameter, and `terraform/ssm.tf` still
   carries that shape.
4. **A failed deploy fails the command.** `deploy.sh` returns as soon as AWS
   accepts the version and prints a `describe-environments` invocation for you
   to run yourself.

### What it does not replace

Everything AWS-side stays. `terraform/` still manages the VPC, Aurora,
Elastic Beanstalk, CloudFront and WAF for `ship.awsdev.treasury.gov`, and
`scripts/deploy.sh prod` is still how that environment is deployed. This
directory is the second, independent deployment target the brief asks for —
not a migration of the Treasury one, which would require a decision about
Aurora, about the CAIA OAuth registration, and about the WAF rules that nobody
has made.

---

## What a clean machine still needs (requirement 8.5, honestly)

`terraform apply` from a fresh clone needs, beyond Terraform itself:

1. **A Render API key and the owner id**, exported as `TF_VAR_render_api_key`
   and `TF_VAR_render_owner_id`. Two environment variables, no files, no
   `aws configure`, no `~/.aws/credentials`. Compare the AWS roots, which cannot
   even `terraform init` without the `aws` CLI and an SSM lookup to discover the
   backend bucket name.
2. **A published image to point at.** `terraform apply -var image_tag=<sha>`
   needs that tag to exist in `ghcr.io/joshdrochon/ship`, which
   `.github/workflows/ci.yml` pushes on every branch push. If the package is
   public, that is all — Render pulls it anonymously.
3. **Nothing else.** No Docker daemon, no `pnpm`, no `zip`, no network path to
   an S3 bucket.

This section used to carry a different point 2: "the git repository connected to
that Render account — `joshdrochon/ship` is private, so Render needs its GitHub
OAuth connection already authorised for the owner. Terraform cannot create that,
it is a browser consent flow." True of `runtime_source.docker`, and the reason
this README said "one credential and one prior consent" rather than the brief's
"deployable using only `terraform apply`".

It is gone. Pulling a published image needs no repository connection at all, so
with a public package the qualification disappears: a Render API key, an owner
id, and `terraform apply`.

If the ghcr.io package is kept private, Render needs a GitHub PAT with
`read:packages`:

```bash
export TF_VAR_registry_username=joshdrochon
export TF_VAR_registry_token=ghp_...        # read:packages only — Render never pushes
```

That creates `render_registry_credential.ghcr`. Both variables default to null
and the resource is not created unless both are set. The token lands in
`terraform.tfstate` in plaintext, which is why the public-package path is the
default rather than the fallback.

---

## What this does not solve

Two properties of the application, not of this configuration. They are the
reason `num_instances` has a validation rule pinning it to 1.

- **Collaboration state lives in process memory.** `api/src/collaboration/index.ts`
  holds Yjs documents in module-level `Map`s. Two instances serve divergent
  documents to two users editing the same page, and neither ever learns. Scaling
  past one instance needs a shared Yjs persistence layer first; until then the
  variable refuses the value.
- **The free plan sleeps and expires.** A `free` web service sleeps after 15
  minutes idle — the first request afterwards pays a cold start, including the
  migrate-and-seed the container does at boot. A `free` database is **deleted by
  Render 30 days after creation**, with its data. `terraform output
  postgres_plan_expiry_warning` says so on every apply. For anything that must
  survive a month, set `database_plan` to `basic_256mb` or larger and
  `service_plan` to `starter` — both are billable.
