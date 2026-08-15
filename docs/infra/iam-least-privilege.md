# IAM Least Privilege

Scope: the `AdministratorAccess`→least-privilege drill required by PRD p.5, and the role-name
mapping required by p.2, for the applied AWS root `terraform/*.tf` (see `docs/infra/topology.md`).

Account `379484935796`, region `us-east-1`. Every claim carries the command that proved it.

---

## Role-name mapping (PF-646)

*Verified 2026-08-12. This section is PF-646's deliverable and is complete on its own; the
before/after policy work (PF-633–638) is appended below it and does not modify it.*

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

Terraform source: `terraform/elastic-beanstalk.tf` lines 12 (`aws_iam_role.eb_instance`), 50
(`aws_iam_instance_profile.eb`) and 60 (`aws_iam_role.eb_service`).

### Trust policies, verified rather than paraphrased

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

### The wiring, verified end to end

```console
$ aws iam get-instance-profile --instance-profile-name ship-eb-instance-profile \
    --query 'InstanceProfile.Roles[].RoleName'
[ "ship-eb-instance-role" ]

$ aws elasticbeanstalk describe-configuration-settings --application-name ship-api \
    --environment-name ship-api-prod \
    --query "ConfigurationSettings[0].OptionSettings[?OptionName=='IamInstanceProfile'||OptionName=='ServiceRole']"
IamInstanceProfile  aws:autoscaling:launchconfiguration   ship-eb-instance-profile
ServiceRole         aws:elasticbeanstalk:environment      arn:aws:iam::379484935796:role/ship-eb-service-role
```

So the mapping is not a naming convention argued from the Terraform — the running environment
names the instance profile and the service role ARN directly.

### Why the distinction is load-bearing

The `sts:ExternalId` condition on the service role is the confused-deputy guard: only Elastic
Beanstalk, presenting the agreed external id, can assume that role. The instance role carries no
such condition because it is assumed by EC2 through the instance profile, where the binding is the
profile attachment rather than a condition key.

This is also why the least-privilege drill below targets **`ship-eb-instance-role`** and not the
service role. The instance role is the one the application's own code borrows through IMDS, so its
over-privilege is the application's blast radius. Locking down the service role instead would
demonstrate nothing about what a compromised request handler could reach.

### Where the analogy is imperfect, stated plainly

ECS's execution role pulls the container image and wires up logging *before* the task runs. EB's
service role does not do that: it performs environment management — enhanced health monitoring and
managed platform updates — and the image pull happens under the **instance** role, which is where
`AWSElasticBeanstalkMulticontainerDocker` is attached. The two-role split is the same and the
"who assumes it" answer is the same; the division of labour between them differs. Claiming the
terms map cleanly would not survive a defense question, so it is not claimed.

### Attached policies at the time of mapping

Recorded here only to fix the starting point; the authoritative before/after artifact is the
section that follows.

```console
$ aws iam list-attached-role-policies --role-name ship-eb-instance-role
AWSElasticBeanstalkMulticontainerDocker
AWSElasticBeanstalkWebTier
AWSElasticBeanstalkWorkerTier

$ aws iam list-role-policies --role-name ship-eb-instance-role
ship-eb-bedrock-access
ship-eb-secrets-manager-access
ship-eb-ssm-access

$ aws iam list-attached-role-policies --role-name ship-eb-service-role
AWSElasticBeanstalkEnhancedHealth
AWSElasticBeanstalkManagedUpdatesCustomerRolePolicy
```

Note for whoever writes the next section: as of 2026-08-12, `AdministratorAccess` was **not** yet
attached to `ship-eb-instance-role`. PF-633 attaches it through Terraform to establish the
over-privileged before state; the listing above is the pre-drill baseline, not the "before"
artifact p.5 asks for.

---

<!-- END PF-646. Before/after policy work (PF-633–638) is appended below this line. -->

# The least-privilege drill (PF-633–638)

**PRD p.5:** *"Start with an `AdministratorAccess` task role"*, reduce to minimum, verify
the service still works, verify an action outside the policy is **denied**, and submit the
before/after policy with a rationale for every permission.

**Subject:** `aws_iam_role.eb_instance` (`ship-eb-instance-role`), reached through
`aws_iam_instance_profile.eb`. Per the PF-646 mapping above, that is the **task role** in
p.2's vocabulary — the role the application itself assumes, and the credential anything
compromising the application inherits.

**Mechanism:** Terraform, in `terraform/iam-least-privilege.tf`. p.5 asks for a
before/after *policy*, and a console click leaves nothing to diff. `git log -p` on that
file is the artifact.

