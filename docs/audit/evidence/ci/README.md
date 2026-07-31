# CI enforcement evidence

Implementation Rule 4 requires a pipeline that runs build, lint, type-check, test, coverage,
`pnpm audit`, a security scan and a source-code inventory — and p.10 requires merge requests
to be gated on it. Both were previously asserted in prose with nothing in the repo a reader
could check. These three files are that check, exported from the GitLab API on 2026-07-30.

| File | What it settles |
|---|---|
| `gitlab-project-settings.json` | `only_allow_merge_if_pipeline_succeeds: true` on project 1609, default branch `main`, merge method `merge`. This is the gate itself, read from the server rather than claimed. |
| `gitlab-merged-mrs.json` | The five merge requests into `main`, each with its source branch, merge time, and merge-commit SHA. Every change reached `main` through one of these. |
| `gitlab-pipelines.json` | The last 30 pipelines with ref, SHA, status and URL. |

## Read the pipeline list honestly

`gitlab-pipelines.json` is not a clean sheet, and it should not be presented as one.

Every pipeline whose ref is `main` shows **failed**, and every pipeline on a lane or
integration branch shows **success**. That asymmetry has a single cause: the `docker-image`
job runs only on `main`, and it built with `-t "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA"` while
`CI_REGISTRY_IMAGE` was empty — this GitLab instance runs no container registry
(`container_registry_image_prefix` is `null` and the project's registry repository list is
empty, both visible in the settings export). Docker rejected the resulting tag:

    ERROR: invalid tag ":c43276832cabea468f88aaf511ccf816ed676965": invalid reference format

The eight jobs Rule 4 actually names — build, lint, type-check, test, coverage,
dependency-audit, security-scan, license-inventory — passed on every one of those runs. The
red status came entirely from the ninth, packaging, job.

That is a real defect and it is fixed rather than explained away: the packaging job no longer
assumes a registry that does not exist, and publication moved to a registry that does. See
the artifact lifecycle section in the developer docs.

`refs/merge-requests/1/head` also appears as failed. That was a merge-request pipeline with
no jobs, which GitLab marks failed; the `workflow:` rules in `.gitlab-ci.yml` now decline to
create those, so the branch pipeline is the single gate.

## Reproducing this

```bash
curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://labs.gauntletai.com/api/v4/projects/1609 | jq .
curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  https://labs.gauntletai.com/api/v4/projects/1609/pipelines?per_page=30 | jq .
```

The token needs `api` scope; `read_api` is enough for these three reads. It is never
committed — it lives in `.env`, which is gitignored.
