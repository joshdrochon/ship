# `terraform/render` — ShipShape on Render

One `terraform apply` stands up the whole deployment: a managed PostgreSQL 16
instance, a web service built from the repo's root `Dockerfile`, and the wiring
between them. Requirements 8.2, 8.5 and 8.6 of the Category 8 improvement target.

| | |
|---|---|
| Provider | `render-oss/render` **1.9.1**, exact `=` pin |
| Resources | `render_postgres.ship`, `render_web_service.shipshape` |
| Credentials | one: a Render API key, from the environment |
| State | local. No backend block, no S3, no SSM lookup |

---

## How to run it

```bash
cd terraform/render
export TF_VAR_render_api_key=rnd_...          # Render dashboard → Account → API Keys
export TF_VAR_render_owner_id=tea_...         # or usr_..., the owning team/user
terraform init
terraform plan       # 2 to add, 0 to change, 0 to destroy
terraform apply
```

The repo root `.env` already exports both under those names, so
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
terraform fmt -check                 # clean
terraform validate                   # Success
terraform plan                       # 2 to add, 0 to change, 0 to destroy
curl -sf "$(terraform output -raw service_url)/health"   # {"status":"ok"}
terraform plan                       # No changes, after an apply
```

`terraform plan` reaches the real Render API and fails on a bad key, so a clean
plan is also an authentication check.

To check this configuration against a service that already exists — the
fidelity test described under 8.5 below — see
`docs/audit/lane-8-annotated-plan.md`, "Verifying against the live deployment".

## How to roll it back

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
| `pnpm build:shared && pnpm build:api` on the operator's laptop | `deploy.sh:106` | `Dockerfile` stage 1, on Render's builder |
| Verify `schema.sql` and migration counts survived the build | `deploy.sh:110-127` | `Dockerfile` `RUN test -f …` assertions, at build time |
| Local Docker build + container smoke test | `deploy.sh:129-174` | Render's build; `health_check_path = "/health"` gates the rollout |
| `zip -r /tmp/api-$VERSION.zip …` | `deploy.sh:179` | none — Render builds from the git ref |
| `aws s3 cp` the bundle | `deploy.sh:205` | none |
| `aws elasticbeanstalk create-application-version` | `deploy.sh:207` | Render deploy, created by the provider |
| `aws elasticbeanstalk update-environment` | `deploy.sh:213` | same apply |
| `pnpm build:web` | `deploy-frontend.sh:52` | `Dockerfile` stage 1 |
| `aws s3 sync web/dist/ s3://…` | `deploy-frontend.sh:56` | none — `api/src/app.ts:250-258` serves `web/dist` from the same process |
| `aws s3 cp index.html` with a shorter cache header | `deploy-frontend.sh:59` | same |
| CloudFront invalidation | `deploy-frontend.sh:63` | none — no CDN in front of it |
| Create `/ship/{env}/DATABASE_URL` in SSM by hand | out of band | `render_postgres.ship.connection_info.internal_connection_string`, read through the graph |
| Create `/ship/{env}/SESSION_SECRET` by hand | out of band | `generate_value = true` |
| Watch `describe-environments` for health | `deploy.sh:220` | `wait_for_deploy_completion = true` — the apply blocks and fails on a failed build |

Four things change in kind, not just in tooling:

1. **The artifact is built from the git ref, not from the operator's working
   tree.** `deploy.sh` compiles locally and zips `api/dist`, so what reaches
   production is whatever was on that laptop. Render builds the Dockerfile at a
   named branch. That is implementation rule 5 — the artifact that runs in
   production is the one built from the commit, not a rebuild of it.
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
2. **The git repository connected to that Render account.** `joshdrochon/ship`
   is private, so Render needs its GitHub OAuth connection already authorised
   for the owner. Terraform cannot create that — it is a browser consent flow.
   A public repo, or a `runtime_source.image` pointing at a published container
   image, would both remove this step; neither is what this fork does today.
3. **Nothing else.** No Docker daemon, no `pnpm`, no `zip`, no network path to
   an S3 bucket.

Point 2 is the reason this README says "one credential and one prior consent"
rather than "only `terraform apply`". The brief's phrasing is the goal; that is
the distance still between here and it.

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