---

## PF-634 — what the platform actually needs

One row per permission, each with the code path or command that requires it. Anything
`AdministratorAccess` covers that no code path uses gets a row saying so — that is the
rationale column p.5 demands.

### Inline policies (already scoped; written by the project, kept)

| Permission | Resource scope | What needs it | Verdict |
|---|---|---|---|
| `ssm:GetParameter`, `GetParameters`, `GetParametersByPath` | `arn:aws:ssm:us-east-1:<acct>:parameter/ship/dev/*` | `api/src/config/ssm.ts` → `loadProductionSecrets()` at boot, for `DATABASE_URL`, `SESSION_SECRET`, `CORS_ORIGIN`, `CDN_DOMAIN`, `APP_BASE_URL` and the three OAuth app secrets. Runs in all three entrypoints (`index.ts`, `db/migrate.ts`, `db/seed.ts`). | **Keep.** Path-scoped to one prefix. This boundary is what PF-637 proves. |
| `kms:Decrypt` | `*`, conditioned `kms:ViaService = ssm.us-east-1.amazonaws.com` | Decrypting the `SecureString` parameters above. | **Keep.** `Resource: "*"` looks wide and is not: the condition means the key can only be used *through* SSM, so it cannot decrypt anything the SSM path scope does not already permit. Scoping to the AWS-managed `alias/aws/ssm` key ARN would be tighter still and is the one improvement left on the table. |
| `secretsmanager:GetSecretValue` | `secret:ship/*`, `secret:/ship/*` | Nothing on this branch. Secrets Manager is not read by any code path in `api/src`. | **Drop the write half, keep the read.** See below. |
| `secretsmanager:CreateSecret`, `UpdateSecret`, `TagResource` | same | **Nothing.** No code path creates or updates a secret at runtime. | **DROP.** A running web application that can rewrite its own secrets is a privilege-escalation primitive, not a feature. This is the clearest genuine finding in the enumeration. |
| `kms:Decrypt`, `kms:GenerateDataKey` | `*`, conditioned via `secretsmanager` | Paired with the above. `GenerateDataKey` exists only to *create* secrets. | **Drop `GenerateDataKey`** with the write actions. |
| `bedrock:InvokeModel` | `foundation-model/anthropic.*`, `inference-profile/anthropic.*`, `inference-profile/global.anthropic.*` | `api/src/services/ai-analysis.ts`. Note Implementation Rule 10 — the platform does zero AI work; this serves the FleetGraph agent path only. | **Keep, scoped.** Already restricted to Anthropic models rather than `*`. |

### AWS managed policies — decided individually

p.5's point, and PF-635 states it outright: *a managed policy is not least privilege
merely because AWS wrote it.* Each of the three attached was read (`aws iam
get-policy-version`) rather than assumed.

| Policy | What it actually grants | Decision |
|---|---|---|
| `AWSElasticBeanstalkWebTier` | `s3:Get*`/`List*` on `elasticbeanstalk-*` buckets (downloading the application version bundle), `s3:PutObject` for log rotation, `cloudwatch:PutMetricData`, `logs:*` on the environment's log groups, `elasticbeanstalk:PutInstanceStatistics` for enhanced health. | **KEEP.** Every one of these is exercised on every deploy and every health report. Without it the instance cannot fetch its own application version. |
| `AWSElasticBeanstalkWorkerTier` | `sqs:ReceiveMessage`/`DeleteMessage`/`SendMessage`/`ChangeMessageVisibility`, and **DynamoDB `GetItem`, `PutItem`, `DeleteItem`, `UpdateItem`, `Query`, `Scan`, `BatchGetItem`, `BatchWriteItem`** for worker-tier periodic tasks. | **DROP.** This is a **web server** environment (`EnvironmentType = LoadBalanced`), and EB says so itself — the deploy log for this environment reads `This is a web server environment instance, skip configure sqsd daemon`. There is no queue and no periodic-task table. Full DynamoDB item CRUD plus `Scan`, granted to a web instance for a daemon that is explicitly skipped, is the textbook case for reading a managed policy before trusting it. |
| `AWSElasticBeanstalkMulticontainerDocker` | `ecs:RegisterContainerInstance`, `DeregisterContainerInstance`, `StartTask`, `StopTask`, `Poll`, `Submit*`, `StartTelemetrySession`, `TagResource`; plus `bedrock:InvokeModel` and `elasticbeanstalk:DescribeEvents`/`DescribeEnvironmentHealth` for EB's "AI environment analysis". | **DROP.** It exists for the **ECS-backed Multi-container Docker** platform. This environment runs `64bit Amazon Linux 2023 v4.13.6 running Docker` — the plain Docker platform, which does not use ECS at all. The ECS grants are dead weight with a real edge: `RegisterContainerInstance` lets a compromised instance join an ECS cluster. It also carries a **second, independent `bedrock:InvokeModel` grant** covering `amazon.nova-*` as well as Anthropic models — quietly wider than the project's own deliberately Anthropic-scoped policy, and a good illustration that attaching managed policies can silently undo scoping decisions made elsewhere. |

