# Annotated `terraform plan` — AWS graded root

**Ticket:** PF-626 · **Lane:** L21 · **PRD:** p.2 (annotated plan is a submission artifact), p.5
**Root:** `terraform/*.tf` — the graded root (see `docs/infra/topology.md`)

Raw plan: `docs/terraform-plan-aws-20260812.txt` (2478 lines).
Later plan against real credentials: `docs/infra/plan-baseline-w6.txt`.

`terraform/render/PLAN-ANNOTATED.md` is the Render fallback's equivalent and is retained,
not superseded — that configuration still exists.

---

# Week 6 — the create-everything plan

```
Plan: 74 to add, 0 to change, 0 to destroy.
```

**74 creates, no changes, no destroys.** That shape is itself the first thing to read: an
empty account has nothing to update and nothing to replace, so a single `-`, `~` or `-/+`
anywhere in this plan would have meant something was already there and the config did not
know about it.

Two `random_password` resources are provider-local — they produce values, not
infrastructure. So the plan creates **72 AWS resources**.

## Annotation, in dependency order

Every resource, its action, and why it exists. All actions are **create** (`+`); the
column is kept because p.2 asks for the action per resource and because its uniformity is
the point.

### Networking foundation (13)

| Resource | Action | Why |
|---|---|---|
| `aws_vpc.main` | create | `10.0.0.0/16`. The root of the dependency graph — everything below has a `vpc_id` pointing here. |
| `aws_subnet.public[0]`, `[1]` | create | Two AZs. Hold the ALB and the NAT gateway. Public = has a route to the internet gateway. |
| `aws_subnet.private[0]`, `[1]` | create | Two AZs. Hold the EB instances and Aurora. **No route to the IGW** — this is what makes the database unreachable from the internet. |
| `aws_internet_gateway.main` | create | The VPC's door to the internet. Attached to the VPC, used only by the public route table. |
| `aws_eip.nat[0]` | create | The static egress IP. **Replacing this changes the egress address**; replacing the NAT gateway alone does not, because it reuses this allocation. |
| `aws_nat_gateway.main[0]` | create | Lets private instances reach out (ECR Public, npm, the AWS APIs) without being reachable in. ~$32/mo and deliberately kept — D6 rejected the public-subnet alternative because it weakens the blast-radius answer. |
| `aws_route_table.public` | create | `0.0.0.0/0` → internet gateway. |
| `aws_route_table.private` | create | `0.0.0.0/0` → NAT gateway. |
| `aws_route_table_association.public[0]`, `[1]` | create | Bind the public subnets to the public table. |
| `aws_route_table_association.private[0]`, `[1]` | create | Bind the private subnets to the private table. Without these the private subnets get the VPC's main route table and lose egress. |

### Flow logging (4)

| Resource | Action | Why |
|---|---|---|
| `aws_cloudwatch_log_group.vpc_flow_logs` | create | Destination for VPC flow logs. |
| `aws_iam_role.vpc_flow_logs` | create | Assumed by `vpc-flow-logs.amazonaws.com` to write them. |
| `aws_iam_role_policy.vpc_flow_logs` | create | `logs:CreateLogStream`/`PutLogEvents` on the group above. |
| `aws_flow_log.main` | create | Turns it on for the VPC. Network-level audit trail. |

### Security groups (4) — the blast-radius answer

| Resource | Action | Why |
|---|---|---|
| `aws_security_group.alb` | create | 80 and 443 from `0.0.0.0/0`. **The only group open to the internet.** |
| `aws_security_group.eb_instance` | create | Port 80 from the ALB's group *only* — not from a CIDR. |
| `aws_security_group.aurora` | create | Base group for the cluster. |
| `aws_security_group_rule.aurora_ingress_from_eb` | create | 5432 from the instance group *only*. A **separate resource**, not an inline block — which matters for drift detection: Terraform tracks only rules it created here, so a hand-added rule on this group would be **invisible** to `plan`. (See `docs/infra/drift-demo.md`.) |

The chain — internet → ALB → instances → Aurora — is the answer to "what can reach the
database". Nothing but an application instance can, and instances are not addressable
from outside.

### Database (5)

| Resource | Action | Why |
|---|---|---|
| `random_password.db_password` | create | Provider-local. Never in git; lands in state and in SSM. |
| `aws_db_subnet_group.aurora` | create | Pins the cluster to the two **private** subnets. |
| `aws_rds_cluster_parameter_group.aurora` | create | PG 16 parameter group. |
| `aws_rds_cluster.aurora` | create | Aurora Serverless v2, PostgreSQL 16.8, encrypted, `PubliclyAccessible: false`. **The long pole: ~8m23s.** `skip_final_snapshot = var.environment != "prod"` — and environment is `"dev"`, so **destroying it takes the data with no snapshot**. |
| `aws_rds_cluster_instance.aurora` | create | The single writer, 0.5–4 ACU. |
| `aws_cloudwatch_log_group.aurora` | create | Postgres logs. |

### Elastic Beanstalk and IAM (10)

