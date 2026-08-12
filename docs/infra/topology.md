# Infrastructure Topology

**Covers:** PF-616 (inventory + graded root), PF-646 (role-name mapping), PF-617 (ADR for D6).
**Verified:** 2026-08-12, account `379484935796`, region `us-east-1`.
**Verifying identity:**

```console
$ aws sts get-caller-identity
{
    "UserId": "AIDAVQWYQSZ2IDMGWZTXM",
    "Account": "379484935796",
    "Arn": "arn:aws:iam::379484935796:user/ship-terraform"
}
```

Every claim below carries the command that proved it. Where a claim in the ticket or in an L99
finding did not survive verification, the corrected version is written here and the discrepancy is
called out explicitly.

---

## 1. The graded root is `terraform/*.tf`

`terraform/*.tf` is the graded root. Two things make it so, and both are observable rather than
asserted:

**It is the only configuration with real state.** The S3 backend bucket holds exactly one state
object:

```console
$ aws ssm get-parameter --name /ship/terraform-state-bucket --query Parameter.Value --output text
ship-terraform-state-379484935796

$ aws s3api list-objects-v2 --bucket ship-terraform-state-379484935796 \
    --query 'Contents[].{Key:Key,Size:Size,Mod:LastModified}' --output json
[
    { "Key": "ship/terraform.tfstate",        "Size": 190830, "Mod": "2026-08-12T19:14:31+00:00" },
    { "Key": "ship/terraform.tfstate.tflock", "Size": 242,    "Mod": "2026-08-12T23:34:57+00:00" }
]
```

`ship/terraform.tfstate` is the key declared in `terraform/versions.tf`. The three environment
roots declare `ship/dev/`, `ship/prod/` and `ship/shadow/terraform.tfstate` — **none of those keys
exist in the bucket.** The `.tflock` object is S3-native conditional-write locking
(`use_lockfile = true`), present because an apply was in flight at the time of the listing.

**Its resources are the ones that actually exist.** The state contains 72 resource blocks / 76
instances; every managed resource in it resolves to a live AWS object. Read directly from the
backend rather than via `terraform state list`, to avoid touching the lock another operator held:

```console
$ aws s3 cp s3://ship-terraform-state-379484935796/ship/terraform.tfstate - | \
    python3 -c "import json,sys; d=json.load(sys.stdin); \
      print(d['serial'], d['terraform_version'], len(d['resources']), \
            sum(len(r['instances']) for r in d['resources']))"
8 1.15.8 72 76
```

### 1.1 Applied resources