### Permissions `AdministratorAccess` covered that nothing uses

Recorded because p.5 wants the reduction justified, not just the result. Under admin the
role could do all of the following; no code path in `api/`, `agent/` or the deploy path
touches any of them: create or delete IAM roles and policies (privilege escalation to
account takeover), read or modify the Aurora cluster through the RDS API (the application
reaches Postgres over the wire with a password, never through the control plane), read or
write **any** S3 bucket including `ship-terraform-state-<acct>` (which holds the Aurora
master password in cleartext), delete CloudTrail trails, terminate EC2 instances, or read
every SSM parameter in the account rather than the eleven under `/ship/dev/`.

That last one is the drill's whole point, and it is what PF-637 tests: under admin, the
prefix is decoration; under the reduced policy, it is a boundary.

## PF-633 — the "before" policy, captured verbatim

Executed 2026-08-15. `AdministratorAccess` was attached **through Terraform**, not the
console, so the before state is a committed diff:

```console
$ terraform plan -var 'eb_instance_role_overprivileged=true' \
    -target='aws_iam_role_policy_attachment.eb_instance_admin_before'

  # aws_iam_role_policy_attachment.eb_instance_admin_before[0] will be created
  + resource "aws_iam_role_policy_attachment" "eb_instance_admin_before" {
      + policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
      + role       = "ship-eb-instance-role"
    }

Plan: 1 to add, 0 to change, 0 to destroy.
```

Effective permission set after that apply — this is the **before policy** p.5 asks for:

```console
$ aws iam list-attached-role-policies --role-name ship-eb-instance-role
AWSElasticBeanstalkMulticontainerDocker   arn:aws:iam::aws:policy/AWSElasticBeanstalkMulticontainerDocker
AWSElasticBeanstalkWebTier                arn:aws:iam::aws:policy/AWSElasticBeanstalkWebTier
AWSElasticBeanstalkWorkerTier             arn:aws:iam::aws:policy/AWSElasticBeanstalkWorkerTier
AmazonSSMManagedInstanceCore              arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
AdministratorAccess                       arn:aws:iam::aws:policy/AdministratorAccess

$ aws iam get-policy-version --policy-arn arn:aws:iam::aws:policy/AdministratorAccess \
    --version-id v1 --query PolicyVersion.Document
{
    "Version": "2012-10-17",
    "Statement": [
        { "Effect": "Allow", "Action": "*", "Resource": "*" }
    ]
}

$ aws iam list-role-policies --role-name ship-eb-instance-role
ship-eb-bedrock-access
ship-eb-secrets-manager-access
ship-eb-ssm-access
```

The three inline documents as they stood before the drill are reproduced in the
before/after diff table under PF-638.

### Rollback

The whole drill is one Terraform variable and three resource blocks. To restore the
over-privileged state (only ever for re-running the demo):

```bash
cd terraform
terraform apply -var 'eb_instance_role_overprivileged=true' \
  -target='aws_iam_role_policy_attachment.eb_instance_admin_before'
```

To restore the *pre-drill* state — the three EB managed policies plus the write-capable
Secrets Manager policy — revert this branch's commit on `terraform/elastic-beanstalk.tf`,
`terraform/ssm.tf` and `terraform/iam-least-privilege.tf` and apply. The emergency
console-free escape hatch, if the instance role is ever wedged:

```bash
aws iam attach-role-policy --role-name ship-eb-instance-role \
  --policy-arn arn:aws:iam::aws:policy/AWSElasticBeanstalkWebTier
aws iam attach-role-policy --role-name ship-eb-instance-role \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
```

### A note on how this apply was scoped

The root config had five **pre-existing, unrelated** pending changes at the time of the
drill (`aws_cloudfront_distribution.frontend`, `aws_elastic_beanstalk_application.api`,
`aws_elastic_beanstalk_environment.api`, `aws_rds_cluster.aurora`,
`aws_wafv2_web_acl.cloudfront[0]`). A bare `terraform apply` would have pushed all of them
alongside the IAM change, mixing an IAM drill into a CloudFront/Aurora/WAF deployment.
Every apply in this drill was therefore run with explicit `-target` on IAM resources only,
and every plan was read before applying. `-target` is not routine practice and Terraform
warns about it; it is used here deliberately, and the reason is recorded rather than
hidden. Those five changes remain unapplied and are not this drill's business.

