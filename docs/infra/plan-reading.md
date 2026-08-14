# Reading a Terraform plan — primer and blast-radius crib

Scope: the applied Terraform root at `terraform/*.tf` (NOT `terraform/environments/*`).
Account 379484935796, region `us-east-1`, 74 managed resources.
Ground truth used for this document: `terraform/*.tf`, `docs/terraform-plan-aws-20260812.txt`
(the plan artifact from the first apply of this config), and `terraform state list`.

This is study material for a live defense question. Read Part A once, then drill
Part B until you can answer it without opening a file.

---

## Part A — The primer

### A1. The symbol legend

Every plan reprints its own legend at the top. Memorize it anyway, because under
pressure the legend scrolls off the screen:

```
Terraform used the selected providers to generate the following execution
plan. Resource actions are indicated with the following symbols:
  + create
  ~ update in-place
  - destroy
-/+ destroy and then create replacement
+/- create replacement and then destroy
 <= read (data resources)
```

| Symbol | Action | What it costs you |
|---|---|---|
| `+` | create | New object. Nothing existing is touched. |
| `-` | destroy | The object goes away. Anything holding its ID breaks. |
| `~` | update in-place | Same object, same ID, mutated. Usually cheap — but not always (see A6). |
| `-/+` | **replace**: destroy first, then create | Old object dies before the new one exists. Downtime window, new ID, new IP/hostname/endpoint. Data on the old object is gone. |
| `+/-` | **replace**: create first, then destroy | Same replacement, safer ordering. Only appears when the resource sets `lifecycle { create_before_destroy = true }`. In this root only `aws_acm_certificate.app` sets it, and that resource has `count = 0` today. **So in practice, every replacement in this config is `-/+`.** |
| `<=` | read (data source) | No mutation. But a data source that reads differently can cascade — see A7. |

Two symbols also appear inside a resource body, one indent level down: `+`/`-` on a
single attribute or on a whole nested block (`+ setting { ... }`, `- rule { ... }`).
The symbol on the `resource` line is the resource action; the symbols inside are the
attribute-level detail. Do not confuse them. A `~` resource can contain `+` and `-`
attribute lines and still be an in-place update.

### A2. Spotting `# forces replacement`

Terraform annotates the *specific attribute* that caused a replacement:

```
  # aws_rds_cluster.aurora must be replaced
-/+ resource "aws_rds_cluster" "aurora" {
      ~ database_name  = "ship_main" -> "ship" # forces replacement
```

Three independent tells, all of which must line up:

1. The comment line above the block reads **`must be replaced`** (not `will be updated in-place`, not `will be created`, not `will be destroyed`).
2. The resource action symbol is **`-/+`** (or `+/-`).
3. At least one attribute line carries the trailing comment **`# forces replacement`**.

Search discipline during a defense: `grep -n "forces replacement"` and
`grep -n "must be replaced"` are the first two things you run on any plan. If either
returns a hit, stop reading top-to-bottom and go there first.

A replacement can also be forced with *no* `# forces replacement` marker on any
attribute — when it is forced by `terraform taint`/`-replace=...` or by a
`replace_triggered_by` lifecycle rule. In that case the comment line reads
`is tainted, so must be replaced` or `will be replaced, as requested`. Read the
comment line, not just the symbols.

### A3. Reading the summary line

```
Plan: 74 to add, 0 to change, 0 to destroy.
```

The counting rule that catches people out:

> **A replacement is counted as one add AND one destroy. It is never counted as a change.**

So `Plan: 2 to add, 2 to change, 2 to destroy.` on a config where you added nothing
is not "some adds and some deletes" — it is **two replacements** plus two in-place
updates. Any plan where `to add` and `to destroy` are both non-zero, on a config where
you did not add or remove a `resource` block, is a replacement plan. Treat that as the
alarm.

`0 to add, N to change, 0 to destroy` is the shape of a safe plan. It is also the
shape of the most dangerous plan in Exercise 1 — see A6.