| Layer | What exists | Proof |
|---|---|---|
| VPC | `vpc-06ed04dea6a97a28c`, `10.0.0.0/16` | `aws ec2 describe-vpcs --vpc-ids vpc-06ed04dea6a97a28c` |
| Public subnets | `subnet-08ddc8883fad35242` (10.0.0.0/24, us-east-1a), `subnet-0ba9c7774e055807a` (10.0.1.0/24, us-east-1b) — `MapPublicIpOnLaunch: true` | `aws ec2 describe-subnets --filters Name=vpc-id,Values=vpc-06ed04dea6a97a28c` |
| Private subnets | `subnet-0c278c943317e6de3` (10.0.10.0/24, us-east-1a), `subnet-025c8cbacae8db971` (10.0.11.0/24, us-east-1b) — `MapPublicIpOnLaunch: false` | same command |
| NAT gateway | `nat-09f7ed15834926679`, `State: available`, in public `subnet-08ddc8883fad35242` | `aws ec2 describe-nat-gateways --filter Name=vpc-id,Values=vpc-06ed04dea6a97a28c` |
| EB application | `ship-api` (the only EB application in the account) | `aws elasticbeanstalk describe-applications --query 'Applications[].ApplicationName'` |
| EB environment | `ship-api-prod`, `Status: Ready`, `Health: Green`, tier `WebServer`, stack `64bit Amazon Linux 2023 v4.13.6 running Docker`, CNAME `ship-api-prod.eba-nvpntpge.us-east-1.elasticbeanstalk.com` | `aws elasticbeanstalk describe-environments --environment-names ship-api-prod` |
| EB placement | instances in the **private** subnets, ALB in the **public** subnets, `AssociatePublicIpAddress: false`, `ELBScheme: public`, `LoadBalancerType: application`, `InstanceType: t3.small`, `DisableIMDSv1: true` | `aws elasticbeanstalk describe-configuration-settings --application-name ship-api --environment-name ship-api-prod` |
| Aurora cluster | `ship-aurora`, `aurora-postgresql` 16.8, Serverless v2 0.5–4.0 ACU, `StorageEncrypted: true`, endpoint `ship-aurora.cluster-canm4g4ki4wm.us-east-1.rds.amazonaws.com` | `aws rds describe-db-clusters --db-cluster-identifier ship-aurora` |
| Aurora instance | `ship-aurora-instance-1`, `db.serverless`, `available`, `PubliclyAccessible: false`, subnets = the two private subnets | `aws rds describe-db-instances --db-instance-identifier ship-aurora-instance-1` |
| Security groups | `ship-alb` (`sg-05cfe8b63251ae8bf`) 80/443 from `0.0.0.0/0`; `ship-eb-instance` (`sg-0277455ede9088403`) 80 **only from** `sg-05cfe8b63251ae8bf`; `ship-aurora` (`sg-029f73b3333ec3fba`) 5432 **only from** `sg-0277455ede9088403` | `aws ec2 describe-security-groups --filters Name=vpc-id,Values=vpc-06ed04dea6a97a28c` |
| IAM | `ship-eb-instance-role`, `ship-eb-service-role`, `ship-eb-instance-profile`, plus `ship-vpc-flow-logs` and `ship-dev-cf-realtime-logs` | `aws iam list-roles` (filtered to names starting `ship`; full command in §3) |
| SSM | `/ship/dev/{DATABASE_URL,DB_HOST,DB_NAME,DB_USERNAME,DB_PASSWORD,CORS_ORIGIN,CDN_DOMAIN,APP_BASE_URL,SESSION_SECRET}` + `/ship/terraform-state-bucket` | `aws ssm describe-parameters --query 'Parameters[].Name'` |
| S3 | `ship-frontend-dev-379484935796`, `ship-uploads-dev-379484935796`, `ship-terraform-state-379484935796` | `aws s3api list-buckets --query 'Buckets[].Name'` |
| CloudFront | `E3VSP84GNHG3D` → `d258p92d3n1ebe.cloudfront.net`, `Status: Deployed`, origin `ship-frontend-dev-379484935796.s3.us-east-1.amazonaws.com`, WAF `ship-dev-cloudfront-waf` | `aws cloudfront get-distribution --id E3VSP84GNHG3D` |
| VPC flow logs | log group `/aws/vpc/ship` | `aws logs describe-log-groups --log-group-name-prefix /aws/vpc/ship` |

One caveat on reading that table as "the config": it is the *state* at serial 8
(`Mod: 2026-08-12T19:14:31Z`). `terraform/budget.tf` (`aws_budgets_budget.monthly`) was added to
the root after that serial and does not appear in it, so the root config is at least one resource
ahead of the recorded state. An apply was in flight when this was written
(`ship/terraform.tfstate.tflock`, 23:34Z), so re-read the state before treating the table as
exhaustive.

### 1.2 Two facts about the applied root that the inventory should not paper over

**The root's `environment` variable is `dev`, not `prod`.** `terraform/variables.tf:16` defaults
`environment = "dev"`, and the applied names show it: buckets are `ship-frontend-dev-…` /
`ship-uploads-dev-…`, SSM parameters are `/ship/dev/*`, the WAF is `ship-dev-cloudfront-waf`. The
EB environment is nevertheless named `ship-api-prod` because
`terraform/elastic-beanstalk.tf:98` hardcodes the suffix `-api-prod` rather than interpolating
`var.environment`. So the applied stack is internally inconsistent about its own environment label.
This is cosmetic for grading — one account, one stack — but it is a real inconsistency and it is
what makes some of the collision analysis in §2 come out the way it does.

**The EB environment is Green but is serving the platform's sample application, not Ship.**