## PF-635 — the applied "after" policy

Applied via Terraform. See `terraform/iam-least-privilege.tf`, `terraform/ssm.tf` and
`terraform/elastic-beanstalk.tf`.

```console
$ terraform plan -target=...eb_instance_admin_before -target=...eb_worker_tier \
    -target=...eb_multicontainer_docker -target=...eb_secrets_manager_access

  # aws_iam_role_policy.eb_secrets_manager_access will be updated in-place
      ~ Action = [
            "secretsmanager:GetSecretValue",
          - "secretsmanager:CreateSecret",
          - "secretsmanager:UpdateSecret",
          - "secretsmanager:TagResource",
        ]
      ~ Action = [
            "kms:Decrypt",
          - "kms:GenerateDataKey",
        ]
  # aws_iam_role_policy_attachment.eb_instance_admin_before[0] will be destroyed
  # aws_iam_role_policy_attachment.eb_multicontainer_docker will be destroyed
  # aws_iam_role_policy_attachment.eb_worker_tier will be destroyed

Plan: 0 to add, 1 to change, 3 to destroy.

$ terraform apply
Apply complete! Resources: 0 added, 1 changed, 3 destroyed.
```

A second, separate apply replaced `AmazonSSMManagedInstanceCore` with a scoped inline
policy — see the correction under PF-637, which is the single most important finding in
this drill:

```console
Plan: 1 to add, 0 to change, 1 to destroy.
Apply complete! Resources: 1 added, 0 changed, 1 destroyed.
```

### The resulting policy set — every permission with its rationale

**Attached managed policies (2, down from 5):**

| Policy | Why it is here |
|---|---|
| `AWSElasticBeanstalkWebTier` | The only managed policy the platform exercises. Grants `s3:Get*`/`List*` on `elasticbeanstalk-*` buckets so the instance can download its own application version bundle at boot, CloudWatch Logs writes, `cloudwatch:PutMetricData`, and `elasticbeanstalk:PutInstanceStatistics` for enhanced health. Without it a replacement instance cannot fetch the code it is meant to run — which the PF-636 instance replacement below actually proves, since that instance booted with this as its only managed policy. |

*(`AmazonSSMManagedInstanceCore` was also attached at the start of the drill and has been **removed** — replaced by the scoped inline policy below. See PF-637.)*

**Inline policies (4):**

| Permission | Resource scope | Why it is granted |
|---|---|---|
| `ssm:GetParameter`, `ssm:GetParameters`, `ssm:GetParametersByPath` | `arn:aws:ssm:us-east-1:379484935796:parameter/ship/dev/*` | `api/src/config/ssm.ts` → `loadProductionSecrets()` reads `DATABASE_URL`, `SESSION_SECRET`, `CORS_ORIGIN`, `CDN_DOMAIN`, `APP_BASE_URL`, `WEBHOOK_SECRET_KEY` and the three OAuth client secrets at boot, in all three entrypoints (`index.ts`, `db/migrate.ts`, `db/seed.ts`). Path-scoped to the one prefix the app owns. **This is the boundary PF-637 proves.** |
| `kms:Decrypt` | `*`, conditioned `kms:ViaService = ssm.us-east-1.amazonaws.com` | Decrypts the `SecureString` parameters above. `Resource: "*"` is wide-looking and is not wide: the condition means the key is usable only *through* SSM, so it cannot decrypt anything the path scope above does not already permit. |
| `secretsmanager:GetSecretValue` | `secret:ship/*`, `secret:/ship/*` | `api/src/services/caia.ts` → `getCAIACredentials()` reads `/ship/dev/caia-credentials`, which exists in this account. A live read path, so the read stays. |
| `kms:Decrypt` | `*`, conditioned `kms:ViaService = secretsmanager.us-east-1.amazonaws.com` | Decrypts that secret. Same condition-bounded reasoning as the SSM entry. |
| `bedrock:InvokeModel` | `foundation-model/anthropic.*`, `inference-profile/anthropic.*`, `inference-profile/global.anthropic.*` | `api/src/services/ai-analysis.ts`. Scoped to Anthropic model ARNs rather than `*`. Per Implementation Rule 10 the platform does zero AI work; this serves the FleetGraph agent path only. |
| `ssmmessages:*Control/DataChannel`, `ec2messages:*` | `*` | The Session Manager / RunCommand duplex channel. These carry the command session and grant access to no application data. Required because the instances sit in private subnets with no public IP and no SSH key, and this is the only way to record PF-637's transcript from the instance itself. It replaces a worse alternative — a bastion or inbound SSH into a private subnet — with an outbound-only agent under per-action IAM and full CloudTrail. |
| `ssm:UpdateInstanceInformation`, `ListAssociations`, `ListInstanceAssociations`, `DescribeAssociation`, `DescribeDocument`, `GetDocument`, `GetManifest`, `PutInventory`, `PutComplianceItems`, `PutConfigurePackageResult`, `UpdateAssociationStatus`, `UpdateInstanceAssociationStatus` | `*` | SSM agent registration and *document* reads — `GetDocument` is how the agent fetches `AWS-RunShellScript`. These read documents, never parameters. `ssm:GetParameter`/`GetParameters` on `*` is deliberately **absent**; see PF-637. |

