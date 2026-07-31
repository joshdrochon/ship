# Artifact lifecycle

How a commit becomes a running deployment, and how to find out which commit is
running right now.

Implementation Rule 5:

> Build artifacts must be produced once and promoted through environments —
> never rebuilt per environment. The artifact produced in CI must be the artifact
> that runs in production. Tag each artifact with the git commit SHA.

This page is the documentation that rule asks for. It closes audit finding F26.

---

## The short version

```bash
# What is running?
curl -s https://<host>/health
# {"status":"ok","revision":"c43276832cabea468f88aaf511ccf816ed676965"}

# Deploy a commit CI has already built
cd terraform/render
terraform apply -var image_tag=<sha>

# Roll back
terraform apply -var image_tag=<older-sha>
```

There is no build step in any of those commands. That is the point.

---

## Where the artifact is built

**One place: `.github/workflows/ci.yml`, job `docker-image`.**

It runs after `build`, `lint`, `type-check` and `test` pass, builds the root
`Dockerfile`, verifies the image, and pushes it to
`ghcr.io/joshdrochon/ship:<sha>`.

Nothing else builds a deployable image. Render does not. `terraform apply` does
not. That is the whole change — see "What this replaced" below.

### Why ghcr.io and not the GitLab registry

`.gitlab-ci.yml` is the pipeline that gates merges, so its registry would have
been the natural home. **The GitLab instance does not run one.**

```
$ curl 'https://labs.gauntletai.com/jwt/auth?service=container_registry'
{"errors":[{"code":"UNAVAILABLE","message":"registry not enabled"}]}   HTTP 404

GET /api/v4/projects/1609                        → container_registry_image_prefix: null
GET /api/v4/projects/1609/registry/repositories  → []
```

The project's `container_registry_access_level` reads `enabled`, which is what
makes this confusing: the per-project setting is on, the instance-wide service is
not deployed. So `$CI_REGISTRY_IMAGE` expands to an empty string inside a job.
That is not a missing credential — there is nothing to authenticate to.

It also had a visible cost. The old job ran:

```
docker build -t "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA" -t "$CI_REGISTRY_IMAGE:latest" .
ERROR: invalid tag ":c43276832cabea468f88aaf511ccf816ed676965": invalid reference format
```

which failed **every `main` pipeline for five consecutive commits**, up to and
including `c432768`. The other eight jobs were green, and `docker-image` only
runs on `main`, so every lane and integration branch looked clean while the
default branch was red.

ghcr.io is reachable, is backed by the `github.com/joshdrochon/ship` remote the
repo already has, and needs **no credential to be provisioned**: Actions issues
`GITHUB_TOKEN` with `packages: write` to the job itself. Pushing to ghcr.io from
GitLab instead would have required a long-lived GitHub PAT in a masked CI
variable — a worse trade for the same result.

`.gitlab-ci.yml`'s `docker-image` job still builds the image and asserts the SHA
is inside it. It no longer pretends to publish.

---

## How it is tagged

The commit SHA is recorded in four places, and CI fails if they disagree.

| Where | Set by | Read with |
|---|---|---|
| Registry tag | `.github/workflows/ci.yml` | `docker pull ghcr.io/joshdrochon/ship:<sha>` |
| `org.opencontainers.image.revision` label | `Dockerfile` `LABEL` | `docker inspect` |
| `GIT_SHA` env var in the image | `Dockerfile` `ARG`→`ENV` | `docker inspect` / inside the container |
| `revision` in `GET /health` | `api/src/app.ts` | `curl /health` |

The chain is: CI passes `--build-arg GIT_SHA=<sha>` → `Dockerfile` turns that
`ARG` into a `LABEL` and an `ENV` → `api/src/app.ts` reads `process.env.GIT_SHA`
at module load and returns it from `/health`.

A registry tag on its own would not have been enough. A tag is a pointer someone
can move, and it is invisible from inside a running container — you cannot ask a
live service which tag it was pulled as. The label and the env var travel *with*
the image.

**When `GIT_SHA` is absent the field reads `"unknown"`,** not empty and not
missing. `pnpm dev`, a bare `docker build .`, and anything not built by CI all
take that branch and keep working. A production `/health` reporting `"unknown"`
is itself the signal that something was deployed outside this pipeline.

---

## How it moves from CI to Render

```
git push
   │
   ▼
.github/workflows/ci.yml
   build · lint · type-check · test      ← must pass first
   │
   ▼
   docker build --build-arg GIT_SHA=<sha>
   │
   ├─ assert label   org.opencontainers.image.revision == <sha>
   ├─ assert env     GIT_SHA == <sha>
   ├─ assert         GET /health → {"revision":"<sha>"}      ← container actually run
   │
   ▼
   docker push ghcr.io/joshdrochon/ship:<sha>
   │
   ▼
terraform apply -var image_tag=<sha>          ← a human decision, not automatic
   │
   ▼
Render pulls that exact image. No builder. No clone. No compile.
```

The Terraform side is `runtime_source.image` in `terraform/render/main.tf`:

```hcl
runtime_source = {
  image = {
    image_url = var.image_repository   # ghcr.io/joshdrochon/ship
    tag       = var.image_tag          # the commit SHA
  }
}
```

`var.image_tag` has **no default** and is validated against `^[0-9a-f]{7,40}$`.
Both are deliberate:

- No default means a deploy is always an explicit statement about which commit
  goes live. It cannot happen by omission.