```console
$ curl -s http://ship-api-prod.eba-nvpntpge.us-east-1.elasticbeanstalk.com/health
… <title>AWS Elastic Beanstalk - Docker Sample Application</title> …   # HTTP 200
```

`Health: Green` therefore attests to the *infrastructure*, not to a deployed Ship build. Likewise
CloudFront returns 403 because the frontend bucket is empty
(`aws s3api list-objects-v2 --bucket ship-frontend-dev-379484935796` → `null`). The infrastructure
is applied and correct; the application artifact has not been pushed to it yet.

---

## 2. Two configurations of the same resources, not two layers (F31)

They are alternatives. `terraform/environments/{dev,prod,shadow}` do not extend, wrap or consume
the root; they re-declare the same stack through `terraform/modules/*`. Each has its own backend
key, so neither can see the other's state, and nothing links them — no `terraform_remote_state`,
no data sources pointing at root-created resources:

```console
$ grep -rn "terraform_remote_state" terraform/
(no matches)
```

Applying both therefore does not compose. It either errors or silently duplicates.

### 2.1 Where it errors

`terraform/environments/prod` builds its own VPC via `module "vpc"`, and that module names two
resources **byte-identically to the root**, with no environment infix:

| Resource | `terraform/vpc.tf` | `terraform/modules/vpc/main.tf` | Uniqueness scope |
|---|---|---|---|
| `aws_iam_role.vpc_flow_logs` | `"${var.project_name}-vpc-flow-logs"` (line 130) | `"${var.project_name}-vpc-flow-logs"` (line 130) | **account-global** |
| `aws_cloudwatch_log_group.vpc_flow_logs` | `"/aws/vpc/${var.project_name}"` (line 121) | `"/aws/vpc/${var.project_name}"` (line 121) | region-global |

Both already exist, created by the root:

```console
$ aws iam get-role --role-name ship-vpc-flow-logs --query 'Role.Arn' --output text
arn:aws:iam::379484935796:role/ship-vpc-flow-logs

$ aws logs describe-log-groups --log-group-name-prefix /aws/vpc/ship --query 'logGroups[].logGroupName'
[ "/aws/vpc/ship" ]
```

IAM role names are account-global, so a second `CreateRole` for `ship-vpc-flow-logs` returns
`EntityAlreadyExists`; the log group returns `ResourceAlreadyExistsException`. The EB environment
name also coincides — the root hardcodes `ship-api-prod` and the module produces
`"${var.project_name}-api-${var.environment}"` = `ship-api-prod` under
`environments/prod/variables.tf:16`.

**Correction to F31 as filed.** F31 states that the module copies name resources identically as
`${var.project_name}-eb-instance-role` "and friends", and that the collision lands on the EB role
names. That specific claim is false. The Elastic Beanstalk module inserts an environment infix that
the root does not have:

| | root `terraform/elastic-beanstalk.tf` | `terraform/modules/elastic-beanstalk/main.tf` | Same? |
|---|---|---|---|
| instance role | `${var.project_name}-eb-instance-role` (L13) | `${var.project_name}-${var.environment}-eb-instance-role` (L13) | no |
| instance profile | `${var.project_name}-eb-instance-profile` (L51) | `${var.project_name}-${var.environment}-eb-instance-profile` (L51) | no |
| service role | `${var.project_name}-eb-service-role` (L61) | `${var.project_name}-${var.environment}-eb-service-role` (L61) | no |

The same infix appears in `modules/aurora` (`ship-prod-aurora` vs `ship-aurora`),
`modules/security-groups` (`ship-prod-alb` vs `ship-alb`) and `modules/ssm`
(`ship-prod-eb-ssm-access` vs `ship-eb-ssm-access`). F31's **conclusion** — two configs of the same
resources, alternatives rather than layers, pick one root before the first apply — is correct and
is upheld here. Its **mechanism** was mis-attributed: the `EntityAlreadyExists` comes from
`modules/vpc`'s flow-log role, not from the EB roles.

### 2.2 Where it would silently duplicate

