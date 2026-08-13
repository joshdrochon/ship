# Ship - Terraform Infrastructure

This directory contains all infrastructure as code for deploying Ship to AWS.

---

## Week 6 (PlugForge) — read this first

**Which root is applied.** `terraform/*.tf` — the flat root, the one you are standing
in. `terraform/environments/{dev,prod,shadow}` are **NOT APPLIED**; they are a second
configuration of the *same* resources under the *same* account-global IAM role names, so
applying both fails with `EntityAlreadyExists` rather than producing two environments.
They are alternatives, not layers. `terraform/render/` is the retained Render fallback
and is not destroyed. Full inventory with proof: **`docs/infra/topology.md`** (PF-616).

**State backend (PF-620).** S3, bucket `ship-terraform-state-<account-id>`, key
`ship/terraform.tfstate`, versioned + encrypted + public-access-blocked, created by
`terraform/bootstrap`.

```bash
terraform init -backend-config="bucket=$(aws ssm get-parameter \
  --name /ship/terraform-state-bucket --query Parameter.Value --output text)"
```

### The chicken-and-egg, written down

The backend block in `versions.tf` deliberately omits `bucket`. The bucket name embeds
the account id and is a compliance-sensitive value we do not commit, so it is read at
`init` time from the SSM parameter `/ship/terraform-state-bucket`.

That parameter is created by `terraform/bootstrap`. So:

1. **`terraform/bootstrap` cannot use the S3 backend** — the bucket it would store state
   in is the bucket it is being run to create. It declares no `backend` block at all, so
   it uses the **local backend** and its state is a `terraform.tfstate` file next to
   `bootstrap/main.tf`.
2. The bucket carries `lifecycle { prevent_destroy = true }`, which is the thing standing
   between a stray `terraform destroy` in `bootstrap/` and the state of every other root.

**Measured, not assumed — and the answer is worse than the design.** As of 2026-08-12
there is **no bootstrap state anywhere**:

```
$ ls -a terraform/bootstrap/
.  ..  main.tf          # no terraform.tfstate, no .terraform/
```

The bucket nevertheless exists and carries exactly the tags `bootstrap/main.tf` sets
(`Name=Terraform State`, `Project=ship`, `ManagedBy=Terraform`), so it *was* created from
this config — the state file simply did not survive, and `*.tfstate` is gitignored so it
was never going to.

Consequences, stated so nobody discovers them during an incident:

- **The state bucket is currently unmanaged.** No Terraform state tracks it. It is real
  infrastructure that no `plan` will ever mention.
- Re-running `terraform apply` in `bootstrap/` **will fail**, not converge —
  `BucketAlreadyOwnedByYou`. Recovery is `terraform import` of the four bootstrap
  resources (bucket, versioning, encryption, public-access-block) plus the SSM parameter,
  and only then an apply.
- **The graded root is unaffected.** Its state is in S3, it does not depend on the
  bootstrap, and `prevent_destroy` on the bucket still applies to anyone who does re-import
  it. This is a recoverability gap in the backend's own provenance, not a risk to the
  deployed environment.
- This is the one piece of infrastructure in the account that **is not** described by
  applied IaC, which is worth saying out loud in a lane whose claim is that the config is
  the source of truth. The claim holds for everything the graded root manages; it does not
  hold for the bucket that holds the graded root's state.

### State locking (PF-621)

`use_lockfile = true` is set on the backend block of **every** root that can `init` —
the graded root and all three under `environments/`.

Before this, there was **no locking of any kind**: no `dynamodb_table` in any backend
block, no `use_lockfile`, and no `aws_dynamodb_table` anywhere under `terraform/` (L99
finding F32). Two concurrent applies would both write state and the loser's resources
become untracked orphans.

`use_lockfile` is S3-native conditional-write locking — Terraform writes a `<key>.tflock`
object and relies on S3 compare-and-swap for atomicity. Chosen over a DynamoDB lock table
because it adds **zero** resources and because HashiCorp deprecated `dynamodb_table` in
Terraform 1.11; adopting it now would be adopting a documented dead end. Requires
Terraform >= 1.10.

Proof that it holds — two concurrent runs, the second refused with an S3 `412
PreconditionFailed` — is captured in **`docs/infra/state-lock-proof.txt`** and is
reproducible with:

```bash
scripts/prove-state-lock.sh
```

### Other Week 6 artifacts

