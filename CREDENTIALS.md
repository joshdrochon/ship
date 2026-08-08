# Deployed resources

> **No secrets are in this file, and none should ever be added to it.** Everything
> below is an identifier or a public URL — the kind of thing you would read off the
> Render dashboard. The actual credentials live in `.env` (gitignored) and are
> passed to Terraform as `TF_VAR_*` variables; `terraform/render/variables.tf`
> documents each one. If you came here looking for a key, you are in the wrong
> file on purpose.

The name is `FG-208`'s, and it is a slightly misleading one. What this records is
the answer to "which Render resources is this project currently pointing at" —
which changes every time the environment is rebuilt, and which nothing else wrote
down. The last rebuild is why this file exists at all: the service URL moved, and
`SUBMISSION.md` spent an unknown number of days linking a host that returned 404.

## Current environment

Rebuilt 2026-08-08 by `scripts/destroy-redeploy.sh`.

| Resource | Value |
|---|---|
| Web service URL | https://shipshape-fkub.onrender.com |
| Web service id | `srv-d9r8ns2jobas73cs9uo0` |
| Web service slug | `shipshape-fkub` |
| Postgres id | `dpg-d9r8n82jnfac73f5j5r0-a` |
| Agent cron id | `crn-d9r8o35bedkc73ff3m70` |
| Agent cron slug | `fleetgraph-agent-2wcw` |
| LangSmith project | `fleetgraph-prod` |
| Region | Oregon |

**Do not hand-maintain this table.** It is a snapshot, and a snapshot someone
edits by hand goes stale the same way the URL in `SUBMISSION.md` did. The
authoritative source is Terraform state:

```bash
cd terraform/render && terraform output
```

`scripts/destroy-redeploy.sh` prints the new values at the end of every cycle and
rewrites the URL references in tracked Markdown; the ids above are the one thing
it does not rewrite, so they are what you update here after a rebuild.

## Previous environments

Kept because the write-ups reference them, and because a reader who finds an old
URL in `docs/audit/` or `CHANGES/` should be able to tell "retired" from "broken".

| Slug | Status | Notes |
|---|---|---|
| `shipshape-fkub` | **Live** | Terraform-created, current |
| `shipshape-7buc` | Retired 2026-08-08 | Terraform-created; destroyed by the destroy-and-redeploy cycle |
| `shipshape-70uo` | Retired 2026-08-05 | Hand-made before the Terraform config existed; deleted in the lane-8 teardown |

Both retired hosts now return 404. `scripts/check-doc-links.sh` fails CI if either
appears in a document that presents it as live; the file-scoped entries in
`scripts/doc-links-allowlist.txt` are what let the historical write-ups keep
citing them.

## Where the secrets actually are

| Secret | Lives in | Reaches production via |
|---|---|---|
| `TF_VAR_render_api_key` | `.env` (gitignored) | Terraform provider auth |
| `TF_VAR_anthropic_api_key` | `.env` | `main.tf` / `cron.tf` env vars |
| `TF_VAR_ship_api_token` | `.env` | Both services; seeded into `api_tokens` on boot (`seedAgentToken.ts`) |
| `TF_VAR_langchain_api_key` | `.env` | `cron.tf`, opt-in — absent means tracing is omitted, not empty |
| `GITLAB_TOKEN` | `.env` | Terraform's `backend "http"` state |
| CI copies of the above | GitHub / GitLab secrets | `deploy.yml`, guarded by `scripts/check-tf-secrets.sh` |

`scripts/check-tf-secrets.sh` asserts that every `sensitive = true` variable in
`variables.tf` is passed by `deploy.yml`. It exists because a missing one does not
fail a plan — it plans to *remove* the variable from a healthy service, and the
symptom is every judgement returning `ai_unavailable` while `/health` stays green.