This matters more than the error, because it fails quietly. Every module resource that *does*
carry the environment infix would be created a second time rather than colliding: a second Aurora
Serverless v2 cluster (`ship-prod-aurora`), a second NAT gateway, a second VPC, a second pair of
EB roles (`ship-prod-eb-instance-role`, `ship-prod-eb-service-role`), a second CloudFront
distribution. The account would end up with two parallel copies of the stack and one graded
answer to "what is your blast radius." Applying both is wrong even in the cases where AWS lets it
succeed.

---

## 3. `terraform/environments/{dev,prod,shadow}` — NOT APPLIED

> **NOT APPLIED.** These three roots have never been applied against account `379484935796`. They
> are retained as an unexercised multi-environment layout, not as live infrastructure. Nothing in
> this repo's deployment path reads them.

Evidence, in order of strength:

1. **No state.** The backend bucket contains only `ship/terraform.tfstate` (§1). The keys these
   roots declare — `ship/dev/terraform.tfstate`, `ship/prod/terraform.tfstate`,
   `ship/shadow/terraform.tfstate` (`environments/*/versions.tf`) — are absent.
2. **No resources bearing their naming scheme.** Their modules produce `ship-<env>-*` names. The
   account contains no such EB, RDS or S3 objects:
   ```console
   $ aws iam list-roles --query 'Roles[?starts_with(RoleName, `ship`)].RoleName' --output json
   [ "ship-dev-cf-realtime-logs", "ship-eb-instance-role", "ship-eb-service-role", "ship-vpc-flow-logs" ]
   ```
   (`ship-dev-cf-realtime-logs` is a root resource — `terraform/cloudfront-logging.tf:25` is the one
   root file that *does* interpolate `var.environment`, which is `dev`. It is not evidence of an
   environments/* apply.)
   ```console
   $ aws elasticbeanstalk describe-environments --query 'Environments[].[EnvironmentName,Status]'
   [ [ "ship-api-prod", "Ready" ] ]
   $ aws rds describe-db-clusters --query 'DBClusters[].DBClusterIdentifier'
   [ "ship-aurora" ]
   ```
3. **`dev` and `shadow` cannot even plan.** Both read the shared-VPC handoff from SSM —
   `environments/dev/main.tf:4-19` and `environments/shadow/main.tf:25-38` both reference
   `/infra/dev/{vpc_id,private_subnet_ids,public_subnet_ids,vpc_cidr}`. Those parameters do not
   exist:
   ```console
   $ aws ssm describe-parameters --parameter-filters "Key=Name,Option=BeginsWith,Values=/infra" \
       --query 'Parameters[].Name' --output json
   []
   ```
   A `terraform plan` in either root fails at the data source before producing a diff. (Note that
   `environments/shadow` reads the **dev** parameter paths — likely a copy-paste, but moot while
   neither path exists.)

`environments/prod` is the only one that could plan, since it builds its own VPC — and per §2.1 it
would then collide on `ship-vpc-flow-logs`.

---

## 4. `terraform/render/` — retained fallback

**Retained, not destroyed.** The configuration is kept in-repo as the fallback path recorded in
D6 (§6). Its current condition, stated honestly:

| | Finding | Proof |
|---|---|---|
| Config | Present and complete: `main.tf`, `cron.tf`, pinned `render-oss/render` provider + `.terraform.lock.hcl`, annotated plan in `PLAN-ANNOTATED.md` | `ls terraform/render/` |
| State file | **`terraform.tfstate` is 0 bytes.** The 20,212-byte `terraform.tfstate.backup` (serial 13, TF 1.15.8) is the only file carrying resources | `wc -c terraform/render/terraform.tfstate*` |
| Resources in backup | 3: `render_web_service.shipshape` (`srv-d9p78tfavr4c73atg8pg`, `https://shipshape-7buc.onrender.com`), `render_postgres.ship` (`dpg-d9p789cs728c7393svq0-a`, free plan, PG 16), `render_cron_job.fleetgraph` (`crn-d9p7967qj5pc73dk7j60`) | parsed from `terraform.tfstate.backup` |
| Service liveness | **Not live.** Render's edge answers `404` with `x-render-routing: no-server` — the routing layer has no backend for that hostname | see below |

```console
$ curl -sI https://shipshape-7buc.onrender.com/health
HTTP/2 404
x-render-routing: no-server
server: cloudflare
```

`x-render-routing: no-server` is Render's response when the hostname resolves through its edge but
no service is attached — i.e. the service is gone or suspended, not merely erroring. Combined with
the zero-byte state file, the honest reading is that the Render deployment was torn down (or its
state emptied) and only the configuration plus the backup state remain.

**This contradicts PF-616's premise.** The ticket describes `terraform/render/` as having a "real
`terraform.tfstate`, live service." Neither half holds as of 2026-08-12: the state file is empty
and the service returns `no-server`. What is true, and what the fallback claim should rest on, is
that the **configuration** is retained, pinned, and re-appliable — falling back to Render means
running `terraform apply` there, not flipping traffic to something already running.

---

## 5. Role-name mapping (PF-646)

Reproduced verbatim as the top section of `docs/infra/iam-least-privilege.md`, which is where the
before/after policy work lands. See that file for the canonical copy.

**Elastic Beanstalk does not use PRD p.2's words.** p.2 asks the topology to describe an "IAM task
role and execution role." Those are **ECS** terms. This deployment is Elastic Beanstalk on EC2, and
EB has no resource called `task_role` or `execution_role` — no such resource exists in
`terraform/*.tf` and none is claimed here. What EB does have is the *same two-role shape*: one role
the workload assumes, one role the platform assumes on your behalf. That shape is what p.2 is
asking about, and the mapping below is the honest answer to it.

| PRD p.2 / ECS term | This deployment (Elastic Beanstalk) | Who assumes it | Trust policy (verbatim from `aws iam get-role`) |
|---|---|---|---|
| **Task role** — the role *the application* assumes; scopes what the running workload can call | `aws_iam_role.eb_instance` → `ship-eb-instance-role`, reached by the EC2 instances through `aws_iam_instance_profile.eb` → `ship-eb-instance-profile` | The EC2 instances running the app container, via the instance profile and IMDS | Principal `Service: ec2.amazonaws.com`, `Action: sts:AssumeRole`, no condition |
| **Execution role** — the role *the platform* assumes on your behalf; lets AWS manage the environment for you | `aws_iam_role.eb_service` → `ship-eb-service-role` | The Elastic Beanstalk service itself | Principal `Service: elasticbeanstalk.amazonaws.com`, `Action: sts:AssumeRole`, `Condition: StringEquals { "sts:ExternalId": "elasticbeanstalk" }` |

Trust policies verified, not paraphrased:

```console
$ aws iam get-role --role-name ship-eb-instance-role --query 'Role.AssumeRolePolicyDocument'
{
    "Version": "2012-10-17",
    "Statement": [
        { "Effect": "Allow", "Principal": { "Service": "ec2.amazonaws.com" }, "Action": "sts:AssumeRole" }
    ]
}

$ aws iam get-role --role-name ship-eb-service-role --query 'Role.AssumeRolePolicyDocument'
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": { "Service": "elasticbeanstalk.amazonaws.com" },
            "Action": "sts:AssumeRole",
            "Condition": { "StringEquals": { "sts:ExternalId": "elasticbeanstalk" } }
        }
    ]
}
```

The wiring is verified end to end, not inferred from the Terraform:

```console
$ aws iam get-instance-profile --instance-profile-name ship-eb-instance-profile \
    --query 'InstanceProfile.Roles[].RoleName'
[ "ship-eb-instance-role" ]

$ aws elasticbeanstalk describe-configuration-settings --application-name ship-api \
    --environment-name ship-api-prod \
    --query "ConfigurationSettings[0].OptionSettings[?OptionName=='IamInstanceProfile'||OptionName=='ServiceRole']"
IamInstanceProfile  aws:autoscaling:launchconfiguration        ship-eb-instance-profile
ServiceRole         aws:elasticbeanstalk:environment           arn:aws:iam::379484935796:role/ship-eb-service-role
```

**Why the distinction is load-bearing.** The `sts:ExternalId` condition on the service role is the
confused-deputy guard: it means only Elastic Beanstalk, presenting the agreed external id, can
assume that role. The instance role has no such condition because it is assumed by EC2 through the
instance profile, where the binding is the profile attachment rather than a condition key. This is
also why the least-privilege drill targets `ship-eb-instance-role` and not the service role — the
instance role is the one the application's own code borrows, so it is the one whose over-privilege
is the application's blast radius.

**Where the analogy is imperfect, stated plainly.** ECS's execution role pulls the image and writes
logs *before* the task runs; EB's service role instead performs environment management —
health monitoring, managed platform updates — and the image pull happens under the *instance* role
(`AWSElasticBeanstalkMulticontainerDocker` is attached there). The two-role split is the same and
the "who assumes it" answer is the same; the exact division of labour differs. Claiming otherwise
would not survive a defense question.

---

## 6. ADR — Graded deployment target moves to AWS (D6)

**Date:** 2026-08-12
**Status:** Accepted
**Decision record:** D6 (`tickets/plugforge/lane-99-unassigned.md`)
**Supersedes:** the Render deployment described in `docs/architecture.md` § Deployment Topology
(rewritten under PF-647)

### Context

The graded deployment ran on Render: one Docker web service, managed Postgres, and the FleetGraph
cron, all in `terraform/render/`. The PRD requires the Terraform configuration to describe a
specific topology, and two separate pages bear on where that topology lives.

### Decision

**The graded deployment target is AWS.** The applied root is `terraform/*.tf` (§1). Render is
retained as a fallback (§4).

### Why

p.2 puts *"IAM task role and execution role"* inside a **hard-gate** item — the Terraform config
must describe that topology for the gate to pass. p.5 adds VPC/subnets, security groups, and an
`AdministratorAccess`→least-privilege lockdown drill that requires a real IAM surface to lock down
and a real `AccessDenied` to demonstrate. None of these exist on Render: it has no IAM, no VPC or
subnets you author, and no credential-scoping surface against which a denial can be produced. The
gate is not satisfiable there, and no amount of write-up makes it satisfiable.

p.10 permits Render by name. But p.10 is a suggestion table — "use whatever stack helps you ship" —
and p.2 is a gate. **A gate outranks a suggestion.** Choosing the page that permits the easier path
over the page that conditions the pass is the wrong reading of the document.

The cost of the move is low because the AWS configuration already existed as written code:
`terraform/elastic-beanstalk.tf`, `terraform/database.tf`, 15 `aws_iam_*` resources, and an S3
backend. This was `init` / `plan` / `apply` against code in the repo, not a greenfield build.
Estimated cost for the week is ~$15–25 against existing credits.

### Cost: what was kept, and the downgrade that was rejected

**Aurora Serverless v2 and the NAT gateway were KEPT.** Neither is free-tier eligible. A downgrade
to a `db.t4g.micro` instance with the application moved into public subnets was considered and
**rejected**. It would have saved roughly $20 for the week. It would also have destroyed the
answer to the blast-radius question: with the database in a public subnet and no NAT, the topology
no longer demonstrates a private data tier reachable only from the application security group —
which is exactly what `ship-aurora`'s single ingress rule (5432 from `sg-0277455ede9088403` and
nothing else, §1.1) currently demonstrates. Blast radius is an **auto-fail topic** at the
Architecture Defense. Architecture is not chosen to dodge $20, and a $20 saving that costs an
auto-fail topic is not a saving. **Render is retained as a fallback rather than deleted** for the
same posture reason: keeping a second, pinned, re-appliable path costs nothing and removes the
single-point-of-failure objection.

### Consequences

- `docs/architecture.md` § Deployment Topology no longer describes the graded deployment and is
  rewritten to the applied AWS topology (PF-647).
- The "PlugForge adds zero new infrastructure resources" claim that sat beside the Render
  description does not survive the move and is removed with it: under D6 the delta is an entire
  environment created from scratch, not env-vars added to a service that already exists.
- The least-privilege drill (p.5) becomes executable: `ship-eb-instance-role` is the target, and
  the `AccessDenied` can be produced against a real credential rather than caveated.
- The destroy/redeploy blast radius grows from three Render resources to the 76 instances in
  `ship/terraform.tfstate` — a larger number, but one that is re-creatable from config and
  answerable in detail, which is what the defense actually asks for.
- One root must be chosen before any apply (§2). `terraform/*.tf` is that root; the environment
  roots stay unapplied.