| Artifact | Ticket | What it is |
|---|---|---|
| `docs/infra/topology.md` | PF-616, PF-617, PF-646 | Inventory, the D6 ADR, IAM role-name mapping |
| `docs/infra/aws-account.md` | PF-618, PF-619 | Operator identity, MFA state, budget tripwire |
| `docs/infra/pin-audit.txt` | PF-622 | Provider-pin audit output |
| `docs/infra/plan-baseline-w6.txt` | PF-623 | `terraform plan` against real credentials |
| `terraform/PLAN-ANNOTATED.md` | PF-626 | The annotated plan (p.2 submission artifact) |
| `docs/infra/iam-least-privilege.md` | PF-633–638 | Before/after policy, rationale, `AccessDenied` transcript |
| `docs/infra/drift-demo.md` | PF-639 | Planted drift → detected → reconciled |
| `docs/infra/plan-reading.md` | PF-643 | Plan-reading primer + blast-radius crib |

**A PreToolUse hook blocks `terraform destroy`, `scripts/destroy-redeploy.sh` and
`terraform workspace select prod`.** That is deliberate. Destroying the graded
environment deletes the Aurora cluster and releases the environment CNAME that every
published grader link points at. See `.claude/hooks/guard-graded-branches.py`.

---

## Directory Structure

```
terraform/
├── *.tf                    # Root config (legacy flat structure, prod-only)
├── environments/
│   ├── dev/                # Dev environment - uses shared VPC
│   └── prod/               # Prod environment - creates dedicated VPC
├── modules/                # Reusable Terraform modules
│   ├── vpc/
│   ├── aurora/
│   ├── elastic-beanstalk/
│   ├── cloudfront-s3/
│   ├── security-groups/
│   └── ssm/
└── bootstrap/              # One-time setup (S3 state bucket)
```

## Multi-Environment Architecture

### Why Separate Directories Instead of .tfvars?

We use separate `environments/dev/` and `environments/prod/` directories instead of a single configuration with different `.tfvars` files because **the infrastructure code paths differ**, not just the values.

| Aspect | Dev | Prod |
|--------|-----|------|
| **VPC** | Reads from SSM (shared VPC) | Creates its own VPC |
| **State** | `environments/dev/.terraform/` | `environments/prod/.terraform/` |
| **Dependencies** | Depends on treasury-shared-infra | Self-contained |

**Dev environment** reads VPC configuration from SSM parameters set by `treasury-shared-infra`:
```hcl
# environments/dev/main.tf
data "aws_ssm_parameter" "vpc_id" {
  name = "/infra/dev/vpc_id"
}
```

**Prod environment** creates its own isolated VPC:
```hcl
# environments/prod/main.tf
module "vpc" {
  source = "../../modules/vpc"
  ...
}
```

This isn't a "same code, different values" situation—it's fundamentally different infrastructure patterns. Using `.tfvars` alone would require complex conditional logic that's harder to understand and maintain.

### When to Use Each Approach

| Scenario | Use .tfvars | Use Separate Directories |
|----------|-------------|--------------------------|
| Same code, different instance sizes | ✓ | |
| Same code, different domains | ✓ | |
| Different VPC strategies | | ✓ |
| Different provider configurations | | ✓ |
| Shared vs dedicated infrastructure | | ✓ |

### Trade-offs

**Separate directories (our choice):**
- ✓ Clear separation of concerns
- ✓ Each env can evolve independently
- ✓ Easier to understand what each env does
- ✓ Separate state files (no accidental cross-env changes)
- ✗ Some code duplication in variables.tf, versions.tf, outputs.tf

**Single config with .tfvars:**
- ✓ DRY - no code duplication
- ✓ Guaranteed consistency
- ✗ Complex conditionals for structural differences
- ✗ Shared state risk (unless using workspaces)
- ✗ Changes affect all environments at once

### Shared VPC Rationale (Dev)

Dev uses a shared VPC from `treasury-shared-infra` because:
1. **Cost savings** - Single NAT Gateway (~$33/mo) shared across dev services
2. **Network consistency** - All dev services can communicate within same VPC
3. **Simpler peering** - One VPC to connect to on-prem resources

Prod creates its own VPC because:
1. **Isolation** - Production shouldn't share network with dev services
2. **Independent scaling** - Prod VPC can be sized for production traffic
3. **Blast radius** - Issues in shared infrastructure don't affect prod