Other summary forms:
- `No changes. Your infrastructure matches the configuration.` — the desired end state of a drift reconcile.
- `Note: Objects have changed outside of Terraform` — drift. Terraform refreshed and found reality differs from state. Appears *above* the action list.
- `Changes to Outputs:` — a separate block after the summary. Output diffs use the same `+ - ~` symbols and `->` for old-to-new values. An output changing is not itself an event; it tells you *which published value moved*, which is exactly what a grader link cares about.

### A4. `(known after apply)` vs a literal

```
      + cname                  = (known after apply)
      + name                   = "ship-api-prod"
```

- A **literal** means Terraform can compute the value from config alone. It is fully determined before apply. `name = "ship-api-prod"` will be that string, guaranteed.
- **`(known after apply)`** means the value comes from the provider at apply time, or from another resource that does not exist yet. Terraform is telling you: *I cannot show you this, and I could not have validated it.*

Two consequences that matter for this config:

1. `(known after apply)` on a **create** is normal and uninteresting — of course the ARN of a resource that does not exist yet is unknown.
2. `(known after apply)` in an **update or replacement** is the dangerous one. It means the new value is not the old value and Terraform cannot tell you what it will be. `~ cname = "ship-api-prod.eba-nvpntpge.us-east-1.elasticbeanstalk.com" -> (known after apply)` means *the hostname every published link points at is about to become something nobody in the room can predict.*

Also seen in this config's plans:
- `(sensitive value)` — the value exists and is known, but is suppressed because the attribute or variable is marked sensitive (`master_password`, every `aws_ssm_parameter.value`, `random_password.result`). Sensitive does **not** mean unchanged; a `~` on a sensitive attribute is a real change you cannot see. Use `terraform show -json` if you must inspect it.
- `(write-only attribute)` — e.g. `master_password_wo`, `value_wo`. Provider accepts it on write and never reads it back, so it never diffs.
- `# (3 unchanged attributes hidden)` / `# (1 unchanged element hidden)` — Terraform elided attributes that are not changing. This is noise suppression, not concealment. `terraform plan -no-color | terraform show -` or `TF_CLI_ARGS_plan=-concise=false` are not needed; the hidden ones are by definition unchanged.

### A5. Telling an in-place update from a replacement — the 10-second procedure

1. Read the comment line above the block. `will be updated in-place` vs `must be replaced` vs `will be destroyed` vs `will be created`.
2. Read the symbol on the `resource` line. `~` vs `-/+`.
3. Scan the body for `# forces replacement`.
4. Check the summary line arithmetic against the number of `-/+` blocks you found.

All four must agree. If they do not, you misread one of them — go back. Terraform does
not produce inconsistent plans.

### A6. In-place does not mean safe

The single most expensive misread available in this config is treating `~` as benign.
Two real examples from `terraform/`:

- `~ aws_iam_role_policy.eb_ssm_access` — an in-place update to a JSON policy document. Drop the `kms:Decrypt` statement and every `SecureString` parameter (`DATABASE_URL`, `DB_PASSWORD`, `SESSION_SECRET`) becomes unreadable. The running instance keeps working because it already read them at boot. The **next** instance launch fails. Summary line: `0 to add, 1 to change, 0 to destroy.`
- `~ aws_elastic_beanstalk_environment.api` with one changed `setting` block. `solution_stack_name`, `InstanceType` and `IamInstanceProfile` are all in-place at the Terraform level but trigger an EB environment update that rolls every instance. `~` here means "a rolling deployment is about to happen", not "nothing happens".

The inverse trap also exists: `-/+ aws_rds_cluster_instance.aurora` is a replacement,
and it costs ~10–15 minutes of database downtime — but **no data loss**, because the
data lives in the cluster volume, not the instance. Replacement severity is a property
of the resource, not of the symbol.

### A7. Data sources and `<=`

This root has two data sources:

- `data.aws_caller_identity.current` — the account ID. Stable.
- `data.aws_availability_zones.available` — feeds `aws_subnet.public/private[count.index].availability_zone` by list position.

A `<= read` on `aws_availability_zones` is not a change. But if AWS ever returns that
list in a different order or with a different membership, positions 0 and 1 resolve to
different AZs, and **four subnets force replacement** with everything downstream of
them. Treat any plan that shows subnet AZs changing without a config edit as this
scenario until proven otherwise.

### A8. What a plan will not tell you