- The regex refuses `latest` and every other floating tag. A floating tag deploys
  whatever moved there last, which is exactly the "what is actually running?"
  question this page exists to answer.

`:latest` is still pushed for humans browsing the registry. It is never a deploy
target.

---

## How to verify which SHA is live

```bash
cd terraform/render
terraform output -raw deployed_image     # ghcr.io/joshdrochon/ship:<sha>  — what Terraform believes
curl -s "$(terraform output -raw service_url)/health"
# {"status":"ok","revision":"<sha>"}     — what the process reports
```

Those two must match. If they do not, either the apply has not finished or
something was deployed out of band.

`terraform output verify_deployed_revision` prints the exact `curl` with the
expected answer filled in.

To check the artifact without running it:

```bash
docker pull ghcr.io/joshdrochon/ship:<sha>
docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
  ghcr.io/joshdrochon/ship:<sha>
```

And to get from a SHA back to the source: `git show <sha>`.

---

## How to roll back

```bash
cd terraform/render
terraform apply -var image_tag=<previous-sha>
```

That is the whole procedure. Nothing is rebuilt, so a rollback cannot fail the
way a redeploy can — the image already exists, was already tested, and already
ran. Confirm with `curl /health` as above.

To find a previous SHA: `git log --oneline main`, or the package's version list
on ghcr.io. Any commit whose CI run pushed an image is a valid rollback target.

Two caveats that are properties of the app, not of this pipeline:

- **Database migrations are not rolled back.** The container runs
  `node dist/db/migrate.js` at start (`Dockerfile` `CMD`), and there are no down
  migrations. Rolling the image back to before a schema change leaves the new
  schema in place. That is safe for additive migrations and is not safe for
  destructive ones.
- **Render's own rollback exists too** — the dashboard can redeploy a previous
  deploy — but using it puts the live service out of sync with Terraform state.
  Prefer `terraform apply`, so the configuration keeps describing reality.

---

## The Elastic Beanstalk path

`scripts/deploy.sh` deploys the Treasury AWS environment
(`ship.awsdev.treasury.gov`). It is **not** Rule 5-compliant and this change does
not make it so: it still compiles on the operator's machine and builds a fresh
image per deploy.

What did change is that the artifact is now identifiable:

- The version label is `git rev-parse HEAD`, not `v$(date +%Y%m%d%H%M%S)`. A
  timestamp recorded when somebody ran the script and nothing about what they
  deployed.
- **The script refuses to run against a dirty working tree.** Without that the
  SHA label would be a lie — the script compiles the working tree, so
  uncommitted edits mean the label names a commit that is not what shipped. There
  is no override flag; commit or stash.
- The local Docker smoke build gets `--build-arg GIT_SHA`, so its `/health`
  reports the same SHA the version label carries.

Migrating that environment to promote the CI artifact means deciding about
Aurora, the CAIA OAuth registration and the WAF rules. Nobody has made those
decisions, so the honest state is: one deployment target (Render) promotes, one
(Elastic Beanstalk) rebuilds and now says which commit it rebuilt.

---

## What this replaced

Before, three independent builds of the same source existed and none promoted
any other:

| Build | Fate |
|---|---|
| GitLab CI `docker-image` → `$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA` | tag was invalid (no registry); job failed on every `main` pipeline |
| GitHub Actions `docker-image` | `push: false` — built, then discarded |
| Render, `runtime_source.docker` | cloned the branch and built its **own** image |
| `scripts/deploy.sh` | compiled on the operator's laptop, `VERSION="v$(date …)"` |

No deployed artifact carried a commit SHA, and `/health` returned
`{"status":"ok"}` with no version, so "which commit is in production?" had no
answer at all.

A note on wording, because it was nearly the fix: describing Render's git build
as *"built from the git ref, not the operator's working tree"* is a real
improvement over `deploy.sh`, but it is not Rule 5. Building from a ref is still
**rebuilding per environment** — Render's builder can produce a different image
from the same commit as CI's, and nothing compares them. Promotion means the
bytes CI tested are the bytes that run.

### Side effect: `terraform apply` is now the whole story

`runtime_source.docker` required the Render account to have an authorised GitHub
OAuth connection for the private repo. Terraform cannot create that — it is a
browser consent flow — which is why `terraform/render/README.md` said "one
credential and one prior consent" rather than the brief's "deployable using only
`terraform apply`".

Pulling a published image needs no repo connection. If the ghcr.io package is
public, the qualification is gone entirely: a Render API key, an owner id, and
`terraform apply`.

If the package is kept private, Render needs a GitHub PAT with `read:packages`,
supplied as `TF_VAR_registry_username` / `TF_VAR_registry_token`. That creates a
`render_registry_credential` resource. Both variables default to null and the
resource is not created unless both are set.

---

## Related files

| File | Role |
|---|---|
| `Dockerfile` | `ARG GIT_SHA` → `LABEL` + `ENV` |
| `api/src/app.ts` | `/health` returns `revision` |
| `api/src/routes/health.test.ts` | regression test for the `revision` field |
| `.github/workflows/ci.yml` | builds, verifies, **publishes** to ghcr.io |
| `.gitlab-ci.yml` | builds and verifies provenance; does not publish |
| `terraform/render/main.tf` | `runtime_source.image` — promotes, never builds |
| `terraform/render/variables.tf` | `image_repository`, `image_tag` and its validation |
| `scripts/deploy.sh` | AWS path; SHA-labelled, clean-tree-gated, still rebuilds |