## Quick Start

### Using Environment Directories (Recommended)

```bash
# 1. Verify AWS credentials
aws sts get-caller-identity

# 2. Navigate to environment
cd terraform/environments/dev   # or prod

# 3. Sync config from SSM (creates terraform.tfvars)
../../scripts/sync-terraform-config.sh dev

# 4. Initialize Terraform
terraform init

# 5. Plan and apply
terraform plan -out=tfplan
terraform apply tfplan
```

### Using Root Directory (Legacy - Prod Only)

```bash
# 1. Verify AWS credentials (must have access to the team's AWS account)
aws sts get-caller-identity

# 2. Configure variables
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values

# 3. Initialize Terraform (bucket name is fetched from SSM)
terraform init -backend-config="bucket=$(aws ssm get-parameter --name /ship/terraform-state-bucket --query Parameter.Value --output text)"

# 4. Plan changes
terraform plan -out=tfplan

# 5. Apply changes
terraform apply tfplan
```

> **Note:** The root-level `*.tf` files are the original flat structure. New environments should use the `environments/` directories which leverage shared modules.

## Infrastructure Components

| File | Purpose |
|------|---------|
| `versions.tf` | Provider configuration and versions |
| `variables.tf` | Input variables and defaults |
| `vpc.tf` | VPC, subnets, NAT, Internet Gateway, Flow Logs |
| `security-groups.tf` | Network security for ALB, EB, Aurora |
| `database.tf` | Aurora Serverless v2 PostgreSQL cluster |
| `ssm.tf` | SSM Parameter Store for secrets |
| `elastic-beanstalk.tf` | EB application, IAM roles |
| `s3-cloudfront.tf` | Frontend hosting (S3 + CloudFront) |
| `outputs.tf` | Output values for EB CLI and scripts |

## Resource Architecture

```
VPC (10.0.0.0/16)
├── Public Subnets (10.0.0.0/24, 10.0.1.0/24)
│   ├── Internet Gateway
│   ├── NAT Gateway
│   └── Application Load Balancer
│
└── Private Subnets (10.0.10.0/24, 10.0.11.0/24)
    ├── Elastic Beanstalk Instances
    └── Aurora Serverless v2 Cluster
```

## Configuration

### Required Variables

```hcl
aws_region   = "us-east-1"
project_name = "ship"
environment  = "dev"
```

### Optional Variables

```hcl
# Custom domains (requires Route53 zone)
route53_zone_id  = "Z1234567890ABC"
api_domain_name  = "api.example.gov"
app_domain_name  = "app.example.gov"

# Database scaling
aurora_min_capacity = 0.5  # ACUs
aurora_max_capacity = 4    # ACUs

# VPC configuration
vpc_cidr           = "10.0.0.0/16"
enable_nat_gateway = true  # Required for EB Docker pulls
```

## Important Outputs

After `terraform apply`, note these outputs:

| Output | Used For |
|--------|----------|
| `eb_application_name` | EB CLI initialization |
| `eb_instance_profile` | EB environment creation |
| `eb_service_role` | EB environment creation |
| `eb_vpc_id` | EB environment creation |
| `eb_private_subnets` | EB environment creation |
| `eb_public_subnets` | EB environment creation |
| `database_url_ssm_parameter` | Application configuration |
| `s3_bucket_name` | Frontend deployment |
| `cloudfront_distribution_id` | Frontend deployment |

## State Management

**IMPORTANT:** Terraform state is stored in S3 to prevent data loss. The state file tracks what resources Terraform manages - without it, Terraform cannot destroy or update resources.

### S3 Backend (Current Setup)

State is stored in a private S3 bucket with:
- Versioning enabled (can recover from mistakes)
- Encryption at rest (AES256)
- Public access blocked

The bucket name is **not committed to git** (compliance requirement - avoids exposing AWS account ID). Instead, it's stored in SSM Parameter Store at `/ship/terraform-state-bucket`.

This means:
- State survives git worktree deletion
- State is shared across all machines/worktrees
- No secrets or account identifiers in git
- Team members discover the bucket via SSM

### Initializing Terraform

```bash
# Fetch bucket name from SSM and initialize
terraform init -backend-config="bucket=$(aws ssm get-parameter --name /ship/terraform-state-bucket --query Parameter.Value --output text)"
```