- **The provider version.** A provider bump does not appear in the action list. It appears in `terraform init` output and in `.terraform.lock.hcl`. A `No changes.` plan under a freshly bumped major provider is not evidence of safety. This is exactly why `terraform/versions.tf` pins `aws = "5.100.0"` and `random = "3.7.2"` exactly rather than with `~>`.
- **Whether a destroy will actually succeed.** Terraform plans the intent; AWS enforces the dependencies. Destroying a security group still in use returns `DependencyViolation`; destroying a non-empty versioned S3 bucket with no `force_destroy` fails; deleting a WAF web ACL still associated with a distribution returns `WAFAssociatedItemException`; deleting a CloudFront cache policy still attached returns a policy-in-use error. These are **mid-apply failures**, which leave the config half-applied. A clean plan does not promise a clean apply.
- **Ordering across resources.** The plan is printed alphabetically by address, not in apply order.
- **`lifecycle { ignore_changes }` drift.** `aws_elastic_beanstalk_environment.api` ignores `version_label` and `aws_rds_cluster.aurora` ignores `final_snapshot_identifier`. Those two attributes will never appear in a diff no matter how far reality drifts.

---

## Part B — Blast-radius crib

Every managed resource in the applied root, what holds a reference to it, and what
breaks on replacement. "Replacement" here means `-/+`: destroy then create.

### The four answers you must be able to give cold

1. **`aws_rds_cluster.aurora` replacement = total, unrecoverable data loss.**
   `skip_final_snapshot = var.environment != "prod"`, and `var.environment` defaults to
   `"dev"` and is not overridden (no `terraform.tfvars` is committed; only
   `terraform.tfvars.example`). The applied plan artifact confirms the resolved value:
   `+ skip_final_snapshot = true`. So the destroy half takes **no final snapshot**.
   `delete_automated_backups = true` and `backup_retention_period = 1`, so the
   point-in-time backups go with it. There is nothing to restore from.

2. **`aws_elastic_beanstalk_environment.api` replacement changes the CNAME and invalidates every published link.**
   `cname_prefix` is **not set in the config** — the plan shows
   `+ cname_prefix = (known after apply)`, and the live CNAME is
   `ship-api-prod.eba-nvpntpge.us-east-1.elasticbeanstalk.com`, where `eba-nvpntpge` is
   AWS-generated. A recreate draws a new one. This has already happened once: `CLAUDE.md`
   still documents the health check at `ship-api-prod.eba-xsaqsg9h...`, a host that
   belongs to a previous environment. Every grader-facing URL — the OpenAPI spec URL,
   the README credentials block, the submission document, the dev-portal link — is a
   direct EB hostname today, because `var.eb_environment_cname` is still `""` and the
   live CloudFront distribution carries only the S3 origin. Nothing is fronting the API.

3. **NAT/EIP replacement and the egress IP — state this precisely.**
   The live egress IP is `35.153.128.210`, held by `aws_eip.nat[0]`.
   - Replacing **`aws_eip.nat[0]`** releases that address back to AWS and allocates a new one. The egress IP **changes**. Any partner allow-list, firewall rule, or IP-pinned integration breaks. It also forces `aws_nat_gateway.main[0]` to replace, because `allocation_id` is force-new there.
   - Replacing **`aws_nat_gateway.main[0]` alone** (e.g. its `subnet_id` changed) reuses the same `aws_eip`, so the **public IP is preserved**. What you get is an egress outage window while the private route table's default route is rebuilt — private-subnet instances cannot reach ECR, SSM, Bedrock, or Secrets Manager until it comes back.
   - Say which one you mean. "NAT replacement changes the IP" is only true when the EIP goes with it.

4. **Renaming an IAM role forces replacement and strips credentials from the running fleet.**
   `name` is force-new on `aws_iam_role`. Renaming `aws_iam_role.eb_instance`:
   - replaces the role, and with it all five of its attached/inline policies (`eb_ssm_access`, `eb_bedrock_access`, `eb_secrets_manager_access`, and the three managed-policy attachments);
   - updates `aws_iam_instance_profile.eb` in place — the provider removes the old role from the profile and adds the new one, so there is a window where the profile carries **no role at all**;
   - does **not** replace the EB environment, because the environment references the profile by *name* (`IamInstanceProfile = ship-eb-instance-profile`) and that name did not change.
   The running instances keep the same instance profile ARN and silently lose their
   permissions for the duration of the swap plus IAM's eventual-consistency lag. SSM
   parameter reads, Bedrock calls, Secrets Manager reads, CloudWatch log writes and EB
   enhanced health reporting all fail during it. Renaming the **instance profile**
   instead is worse: that forces the profile to replace *and* changes the EB
   `IamInstanceProfile` setting, which rolls every instance in the ASG.

