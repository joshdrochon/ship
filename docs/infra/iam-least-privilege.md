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