Or create a local `.tfbackend` file (gitignored):

```bash
# Query once and save locally
echo "bucket = \"$(aws ssm get-parameter --name /ship/terraform-state-bucket --query Parameter.Value --output text)\"" > .tfbackend

# Then init is simpler
terraform init -backend-config=.tfbackend
```

### Bootstrap Directory

The `bootstrap/` directory contains Terraform that creates:
1. The S3 bucket for state storage
2. An SSM parameter with the bucket name (for team discovery)

This solves the chicken-and-egg problem (need bucket before you can use it as backend).

**If setting up from scratch (new AWS account):**

```bash
# 1. Create the S3 bucket and SSM parameter (one-time, by team lead)
cd terraform/bootstrap
terraform init
terraform apply

# 2. Initialize main terraform (uses SSM to find bucket)
cd ..
terraform init -backend-config="bucket=$(aws ssm get-parameter --name /ship/terraform-state-bucket --query Parameter.Value --output text)"
```

### Why This Matters

If you deploy from a git worktree and then delete that worktree, you lose the local state file. Without state, Terraform doesn't know what resources it created, and you cannot:
- Run `terraform destroy`
- Update existing resources
- See what's deployed

With S3 backend, state persists regardless of which machine or worktree you use.

### Recovering from Lost State

If state is lost and resources exist in AWS, you have two options:

1. **Import then destroy** - Import each resource into Terraform state, then destroy
2. **Manual cleanup via AWS CLI** - Delete resources directly

For manual cleanup, delete in this order (dependencies matter):
1. Elastic Beanstalk environment
2. RDS cluster and instances
3. CloudFront distribution
4. S3 buckets (empty first)
5. NAT Gateway
6. Security groups
7. Subnets
8. Internet Gateway
9. VPC
10. IAM roles/policies

## Cost Estimation

Use `terraform plan` with cost estimation tools:

```bash
# Using Infracost (https://www.infracost.io/)
infracost breakdown --path .

# Estimated monthly costs (dev environment):
# - Aurora Serverless v2 (0.5 ACU min): $43
# - Elastic Beanstalk (t3.small): $15
# - Application Load Balancer: $20
# - NAT Gateway: $33
# - S3 + CloudFront: $2
# Total: ~$113/month
```

## Maintenance

### Update Terraform

```bash
# Update providers
terraform init -upgrade

# Review changes
terraform plan

# Apply updates
terraform apply
```

### Update Aurora Version

1. Check available versions:
   ```bash
   aws rds describe-db-engine-versions \
     --engine aurora-postgresql \
     --query "DBEngineVersions[].EngineVersion"
   ```

2. Update `database.tf`:
   ```hcl
   engine_version = "16.2"  # New version
   ```

3. Apply changes:
   ```bash
   terraform apply
   ```

Aurora will perform a rolling upgrade during the maintenance window.

## Troubleshooting

### Terraform Init Fails

- Check AWS credentials: `aws sts get-caller-identity`
- Ensure Terraform version >= 1.6.0: `terraform version`

### Terraform Plan Shows Drift

Resources modified outside Terraform will show as changes. Common causes:
- EB auto-scaling changes
- RDS automated backups
- Security group rules added manually

To import resources:
```bash
terraform import aws_security_group_rule.example sg-12345678:ingress:tcp:22:22:0.0.0.0/0
```

### Aurora Creation Timeout

Aurora can take 10-15 minutes to create. If timeout occurs:
- Check RDS console for cluster status
- If cluster is "creating", wait and run `terraform apply` again
- Terraform will pick up the existing cluster

### NAT Gateway Expensive

NAT Gateway costs ~$33/month. For dev environments, you can:
1. Set `enable_nat_gateway = false`
2. Use VPC endpoints for AWS services (ECR, S3, SSM)

However, EB instances need internet access to pull Docker images from ECR Public.

## Security

### Compliance Features

- **Encryption:** Aurora (storage), S3 (AES256), TLS 1.2+ in transit
- **Audit:** VPC Flow Logs, CloudWatch Logs, CloudTrail integration
- **Network:** Private subnets for compute/database, no public IPs
- **IAM:** Least privilege roles, no hardcoded credentials
- **Secrets:** SSM Parameter Store (SecureString with KMS)

### Security Group Rules