### B1. Network (`vpc.tf`)

| Resource | Referenced by | On replacement |
|---|---|---|
| `aws_vpc.main` | every subnet, IGW, all 3 SGs, both route tables, `aws_flow_log.main`, EB `VPCId` setting | Total rebuild. Forced by a `cidr_block` change. Cascades to all 4 subnets → `aws_db_subnet_group.aurora` → **Aurora cluster replacement → data loss**. The worst single edit available in this root. |
| `aws_subnet.public[0]` | `aws_nat_gateway.main[0].subnet_id` (force-new), `aws_route_table_association.public[0]`, EB `ELBSubnets` | Forced by `cidr_block`, `availability_zone`, or `vpc_id`. Replaces the NAT gateway (egress outage, IP preserved if the EIP survives) and the route table association. EB `ELBSubnets` setting updates → ALB re-registers. |
| `aws_subnet.public[1]` | `aws_route_table_association.public[1]`, EB `ELBSubnets` | Association replaced; ALB loses one AZ until it returns. |
| `aws_subnet.private[0..1]` | `aws_db_subnet_group.aurora.subnet_ids`, EB `Subnets`, `aws_route_table_association.private[*]` | `db_subnet_group` `subnet_ids` updates **in place** — no cluster replacement. But the destroy half fails with `DependencyViolation` while an Aurora ENI or an EB instance still occupies the subnet, leaving the apply half-done. EB `Subnets` change rolls the ASG into the new subnet. |
| `aws_internet_gateway.main` | `aws_route_table.public` route, `depends_on` for the EIP and NAT | Public subnets lose internet during the swap; ALB unreachable from the internet; NAT egress dies with it. |
| `aws_eip.nat[0]` | `aws_nat_gateway.main[0].allocation_id` (force-new) | **Egress IP changes** (see answer 3). Forces the NAT gateway to replace. `count = var.enable_nat_gateway ? 1 : 0` — setting that variable false destroys both and blackholes all private-subnet egress. |
| `aws_nat_gateway.main[0]` | `aws_route_table.private` dynamic route | Egress outage for private subnets. IP preserved if the EIP is untouched. |
| `aws_route_table.public` | both public associations | Public subnets blackhole until reassociated. |
| `aws_route_table.private` | both private associations | Private-subnet egress blackholes. EB instances cannot pull images or reach AWS APIs. |
| `aws_route_table_association.{public,private}[0..1]` | — | Brief routing gap for one subnet. Cheap. |
| `aws_cloudwatch_log_group.vpc_flow_logs` | `aws_flow_log.main.log_destination` | **Destroying a log group deletes its log events.** Retained VPC flow logs are gone — a compliance artifact, not a runtime dependency. |
| `aws_iam_role.vpc_flow_logs` + `aws_iam_role_policy.vpc_flow_logs` | `aws_flow_log.main.iam_role_arn` | Flow logging stops until the flow log picks up the new ARN. No runtime impact. |
| `aws_flow_log.main` | — | Gap in flow log capture. Compliance only. |

### B2. Security groups (`security-groups.tf`)