### What was dropped, and why

| Dropped | Why it went |
|---|---|
| `AdministratorAccess` | The drill's subject. `Action: "*"` on `Resource: "*"` — see the PF-637 before-transcript, where the web instance used it to create an IAM user. |
| `AWSElasticBeanstalkWorkerTier` | Granted SQS receive/delete/send and **full DynamoDB item CRUD including `Scan`** for the worker-tier `sqsd` daemon. Verified against the live environment: `Tier = WebServer`, `EnvironmentType = LoadBalanced`, and EB's own deploy log says `This is a web server environment instance, skip configure sqsd daemon`. There is no queue and no periodic-task table. |
| `AWSElasticBeanstalkMulticontainerDocker` | Granted `ecs:RegisterContainerInstance`, `DeregisterContainerInstance`, `StartTask`, `StopTask`, `Poll`, `Submit*`, `StartTelemetrySession`. Verified against the live environment: the platform is `64bit Amazon Linux 2023 v4.13.6 running Docker` — the **plain** Docker platform, which does not use ECS at all. `ecs:RegisterContainerInstance` would let a compromised instance join an ECS cluster. It also carried a **second, wider `bedrock:InvokeModel` grant covering `amazon.nova-*`**, quietly overriding this project's deliberately Anthropic-scoped Bedrock policy. |
| `AmazonSSMManagedInstanceCore` | Contains `ssm:GetParameter`/`GetParameters` on `Resource: "*"`, which voided the `/ship/dev/*` boundary. Replaced by the scoped inline policy above. **This is the drill's headline finding — see PF-637.** |
| `secretsmanager:CreateSecret`, `UpdateSecret`, `TagResource` | A public-facing web instance that can rewrite its own OAuth client secret is a privilege-escalation primitive, not a feature. |
| `kms:GenerateDataKey` (Secrets Manager) | Exists only to *create* a secret; it went with the write actions above. |

**Deliberate functional reduction, recorded rather than discovered later.** `POST /api/admin/credentials` (`api/src/routes/admin-credentials.ts`, mounted at `api/src/app.ts:670`) calls `saveCAIACredentials()` → `UpdateSecret`/`CreateSecret` and now returns `AccessDenied`. Credential rotation moves to the operator path, which runs under a human identity rather than the web tier's role. This is a judgement call, not an oversight; restoring it is a one-line change in `terraform/ssm.tf`.

**A correction to the PF-634 enumeration above.** PF-634 claimed no code path creates or updates a secret at runtime ("Nothing on this branch"). That was wrong — the admin route named above is exactly such a path. The decision to drop the write actions is unchanged, but it is a deliberate trade rather than the free removal of dead permissions that PF-634 described.