All security groups follow least privilege:
- Aurora: Ingress only from EB instances on port 5432, no egress
- EB instances: Ingress from ALB on port 80, egress to internet (for updates)
- ALB: Ingress from internet on 80/443, egress to EB instances

### Secrets Management

Never commit secrets to git. Use SSM Parameter Store:

```bash
# Store secret
aws ssm put-parameter \
  --name "/ship/dev/API_KEY" \
  --type "SecureString" \
  --value "secret-value"

# Retrieve in application
import { SSM } from '@aws-sdk/client-ssm';
const ssm = new SSM();
const param = await ssm.getParameter({ Name: '/ship/dev/API_KEY', WithDecryption: true });
```

### SSM Parameter Inventory

All environment configuration lives in SSM. A new developer only needs AWS credentials - everything else is pulled from SSM automatically by `scripts/deploy.sh`.

**Terraform Config** (pulled by `sync-terraform-config.sh`):
```
/ship/terraform-config/{env}/environment          # "dev" or "prod"
/ship/terraform-config/{env}/app_domain_name      # Custom domain (optional)
/ship/terraform-config/{env}/route53_zone_id      # Route53 zone (optional)
/ship/terraform-config/{env}/eb_environment_cname # EB CNAME (optional)
```

**App Runtime** (loaded by `api/src/config/ssm.ts` in production):
```
/ship/{env}/DATABASE_URL     # PostgreSQL connection string (SecureString)
/ship/{env}/SESSION_SECRET   # Express session secret (SecureString)
/ship/{env}/CORS_ORIGIN      # Allowed CORS origin
/ship/{env}/CDN_DOMAIN       # CloudFront domain for assets
/ship/{env}/APP_BASE_URL     # Frontend app URL
```

**OAuth Credentials** (Secrets Manager, configured via `scripts/configure-caia.sh`):
```
/ship/{env}/caia-credentials  # JSON: issuer_url, client_id, client_secret
```

### Bootstrapping a New Environment

To set up a new environment from scratch:

```bash
# 1. Create terraform config parameters
ENV=dev
aws ssm put-parameter --name /ship/terraform-config/$ENV/environment --value $ENV --type String

# 2. Create app runtime parameters
aws ssm put-parameter --name /ship/$ENV/SESSION_SECRET --value "$(openssl rand -hex 32)" --type SecureString
aws ssm put-parameter --name /ship/$ENV/CORS_ORIGIN --value "https://app.$ENV.example.gov" --type String
aws ssm put-parameter --name /ship/$ENV/CDN_DOMAIN --value "cdn.$ENV.example.gov" --type String
aws ssm put-parameter --name /ship/$ENV/APP_BASE_URL --value "https://app.$ENV.example.gov" --type String
# DATABASE_URL is created by Terraform and populated after Aurora is deployed

# 3. Deploy infrastructure
cd terraform/environments/$ENV
terraform init
terraform apply

# 4. Configure CAIA OAuth (get credentials from CAIA Shield first)
./scripts/configure-caia.sh $ENV

# 5. Deploy application
./scripts/deploy.sh $ENV
```

## Disaster Recovery

### Backup Strategy

- **Aurora:** Automated daily backups (7-day retention)
- **Terraform state:** Version controlled in S3 (if using S3 backend)

### Recovery Procedure

1. **Restore Aurora:**
   ```bash
   aws rds restore-db-cluster-to-point-in-time \
     --source-db-cluster-identifier ship-aurora \
     --target-db-cluster-identifier ship-aurora-restored \
     --restore-to-time 2024-01-01T00:00:00Z
   ```

2. **Update Terraform to use new cluster:**
   ```hcl
   # Import restored cluster
   terraform import aws_rds_cluster.aurora ship-aurora-restored
   ```

3. **Update SSM parameters with new endpoint:**
   ```bash
   aws ssm put-parameter \
     --name "/ship/dev/DATABASE_URL" \
     --type "SecureString" \
     --value "postgresql://user:pass@new-endpoint:5432/ship_main" \
     --overwrite
   ```

## Cleanup

To destroy all resources:

```bash
# 1. Delete EB environment first (not managed by Terraform)
cd ../api
eb terminate ship-api-dev

# 2. Destroy Terraform resources
cd ../terraform
terraform destroy
```

**Warning:** This is irreversible. Ensure you have backups.

For production, consider:
- Taking a final Aurora snapshot
- Backing up S3 bucket contents
- Exporting CloudWatch logs