| Resource | Referenced by | On replacement |
|---|---|---|
| `aws_security_group.aurora` | `aws_rds_cluster.aurora.vpc_security_group_ids`, `aws_security_group_rule.aurora_ingress_from_eb.security_group_id` | Forced by `name` or `vpc_id`. The cluster's `vpc_security_group_ids` is updatable in place, so **the cluster is not replaced** — but with default (destroy-then-create) ordering the delete of the old SG hits `DependencyViolation` while Aurora still holds it, and the apply fails partway. A rename here is a stuck apply, not a clean swap. |
| `aws_security_group.eb_instance` | EB `SecurityGroups` setting, `aws_security_group.alb` is *its* ingress source, `aws_security_group_rule.aurora_ingress_from_eb.source_security_group_id` (force-new) | Replaces the Aurora ingress rule too. EB setting change rolls the ASG. Until both land, new instances cannot reach the database. |
| `aws_security_group.alb` | EB `aws:elbv2:loadbalancer` `SecurityGroups` setting; referenced by `aws_security_group.eb_instance`'s inline ingress | `eb_instance` updates in place to point at the new ID. EB setting change re-attaches the ALB. Public 80/443 ingress is the only path in — a gap here is a full outage. |
| `aws_security_group_rule.aurora_ingress_from_eb` | — (leaf) | **This is the only path from the application to the database.** Delete it and every query fails with a connection timeout. Replacement is a brief version of the same. Nothing else grants Aurora ingress; the Aurora SG has no other rules and no egress rules at all. |

### B3. Database (`database.tf`)

