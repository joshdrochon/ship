# Credentials — where they live and what they can do

**This file contains no secrets and must never contain any.** It records *where* each
credential is and *what it is allowed to do*, so nobody re-derives that by trial and error.

`.env` at the repo root holds the values. It is gitignored (`.gitignore:12`) and untracked.
Load it with:

```bash
set -a; source .env; set +a
```

**Never print a value.** Not to a terminal, not into a commit, not into a chat transcript.
A GitLab runner token was printed once during this project and had to be rotated; the
redaction that was supposed to prevent it used `\s`, which BSD `sed` on macOS does not
support, so the substitution silently did nothing. If you must redact, do it in `python3`,
or run `sed` inside a Linux container.

---

## GitLab — `labs.gauntletai.com`

**There are two, and they are not interchangeable. This has cost hours.**

| | Where | Scope | Can do |
|---|---|---|---|
| Keychain credential | macOS keychain, via `git credential fill` | read-only on the API | `git push`, `git fetch`, **read** API |
| `GITLAB_TOKEN` | `.env` | `api` | everything below |

The keychain one is what `git push` uses, so it is the one you reach for first — and it
returns **403 `insufficient_scope`** on every write. That looks like "the API will not let
me do this," and it is not. Use `GITLAB_TOKEN`.

```bash
# read (either token works)
TOK=$(printf 'protocol=https\nhost=labs.gauntletai.com\n\n' | git credential fill | sed -n 's/^password=//p')

# write — MRs, merges, pipeline retries, project settings
set -a; source .env; set +a          # exports GITLAB_TOKEN
curl -H "PRIVATE-TOKEN: $GITLAB_TOKEN" ...
```

**You can create and merge merge requests directly.** Do not hand the user a
`/merge_requests/new?...` URL and ask them to click it unless they have asked to review it
themselves.

```bash
# create
curl -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" -H "Content-Type: application/json" \
  "https://labs.gauntletai.com/api/v4/projects/joshrochon%2Fship/merge_requests" \
  -d '{"source_branch":"...","target_branch":"main","title":"...","description":"..."}'

# merge, or arm it to merge when the pipeline finishes
curl -X PUT -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  ".../merge_requests/<iid>/merge" -d '{"merge_when_pipeline_succeeds": true}'
```

Also reachable with the same token: pipelines, jobs, **job traces** (`/jobs/<id>/trace` —
the fastest way to find out why CI failed), retries, and cancels.

### The runner

`shipshape-local-Joans-MBP` is a **container on the user's laptop**, config bind-mounted at
`~/.gitlab-runner-shipshape/`. It is the only runner for this project.

- If a pipeline sits `pending` with nothing running, the container is probably not up.
- `docker ps -q | xargs docker rm -f` **kills it**. Do not blanket-remove containers.
- Restart: `docker run -d --name gitlab-runner-shipshape --restart always -v "$HOME/.gitlab-runner-shipshape":/etc/gitlab-runner -v /var/run/docker.sock:/var/run/docker.sock gitlab/gitlab-runner:latest`
- It runs inside a 7.8 GB Docker VM and is roughly 5× slower per test than GitHub's runners.

---

## GitHub — `joshdrochon/ship`

| | Where | Notes |
|---|---|---|
| `gh` CLI | `gh auth login` (device flow) | **required for job logs** |
| `GH_TOKEN` | `.env` | used as the ghcr.io registry credential |

Unauthenticated API reads work for public metadata, but **job logs and artifacts need
auth** — `gh run view <id> --log-failed` is the single most useful command when CI fails and
it does not work without `gh auth login`. Ask the user to run `! gh auth login` rather than
reasoning from a failure you cannot read.

The unauthenticated API allows 60 requests/hour. A polling loop will exhaust it in minutes
and then every read returns an error that parses as "unknown" — pace polls at 60 s or more.

---

## Render — `shipshape-70uo.onrender.com`

| | Where |
|---|---|
| `RENDER_API_KEY` | `.env` |
| `RENDER_OWNER_ID`, `RENDER_SERVICE_ID`, `RENDER_POSTGRES_ID` | `.env` |

There is **no Render dashboard password** on this machine — the account is GitHub SSO. Do
not go looking for one.

**Terraform is not currently a working deploy path.** `terraform/render/` is correct code,
but no state file exists in the repo or any worktree and there is no remote backend, so
`terraform plan` reports **"3 to add"** — applying would create a *second* service and
database beside the live one. Deploy through the API against the existing service id:

```bash
set -a; source .env; set +a
# 1. point it at an image CI already built and pushed
curl -X PATCH -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" \
  "https://api.render.com/v1/services/$RENDER_SERVICE_ID" \
  -d "{\"image\":{\"ownerId\":\"$RENDER_OWNER_ID\",\"imagePath\":\"ghcr.io/joshdrochon/ship:<full-sha>\"}}"
# 2. deploy
curl -X POST -H "Authorization: Bearer $RENDER_API_KEY" \
  "https://api.render.com/v1/services/$RENDER_SERVICE_ID/deploys" -d '{}'
# 3. verify — /health returns the sha the Dockerfile baked in
curl -s https://shipshape-70uo.onrender.com/health
```

The nested `{"image": {...}}` form is required; a top-level `imagePath` is accepted and
silently ignored. The image must already exist on ghcr.io — the `docker-image` CI job
pushes `ghcr.io/joshdrochon/ship:<full-sha>` on every push.

The service is on Render's **free** plan: it cold-starts (first request ~30 s) and the
database is deleted 30 days after creation.

---

## Application logins (not secrets — seeded demo data)

`api/src/db/seed.ts`:

```
dev@ship.local           / admin123    super admin
bob.martinez@ship.local  / admin123    non-admin
```

---

## Quick answers to things that have been re-derived more than once

| Question | Answer |
|---|---|
| Can I open a GitLab MR myself? | Yes — `GITLAB_TOKEN` from `.env`, not the keychain one |
| Can I merge it? | Yes, including merge-when-pipeline-succeeds |
| Why is the GitLab API 403-ing? | Wrong token. Use `GITLAB_TOKEN` |
| Can I read why GitHub CI failed? | Only with `gh auth login`. Ask the user to run it |
| Can I read why GitLab CI failed? | Yes — `/jobs/<id>/trace`, no extra auth |
| Can I deploy to Render? | Yes, via the API. **Not** via `terraform apply` |
| Is there a Render password? | No. GitHub SSO |