| Resource | Action | Why |
|---|---|---|
| `aws_elastic_beanstalk_application.api` | create | The application container. |
| `aws_iam_role.eb_instance` | create | **The task role** in p.2's ECS vocabulary — assumed by EC2, what the app runs as. Subject of the PF-633–638 least-privilege drill. |
| `aws_iam_instance_profile.eb` | create | The wrapper that lets EC2 assume the role above. Renaming *this* rolls the ASG; renaming the *role* leaves a credential-less window instead. |
| `aws_iam_role.eb_service` | create | **The execution role** equivalent — assumed by `elasticbeanstalk.amazonaws.com` under an `sts:ExternalId` condition (the confused-deputy guard). |
| `aws_iam_role_policy_attachment.eb_web_tier` | create | S3 app-version reads, log writes, health metrics. **Kept** by PF-635. |
| `aws_iam_role_policy_attachment.eb_worker_tier` | create | SQS + full DynamoDB item CRUD. **Dropped** by PF-635 — this is a web server environment. |
| `aws_iam_role_policy_attachment.eb_multicontainer_docker` | create | ECS container-instance permissions. **Dropped** by PF-635 — this is the plain Docker platform, not the ECS-backed one. |
| `aws_iam_role_policy_attachment.eb_service_policy` / `.eb_service_managed` | create | Enhanced health + managed updates, on the service role. |
| `aws_iam_role_policy.eb_ssm_access` | create | `ssm:GetParameter*` scoped to `parameter/ship/dev/*`, plus `kms:Decrypt` conditioned `ViaService = ssm`. **This path scope is the boundary PF-637's denial proves.** |
| `aws_iam_role_policy.eb_secrets_manager_access` | create | Secrets Manager read **and write**. PF-635 drops the write half. |
| `aws_iam_role_policy.eb_bedrock_access` | create | `bedrock:InvokeModel` scoped to Anthropic models. |
| `aws_elastic_beanstalk_environment.api` | create | The environment itself, with ~26 option settings. **`cname_prefix` is NOT set**, so the CNAME suffix is AWS-generated and unpinnable on recreate — the finding behind PF-632. |

### Configuration in SSM (9 + 1 generated)

| Resource | Action | Why |
|---|---|---|
| `random_password.session_secret` | create | Provider-local. |
| `aws_ssm_parameter.database_url` | create | `SecureString`. Assembled from the cluster endpoint and the generated password. |
| `aws_ssm_parameter.db_host` / `db_name` / `db_username` | create | Plain strings, for operators. |
| `aws_ssm_parameter.db_password` / `session_secret` | create | `SecureString`. |
| `aws_ssm_parameter.cors_origin` / `cdn_domain` / `app_base_url` | create | Read at boot by `api/src/config/ssm.ts`. |

All under `/ship/dev/*`, which is exactly the prefix the instance role's policy allows —
the two are derived from the same `var.environment` and cannot disagree.

*(The three OAuth app-secret parameters in `terraform/platform-apps.tf` are **not** in this
plan; PF-625/PF-630 added them afterwards.)*

### Frontend delivery: S3, CloudFront, WAF (24)

| Resource | Action | Why |
|---|---|---|
| `aws_s3_bucket.frontend` + `versioning` / `encryption` / `public_access_block` / `policy` | create | The built SPA. **Not public** — reached only through CloudFront's origin access control. |
| `aws_s3_bucket.uploads` + `versioning` / `encryption` / `public_access_block` / `cors` / `lifecycle` | create | User uploads. |
| `aws_cloudfront_origin_access_control.frontend` | create | Lets only this distribution read the bucket. |
| `aws_cloudfront_function.spa_routing` | create | Rewrites deep links to `index.html`. |
| `aws_cloudfront_cache_policy.api_no_cache` | create | **Declared but unattached today** — it exists for the API origin, which materialises only when `var.eb_environment_cname` is set. This is PF-632's option (c), pre-built and one variable away. |
| `aws_cloudfront_origin_request_policy.api` | create | Same. |
| `aws_cloudfront_distribution.frontend` | create | `d258p92d3n1ebe.cloudfront.net`. **Survives EB environment replacement**, which is why option (c) closes the URL-stability risk. |
| `aws_kinesis_stream.cloudfront_logs` + `aws_iam_role.cloudfront_realtime_logs` + `aws_iam_role_policy.cloudfront_realtime_logs` + `aws_cloudfront_realtime_log_config.main` | create | Real-time log delivery. |
| `aws_wafv2_web_acl.cloudfront[0]` | create | Managed rule groups incl. SQLi. |
| `aws_wafv2_ip_set.bad_ips[0]` | create | Empty deny list, ready to populate. |
| `aws_wafv2_regex_pattern_set.static_files[0]` | create | **Applied but referenced by nothing** — the rule that would use it is commented out in `waf.tf`. Dead infrastructure, and a good decoy in the PF-644 exercise set. |

## What the plan did not say, and cost real time later

Recorded because the point of annotating a plan is to know what it *cannot* tell you:

1. **Nothing about the application.** A clean 74-create plan says the infrastructure is
   describable. It says nothing about whether anything runs on it — the environment was
   Green and serving the EB sample app for hours afterwards.
2. **`solution_stack_name` is a pinned version whose validity AWS controls.** The version
   in this artifact was a retired `v4.9.0`; a retired stack hard-fails `CreateEnvironment`
   with no warning. Re-check before any destroy-redeploy.
3. **The conditionals that resolve to nothing.** `var.app_domain_name` and
   `var.route53_zone_id` are empty, so the ACM certificate and Route 53 records are
   `count = 0` and never appear. A plan shows what *will* happen, not the branches that
   were skipped — and here those branches are exactly the ones PF-632 needs.