| Resource | Referenced by | On replacement |
|---|---|---|
| `aws_rds_cluster.aurora` | `aws_rds_cluster_instance.aurora.cluster_identifier` (force-new), `aws_cloudwatch_log_group.aurora.name`, `aws_ssm_parameter.{database_url,db_host,db_name,db_username}`, outputs `aurora_cluster_endpoint`/`aurora_cluster_reader_endpoint`/`database_name` | **Total data loss, no final snapshot** (answer 1). Force-new attributes to watch: `cluster_identifier`, `database_name`, `master_username`, `db_subnet_group_name`, `storage_encrypted`, `engine`. Also replaces the cluster instance. SSM parameters update in place to the new endpoint, but the running app read them at boot and will keep dialing the dead endpoint until it restarts. |
| `aws_rds_cluster_instance.aurora` | — (leaf; the cluster's only member) | **Downtime, not data loss.** ~10–15 min with no writer. Data survives in the cluster volume. Forced by `identifier`, `engine`, or `cluster_identifier` changing. This is the distinction most people get backwards. |
| `aws_db_subnet_group.aurora` | `aws_rds_cluster.aurora.db_subnet_group_name` (**force-new on the cluster**), `aws_rds_cluster_instance.aurora.db_subnet_group_name` | Forced by a `name` change. Because the cluster's `db_subnet_group_name` is force-new, **renaming the subnet group replaces the Aurora cluster → data loss.** A one-word edit, two resources away from the database. |
| `aws_rds_cluster_parameter_group.aurora` | `aws_rds_cluster.aurora.db_cluster_parameter_group_name` | Forced by `name` or `family`. The cluster's reference is updatable in place, so the **cluster is not replaced** — it takes an in-place modify. Static parameters need a cluster reboot to take effect. Safe to rename; not safe to change `family` casually. |
| `aws_cloudwatch_log_group.aurora` | — (leaf) | Name interpolates `aws_rds_cluster.aurora.cluster_identifier`, so a cluster *rename* replaces it; a cluster replacement that keeps the same identifier does not. Destroy deletes retained `postgresql` logs. |
| `random_password.db_password` | `aws_rds_cluster.aurora.master_password`, `aws_ssm_parameter.db_password`, `aws_ssm_parameter.database_url` | Replaced by any change to `length`/`special` or by a `-replace`. The SSM parameters take the new value immediately. `apply_immediately` is not set on the cluster, so the RDS master-password modification is not guaranteed to land at the same moment — treat "SSM says one password, the cluster still accepts the other" as the expected failure shape and verify against the console before declaring it done. Every new instance boot reads the new value. |

### B4. Elastic Beanstalk and IAM (`elastic-beanstalk.tf`, `ssm.tf`)

| Resource | Referenced by | On replacement |
|---|---|---|
| `aws_elastic_beanstalk_application.api` | `aws_elastic_beanstalk_environment.api.application` (force-new) | `name` is force-new. Replacing the application **forces the environment to replace** → new CNAME (answer 2) → every published link dies. Also discards every stored application version, so the deploy history and rollback targets go with it. |
| `aws_elastic_beanstalk_environment.api` | outputs `eb_environment_name`, `eb_environment_url`; every published grader URL | Force-new: `name`, `application`, `tier`. **In-place**: `solution_stack_name`, every `setting` block. Replacement changes the CNAME (answer 2). `lifecycle { ignore_changes = [version_label] }` means the deployed artifact never shows in a diff. Note `solution_stack_name` is the one pin in this config whose validity AWS controls unilaterally — the saved plan artifact still records the retired `v4.9.0`, while the config now carries `v4.13.6`. |
| `aws_iam_role.eb_instance` | `aws_iam_instance_profile.eb.role`, 3 policy attachments, 3 inline policies | Answer 4. Rename = replaced role, momentarily role-less instance profile, running fleet loses all permissions. |
| `aws_iam_instance_profile.eb` | EB `IamInstanceProfile` setting (by **name**), output `eb_instance_profile` | `name` is force-new. Renaming it replaces the profile *and* changes an EB setting → rolling instance replacement across the ASG. |
| `aws_iam_role.eb_service` | EB `ServiceRole` setting (by **ARN**), output `eb_service_role`, 2 policy attachments | Rename replaces the role; the ARN changes; the EB `ServiceRole` setting updates → an environment update. Enhanced health reporting and managed platform updates degrade while it settles. Note the `sts:ExternalId = "elasticbeanstalk"` condition — this is the role the *platform* assumes on your behalf. |
| `aws_iam_role_policy_attachment.eb_{web_tier,worker_tier,multicontainer_docker}` | — | Replaced whenever `aws_iam_role.eb_instance` is. Momentary permission gap; S3 app-version reads and log writes fail in the window. |
| `aws_iam_role_policy_attachment.eb_service_{policy,managed}` | — | Same, for the service role. |
| `aws_iam_role_policy.eb_ssm_access` | — | Grants `ssm:GetParameter*` scoped to `/ship/dev/*` plus `kms:Decrypt` under the SSM service condition. **Editing this in place can take the platform down on the next instance launch** (A6). |
| `aws_iam_role_policy.eb_bedrock_access` | — | Bedrock `InvokeModel` on the anthropic model and inference-profile ARNs. Loss degrades AI quality analysis only; the API keeps serving. |
| `aws_iam_role_policy.eb_secrets_manager_access` | — | Secrets Manager under the `ship/*` prefix plus `kms:Decrypt`/`GenerateDataKey` under the Secrets Manager service condition. Loss breaks FPKI OAuth credential access. |
| `aws_ssm_parameter.{database_url,db_host,db_name,db_username,db_password,session_secret,cors_origin,cdn_domain,app_base_url}` | read by the application at boot; `database_url` and `cors_origin` are also outputs | `name` is force-new; a **value** change is `~` and just cuts a new parameter version. **The application does not re-read them.** A parameter change is inert until the next instance boot or redeploy — which means a plan that looks applied is not necessarily in effect, and equally, a bad parameter change stays hidden until the next instance replacement. Replacing `database_url` or `session_secret` is a boot-time failure or a mass session invalidation respectively. |
| `random_password.session_secret` | `aws_ssm_parameter.session_secret` | Replacement rotates the `express-session` signing key → **every live session cookie is invalidated**, every logged-in user is logged out, on the next instance boot. |
| `data.aws_caller_identity.current` | S3 bucket names, both IAM policy ARN sets | Read-only. If it ever resolved to a different account the bucket names and every ARN would change — i.e. you are applying to the wrong account. |

### B5. Frontend, CDN, storage (`s3-cloudfront.tf`)

| Resource | Referenced by | On replacement |
|---|---|---|
| `aws_s3_bucket.frontend` | CloudFront origin `domain_name` and `origin_id`, `aws_s3_bucket_policy.frontend`, the 3 config sub-resources, output `s3_bucket_name` | Bucket name is force-new and interpolates `var.environment` and the account ID. Replacement means the whole compiled React app is gone until redeployed, the distribution takes an in-place origin update (5–15 min global deploy), and the bucket policy is replaced. Versioning is on and `force_destroy` is **not** set — so the destroy half fails on a non-empty bucket and the apply stops mid-flight. |
| `aws_s3_bucket.uploads` | CORS/lifecycle/versioning/SSE/PAB sub-resources, outputs `uploads_bucket_name`/`uploads_bucket_arn` | **Every user-uploaded file.** Same non-empty-bucket destroy failure. Nothing else in this root reads it; the application resolves it at runtime. |
| `aws_s3_bucket_public_access_block.{frontend,uploads}` | — | Not a runtime dependency — access is granted by the OAC bucket policy and by presigned URLs. Deleting it does not make the bucket public by itself, but it removes the guardrail that stops a later ACL or policy edit from doing so. A `-` here is a security regression, not an outage. |
| `aws_s3_bucket_versioning.{frontend,uploads}` | — | Disabling versioning removes the recovery path for overwritten/deleted objects and *also* removes the reason the destroy of the bucket fails, which is the only thing standing between a `destroy` and permanent loss of uploads. |
| `aws_s3_bucket_server_side_encryption_configuration.{frontend,uploads}` | — | Existing objects keep their encryption; new objects would land unencrypted. Compliance regression. |
| `aws_s3_bucket_cors_configuration.uploads` | — | Browser direct-to-S3 uploads start failing CORS preflight. Note `var.upload_cors_origins` defaults to three **localhost** origins — production browser uploads are not covered by the default. |
| `aws_s3_bucket_lifecycle_configuration.uploads` | — | Incomplete multipart uploads stop being reaped. Cost only. |
| `aws_s3_bucket_policy.frontend` | — | Conditions on the distribution ARN. Deleting it makes CloudFront return 403 for every object → **total frontend outage**, S3 data intact. |
| `aws_cloudfront_distribution.frontend` | `aws_s3_bucket_policy.frontend` (via ARN), `aws_ssm_parameter.{cors_origin,cdn_domain,app_base_url}` (via `domain_name`), outputs `cloudfront_domain_name`/`cloudfront_distribution_id`/`frontend_url` | Almost every attribute is in-place `~`; a change still costs a 5–15 minute global deploy. A **replacement** would mint a new `*.cloudfront.net` hostname — live today: `d258p92d3n1ebe.cloudfront.net` — which changes `CORS_ORIGIN`, `CDN_DOMAIN` and `APP_BASE_URL`, and therefore breaks every OAuth redirect URI registered against the old host. A `destroy` requires disabling the distribution first and is slow. |
| `aws_cloudfront_origin_access_control.frontend` | distribution `origin_access_control_id` | Replacement updates the distribution. A broken OAC means S3 returns 403 for everything → total frontend outage. |
| `aws_cloudfront_function.spa_routing` | distribution `function_association` | `name` is force-new. Code changes are in-place. Losing it breaks SPA deep links (direct navigation to a client route 404s); the app root still loads. |
| `aws_cloudfront_cache_policy.api_no_cache`, `aws_cloudfront_origin_request_policy.api` | the `/api/*`, `/collaboration/*`, `/events` ordered cache behaviors — **which only exist when `var.eb_environment_cname != ""`** | `var.eb_environment_cname` is `""` today and the live distribution carries only the S3 origin, so these two policies are currently created but attached to nothing. Destroying either while it is attached to a distribution fails with a policy-in-use error from CloudFront, which is a mid-apply stop, not a plan-time one. |
| `aws_acm_certificate.app`, `aws_acm_certificate_validation.app`, `aws_route53_record.{app,app_cert_validation}` | gated on `var.app_domain_name` / `var.route53_zone_id`, both `""` | **`count = 0` — these do not exist in state.** If they appear in a plan, someone set a domain variable. The certificate is the one resource in this root with `create_before_destroy`, so it is the only one that could ever show `+/-`. |

### B6. Logging and WAF (`cloudfront-logging.tf`, `waf.tf`)

| Resource | Referenced by | On replacement |
|---|---|---|
| `aws_kinesis_stream.cloudfront_logs` | `aws_cloudfront_realtime_log_config.main`, `aws_iam_role_policy.cloudfront_realtime_logs` (by ARN) | `name` is force-new and interpolates `var.environment`. Replacement discards everything still inside the 180-day (`retention_period = 4320` hours) window and forces the realtime log config to update. 4 provisioned shards — a rename is also a billing event. No runtime impact on the application. |
| `aws_iam_role.cloudfront_realtime_logs` + `aws_iam_role_policy.cloudfront_realtime_logs` | realtime log config `role_arn` | Log delivery stalls until the config picks up the new ARN. Security monitoring gap, no user impact. |
| `aws_cloudfront_realtime_log_config.main` | distribution `default_cache_behavior.realtime_log_config_arn` | Replacement forces a distribution update. Loss = no real-time access logs. Nothing persistent is destroyed. |
| `aws_wafv2_web_acl.cloudfront[0]` | distribution `web_acl_id` | `name` and `scope` are force-new. **Destroying it while the distribution is still associated fails with `WAFAssociatedItemException`** — Terraform must update the distribution first. While it is gone, the site loses rate limiting (300/IP), IP reputation, the common rule set, known-bad-inputs, SQLi, and bot control. `count = var.cloudfront_waf_web_acl_id == "" ? 1 : 0` — supplying that variable destroys this ACL and swaps the distribution to the external ARN. |
| `aws_wafv2_ip_set.bad_ips[0]` | the `BadIPs` rule inside the web ACL, by ARN | Replacement forces an in-place update of the web ACL to the new ARN, and the block list is empty on the new set until repopulated. It has real dependents — do **not** confuse it with the next row. |
| `aws_wafv2_regex_pattern_set.static_files[0]` | **nothing** | Declared in `waf.tf` and applied, but no rule references it — `grep -rn static_files terraform/` returns only its own declaration. Blast radius on destroy or replacement: **none**. This is the config's resident decoy: a resource whose deletion looks alarming and costs nothing. The correct move is still to grep for references rather than assume. |

### B7. One-variable blast radii

Not resources, but the highest-leverage edits in the root. Worth knowing cold, because
the plan for each of these is long and the cause is one line.

| Edit | What the plan looks like |
|---|---|
| `var.environment` `"dev"` → `"prod"` | Both S3 bucket names change → **both buckets replaced** (destroy blocked while non-empty). All 9 SSM parameter paths change → **all 9 replaced**, the old paths deleted, the running app pointed at names that no longer exist on next boot. Kinesis stream, CF realtime log config, its IAM role, and all three WAF resources rename → replaced. Aurora flips to `skip_final_snapshot = false` and `backup_retention_period = 7`, which is safer, but by then everything else has moved. |
| `var.aws_region` | Provider region moves; every resource in state is in the old region. Also rewrites the SSM and Secrets Manager ARNs in two inline policies and the `AWS_REGION` EB setting. Not a plan you reconcile — it is a plan you abort. |
| `var.enable_nat_gateway` `true` → `false` | Destroys `aws_eip.nat[0]` and `aws_nat_gateway.main[0]` and drops the default route from the private route table. Private-subnet egress blackholes: no ECR pulls, no SSM, no Bedrock, no Secrets Manager. |
| `var.eb_environment_cname` `""` → a hostname | Adds an EB origin and five ordered cache behaviors to the distribution — all in-place `~` on `aws_cloudfront_distribution.frontend`, plus a global deploy. This is the edit that would put the API behind CloudFront. |
| `var.cloudfront_waf_web_acl_id` `""` → an ARN | Destroys all three `waf.tf` resources and repoints `web_acl_id` at the supplied ACL. |
| `var.app_domain_name` `""` → a domain | Creates the ACM certificate (`+/-`-capable), adds `aliases` to the distribution, flips `viewer_certificate`, and rewrites `CORS_ORIGIN`, `CDN_DOMAIN` and `APP_BASE_URL`. |

---

## Drill card

The one-minute version, for the moment the plan is on screen.

1. `grep "must be replaced"` and `grep "forces replacement"` — first, always.
2. Read the summary. `to add` and `to destroy` both non-zero on an unchanged resource set = replacements.
3. For each replacement, name the resource, then say *data loss / hostname change / IP change / downtime only / cosmetic*.
4. For each `~`, ask "does this change an IAM policy, an EB setting, or an SSM value?" Those three are the in-place changes that hurt.
5. Check `Changes to Outputs:` — that block tells you which published value moved.
6. Say out loud what will fail and when: **now**, **on the next instance boot**, or **on the next deploy**. The three are not the same, and the difference is most of the answer.