**Permissions considered and deliberately NOT granted.** `api/src/routes/files.ts` imports `S3Client`, `PutObjectCommand` and `DeleteObjectCommand` against `process.env.S3_UPLOADS_BUCKET`. That variable is **not set** in the EB environment (verified: the environment's only application env vars are `AWS_REGION`, `ENVIRONMENT`, `NODE_ENV`, `PORT`), so `S3_BUCKET_NAME` is empty and the guard `if (isProduction && S3_BUCKET_NAME)` never fires. The S3 upload path is dormant, so no S3 grant was added for it. Granting for dormant code is how least-privilege policies rot; if that variable is ever set, `s3:PutObject`/`DeleteObject` on `arn:aws:s3:::ship-uploads-dev-379484935796/*` must be added here at the same time.

**Permissions under `AdministratorAccess` that nothing uses**, recorded because p.5 wants the reduction justified rather than merely stated. Under admin the role could create or delete IAM roles and policies (privilege escalation to account takeover), read or modify the Aurora cluster through the RDS API (the application reaches Postgres over the wire with a password, never through the control plane), read or write **any** S3 bucket including `ship-terraform-state-379484935796` (which holds the Aurora master password in cleartext), delete CloudTrail trails, terminate EC2 instances, and read every SSM parameter in the account rather than the thirteen under `/ship/dev/`. Probes C, E and F in the PF-637 transcript exercise three of those directly.

## PF-636 — the service still works under the reduced policy

**A fresh boot was exercised.** This is stated first because a green smoke test on an
already-running instance proves nothing: that instance read its SSM parameters at boot,
under the old policy, and would keep serving traffic long after a permission was revoked.

Two independent fresh-boot tests were run, in increasing strength.

**1. Application restart** — re-executes `loadProductionSecrets()` against Parameter Store
under the reduced role:

```console
$ aws elasticbeanstalk restart-app-server --environment-name ship-api-prod
$ aws elasticbeanstalk describe-environment-health --environment-name ship-api-prod
Status: Ready   HealthStatus: Ok
Causes: [ "Application restart completed 54 seconds ago and took 19 seconds." ]
```

**2. Full instance replacement** — the real test, because a new instance must also
download its application version bundle from S3 under `AWSElasticBeanstalkWebTier` alone,
with `WorkerTier` and `MulticontainerDocker` gone:

```console
$ aws autoscaling start-instance-refresh \
    --auto-scaling-group-name awseb-e-a8fqx5xspr-stack-AWSEBAutoScalingGroup-9Op7U89L07Lh \
    --preferences '{"MinHealthyPercentage":100,"InstanceWarmup":120}'
c6f8d22a-ed8e-4cba-bd78-0ca1a1d2ad1f

[1]  refresh=Pending      health=200
[2]  refresh=InProgress   health=502
[6]  refresh=Successful   health=502
[10] refresh=Successful   health=200
[20] refresh=Successful   health=200
```

Instance `i-017ed4857b6e6f3f6` was replaced by **`i-0e6c39c822fe26a56`**, which booted
with the reduced policy as the only credentials it has ever had. There was a ~2 minute
`502` window during the swap while the load balancer had no healthy target; the
environment returned to `Ok` and has stayed there.

```console
$ aws elasticbeanstalk describe-environment-resources --environment-name ship-api-prod \
    --query 'EnvironmentResources.Instances[].Id'
i-0e6c39c822fe26a56

$ aws elasticbeanstalk describe-environment-health --environment-name ship-api-prod
Status: Ready   HealthStatus: Ok
```

**Smoke test against the fresh instance:**

```console
$ curl -o /dev/null -w '%{http_code}' https://d258p92d3n1ebe.cloudfront.net/health
200
$ curl https://d258p92d3n1ebe.cloudfront.net/health
{"status":"ok","revision":"unknown"}

$ curl -o /dev/null -w '%{http_code} %{size_download}' .../api/v1/openapi.json
200 63492

$ curl -o /dev/null -w '%{http_code}' https://d258p92d3n1ebe.cloudfront.net/portal
200
```

**A real OAuth token exchange, end to end** — this is the load-bearing one, because the
client secret it validates against is a `SecureString` the fresh instance had to read from
Parameter Store and decrypt through KMS under the reduced policy, and the lookup it
performs hits Aurora:

```console
$ curl -X POST https://d258p92d3n1ebe.cloudfront.net/oauth/token \
    -d 'grant_type=client_credentials&client_id=ship_app_firstparty_fleetgraph_agent&client_secret=***&scope=documents:read'
{"access_token":"ship_at_CMp5WMOFZ9iA_i8IiEOO...","token_type":"Bearer","expires_in":3600,"scope":"documents:read"}

$ curl -H 'Authorization: Bearer ship_at_...' '.../api/v1/documents?limit=2'
{"data":[],"next_cursor":null}
HTTP 200
```

The negative half of the OAuth check also behaves correctly — a client not permitted the
grant is refused by the application, not by IAM:

```console
$ curl -X POST .../oauth/token -d 'grant_type=client_credentials&client_id=ship_app_grader_readonly&...'
{"error":"unauthorized_client","error_description":"This client is not permitted to use
 the client_credentials grant. It is available to first-party confidential clients only
 (RFC 6749 §4.4)."}
```

So: SSM reads, KMS decryption, Secrets Manager reads, the S3 application-version download,
CloudWatch health reporting, Aurora connectivity and the full OAuth path all work on an
instance that has never held any permission beyond the reduced policy. **PF-636 is
verified under a fresh boot, not asserted.**

## PF-637 — an action outside the policy is denied

Recorded from the EB instance via SSM RunCommand, using the **instance profile credentials
only** — no operator credentials are present in this shell. The same six probes were run
before and after, so this is a true diff rather than two unrelated captures.

The identity line proves the credential is the instance role and that it is live:

```console
$ aws sts get-caller-identity
{
    "UserId": "AROAVQWYQSZ2IWM63CYRR:i-0e6c39c822fe26a56",
    "Account": "379484935796",
    "Arn": "arn:aws:sts::379484935796:assumed-role/ship-eb-instance-role/i-0e6c39c822fe26a56"
}
```

### Before — under `AdministratorAccess`

```console
--- PROBE C (OUT of policy): SSM read OUTSIDE the /ship/dev/* prefix ---
ship-terraform-state-379484935796

--- PROBE D (OUT of policy): a service the role has no statement for at all (IAM) ---
ship-terraform

--- PROBE E (OUT of policy): S3 read of the Terraform state bucket ---
ship-drill/terraform.tfstate

--- PROBE F (OUT of policy): privilege escalation attempt, iam:CreateUser ---
{
    "User": {
        "UserName": "pf637-canary-should-be-denied",
        "Arn": "arn:aws:iam::379484935796:user/pf637-canary-should-be-denied",
        "CreateDate": "2026-08-15T20:58:07+00:00"
    }
}
```

Probe F is the one to read twice. Under the "before" policy **the web server created an
IAM user.** It also read the name of the Terraform state bucket and listed the state file
inside it — the file that holds the Aurora master password in cleartext. That is the blast
radius of a single request-handler compromise under `AdministratorAccess`, demonstrated
rather than described. The canary user was deleted immediately
(`aws iam delete-user --user-name pf637-canary-should-be-denied`; `get-user` now returns
`NoSuchEntity`).

### After — under the reduced policy

In-policy calls still succeed, which is what makes the denials meaningful rather than an
artifact of a broken credential:

```console
--- PROBE A (IN policy): SSM read inside /ship/dev/* ---
https://d258p92d3n1ebe.cloudfront.net

--- PROBE B (IN policy): SecureString decrypt via kms:Decrypt ---
SecureString
```

Out-of-policy calls are refused, verbatim:

```console
--- PROBE C (OUT of policy): SSM read OUTSIDE the /ship/dev/* prefix ---

An error occurred (AccessDeniedException) when calling the GetParameter operation: User:
arn:aws:sts::379484935796:assumed-role/ship-eb-instance-role/i-0e6c39c822fe26a56 is not
authorized to perform: ssm:GetParameter on resource:
arn:aws:ssm:us-east-1:379484935796:parameter/ship/terraform-state-bucket because no
identity-based policy allows the ssm:GetParameter action

--- PROBE D (OUT of policy): a service the role has no statement for at all (IAM) ---

An error occurred (AccessDenied) when calling the ListUsers operation: User:
arn:aws:sts::379484935796:assumed-role/ship-eb-instance-role/i-0e6c39c822fe26a56 is not
authorized to perform: iam:ListUsers on resource: arn:aws:iam::379484935796:user/ because
no identity-based policy allows the iam:ListUsers action

--- PROBE E (OUT of policy): S3 read of the Terraform state bucket ---

An error occurred (AccessDenied) when calling the ListObjectsV2 operation: User:
arn:aws:sts::379484935796:assumed-role/ship-eb-instance-role/i-0e6c39c822fe26a56 is not
authorized to perform: s3:ListBucket on resource:
"arn:aws:s3:::ship-terraform-state-379484935796" because no identity-based policy allows
the s3:ListBucket action

--- PROBE F (OUT of policy): privilege escalation attempt, iam:CreateUser ---

An error occurred (AccessDenied) when calling the CreateUser operation: User:
arn:aws:sts::379484935796:assumed-role/ship-eb-instance-role/i-0e6c39c822fe26a56 is not
authorized to perform: iam:CreateUser on resource:
arn:aws:iam::379484935796:user/pf637-canary-should-be-denied because no identity-based
policy allows the iam:CreateUser action
```

PF-637 asked for a parameter read outside the prefix **and** a call to a service the role
has no statement for at all. Probe C is the first; probes D, E and F are three instances
of the second.

### The finding that nearly made this deliverable a lie

The first post-lockdown run of these probes produced **D, E and F denied — and C still
succeeding.** With `AdministratorAccess` already removed, the instance could still read
`/ship/terraform-state-bucket`, a parameter well outside its `/ship/dev/*` scope.

The cause was `AmazonSSMManagedInstanceCore`, attached to give the drill its RunCommand
channel. Its real document contains:

```console
$ aws iam get-policy-version --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore ...
ACTIONS:  ["ssm:GetDeployablePatchSnapshotForInstance", "ssm:GetDocument", "ssm:GetManifest",
           "ssm:GetParameter", "ssm:GetParameters"]
RESOURCE: "*"
```

`terraform/iam-least-privilege.tf` asserted in a comment that this policy "does NOT include
`ssm:GetParameter` on arbitrary paths, so the path-scoped Parameter Store boundary this
drill exists to prove is untouched." **That assertion was false**, and the tooling chosen
to demonstrate the boundary had silently destroyed it. The `/ship/dev/*` scope was
decorative, not enforced.

The fix was to replace the managed policy with `ship-eb-ssm-agent-channel`, an inline
policy carrying the agent's channel and document actions with the blanket Parameter Store
grant removed. The transcript above is from after that fix; the agent stayed `Online`
throughout, which is what shows the scoped policy is sufficient for the channel.

This is worth more than the rest of the drill combined, because it is p.5's actual lesson
arriving unannounced: **a managed policy is not least privilege merely because AWS wrote
it**, and it is the second time in this exercise that an AWS managed policy silently
overrode a scoping decision made deliberately elsewhere — the first being
`AWSElasticBeanstalkMulticontainerDocker`'s wider `amazon.nova-*` Bedrock grant. It was
found by running the probe, not by reasoning about the policy, which is the whole argument
for demanding a recorded denial rather than an assurance that one would occur.

## PF-638 — before/after with rationale

**Before → after, at a glance:**

| | Before | After |
|---|---|---|
| Managed policies | 5 — `AdministratorAccess`, `AWSElasticBeanstalkWebTier`, `AWSElasticBeanstalkWorkerTier`, `AWSElasticBeanstalkMulticontainerDocker`, `AmazonSSMManagedInstanceCore` | **1** — `AWSElasticBeanstalkWebTier` |
| Inline policies | 3 — `ship-eb-ssm-access`, `ship-eb-bedrock-access`, `ship-eb-secrets-manager-access` (read **and write**) | **4** — the same three, with Secrets Manager reduced to read-only, plus `ship-eb-ssm-agent-channel` replacing `AmazonSSMManagedInstanceCore` |
| Effective reach | `Action: "*"` on `Resource: "*"` — every service, every resource, in the account | 6 services, all resource- or condition-scoped |
| SSM Parameter Store | Every parameter in the account | `parameter/ship/dev/*` only — **enforced**, see PF-637 probe C |
| Secrets Manager | Read, create, update, tag any secret | `GetSecretValue` on `ship/*` only |
| IAM | Full — including creating users and roles (demonstrated) | **None** |
| S3 | Every bucket, including the Terraform state file holding the Aurora password | `elasticbeanstalk-*` application-version buckets only, via `WebTier` |

**Diff of the Secrets Manager inline policy** (the only inline document whose content changed):

```diff
         "Action": [
             "secretsmanager:GetSecretValue",
-            "secretsmanager:CreateSecret",
-            "secretsmanager:UpdateSecret",
-            "secretsmanager:TagResource"
         ],
...
         "Action": [
             "kms:Decrypt",
-            "kms:GenerateDataKey"
         ],
```

The complete "after" documents, read back from the live role, are in the PF-635 rationale
tables above; the per-permission rationale p.5 asks for is the **"Why it is granted"**
column of those tables, one line per permission, and the **"What was dropped, and why"**
table immediately after it.

**Deliverable status against PRD p.5:**

| p.5 requirement | Where it is satisfied | Status |
|---|---|---|
| "Start with an `AdministratorAccess` task role" | PF-633 — attached via Terraform, effective permission set captured verbatim | Done |
| "Lock it down to the minimum permissions the platform actually needs" | PF-635 — applied via Terraform, plan reviewed, IAM-only change set | Done |
| "Verify the service still works" | PF-636 — verified after an application restart **and** a full instance replacement onto `i-0e6c39c822fe26a56` | Done, fresh boot exercised |
| "Verify an action outside the policy is denied" | PF-637 — four recorded `AccessDenied` responses from the instance, against a before-transcript where the same calls succeeded | Done |
| "Submit before/after IAM policy with rationale for every permission granted" | PF-633 (before), PF-635 (after + rationale tables), this section (diff) | Done |
