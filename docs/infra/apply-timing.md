# Wall-clock timing: `terraform apply` and Elastic Beanstalk deploys

**Ticket:** PF-627 · **Lane:** L21 · **PRD:** p.2, p.5
**Purpose:** size PF-642's destroy-redeploy honestly, against measurement rather than optimism.

---

## 1. What was and was not measured here, stated first

PF-627 asks for the wall clock of the **first apply**, per resource class, with Aurora
measured separately. That apply happened **before this lane started** — the account was
already stood up and all 74 resources existed when the lane opened. So:

| Number | Source | Trust |
|---|---|---|
| First full apply: **9m19s + 5m00s**, Aurora **8m23s** | Inherited from the lane brief; not observed by me | **Verified by the coordinator on 2026-08-12.** Recorded because it is the only datum for a create-everything apply, and flagged because I did not take it. |
| Everything in §2 and §3 | Measured in this session from the AWS API's own timestamps | Observed |

The inherited number is the one PF-642 must be scheduled against, and it is precisely the
one nobody in this session re-measured. **That is the honest gap in this artifact.** A
destroy-redeploy is the only way to produce a trustworthy replacement for it, and that
drill is blocked (see §4).

## 2. Incremental `terraform apply` — measured

Three applies were run against the graded root in this session. None created a VPC, NAT
gateway or Aurora cluster, so none of them exercises the long pole.

| Apply | Change set | Wall clock |
|---|---|---|
| Budget + 4 pending in-place updates | `aws_budgets_budget` created; EB app, EB environment, CloudFront distribution, WAF web ACL updated in place | ~2 min, dominated by the CloudFront distribution update |
| EB option settings (`ENVIRONMENT`, `Timeout`) | 1 in-place EB environment update | ~2 min |
| 3 × `random_password` + 3 × `aws_ssm_parameter` | 6 created | < 30s |

**Refresh alone is ~25–30s** for the 76 resources in state, on every plan and apply. That
is the floor under any operation against this root and it is worth knowing before
assuming a plan is hung.

## 3. Elastic Beanstalk deploys — measured, including the failures

The timings that actually matter for this environment, from `aws elasticbeanstalk
describe-events`. Four deploys were attempted; three failed. The failures are recorded
because their durations are what tell you where the time goes.

| # | Version | Started | Instance launched | Outcome | Elapsed |
|---|---|---|---|---|---|
| 1 | `ship-api-aaf6669` | 23:57:37 | 23:58:37 | **Wrong build mode.** EB ran `docker-compose.yml` instead of the Dockerfile; started a Postgres container and no app | "completed" in **48s** |
| 2 | `ship-api-3ffa041` | 00:14:13 | 00:17:24 | **Build failed** — TS2538 in `config/ssm.ts` | failed **2m45s** after launch |
| 3 | `ship-api-ba83dae` | 00:24:53 | 00:26:22 | **Built and started**; server then died on `ERR_MODULE_NOT_FOUND: supertest`. Health went Severe on 5xx | build **3m31s**; 5xx from 00:31 |
| 4 | `ship-api-7706771` | 00:43:25 | — | see `docs/infra/deployment-verification.md` | — |

### Three things this measurement changed

1. **The Docker build on a `t3.small` takes ~3m30s, not 10–20 minutes.** Deploy #3 built
   the entire monorepo — pnpm install across six workspace projects, `tsc` for shared,
   agent and api, and a Vite build of the frontend — in three and a half minutes on a
   2 vCPU / 2 GiB instance. I had assumed an order of magnitude more.

2. **So the `Timeout` raise from 600s to 1800s was not necessary.** I raised it in
   `elastic-beanstalk.tf` reasoning that a monorepo build would not fit in ten minutes. The
   measurement says it fits in under four. The setting is being kept anyway, and the reason
   is different from the one I gave when I made the change: the risk it covers is a **cold
   instance with no Docker layer cache pulling base images over the NAT gateway**, plus
   headroom for the deploy steps either side of the build. 600s would probably have worked;
   1800s costs nothing when the deploy succeeds and only lengthens the failure case. That
   is a weak justification and it should be recorded as one rather than dressed up.

3. **A 48-second "successful" deploy is a red flag, not good news.** Deploy #1 is the
   clearest lesson in this table: EB reported success, health stayed Green, and `curl
   /health` returned HTTP 200. Nothing had been built. If a deploy of this application
   finishes in under two minutes, it did not build the image.

### Rollback and abort costs

Both failed rollouts had to be aborted (`aws elasticbeanstalk abort-environment-update`)
because `RollingWithAdditionalBatch` keeps the environment in `Updating` while it waits
for a health check that will never pass. **Abort → `Ready` took about 45 seconds**;
without it the environment sits until the command timeout expires — which is the real
cost of the 1800s setting, and the reason to know `abort-environment-update` exists
before you need it.

## 4. What this means for PF-642 (destroy-redeploy)

The drill is **not run** — the destroy guard blocks it deliberately and this lane does not
work around it. When it is scheduled, the numbers above say to budget:

| Phase | Estimate | Basis |
|---|---|---|
| `terraform destroy` | 10–15 min | Aurora deletion dominates; NAT gateway and EIP release add several minutes |
| `terraform apply` | 10–20 min | Inherited 9m19s + 5m00s, Aurora 8m23s — **unverified** |
| Application deploy on top | ~5 min | Measured: 3m31s build plus launch and health |
| Verification | ~5 min | `terraform plan` reading `No changes.`, outputs diff, `scripts/verify-deployment.sh` |

**Budget one uninterrupted hour**, against a throwaway environment with its own state key
and `project_name` prefix (PF-640), never the grader-facing one.

One caveat that is easy to miss and expensive to discover mid-drill: the EB
`solution_stack_name` is the one pinned version in this configuration whose validity is
not ours to control. AWS retires stacks unilaterally, and a retired stack hard-fails
`CreateEnvironment` rather than warning. **Re-check it immediately before any
destroy-redeploy** — this config already carried a retired `v4.9.0` once.
