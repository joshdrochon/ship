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

## PF-635 — the applied "after" policy

Applied via Terraform. See `terraform/iam-least-privilege.tf` and `terraform/ssm.tf`.

## PF-636 — the service still works under the reduced policy

## PF-637 — an action outside the policy is denied

## PF-638 — before/after with rationale

*Sections PF-635 through PF-638 are completed in the S4 slice
(`pf/L21-least-privilege`). The enumeration above (PF-634) and the role mapping (PF-646)
are complete; the apply, the instance-replacement verification and the recorded
`AccessDenied` transcript are what remain. **Status is tracked honestly here rather than
implied: if this note is still present, those three tickets are NOT done.***

