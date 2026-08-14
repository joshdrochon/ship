terraform {
  required_version = ">= 1.6.0"

  # Provider versions are pinned exactly, not range-constrained. Audit finding
  # W8-4: `~> 5.0` / `~> 3.6` let two roots resolve different provider versions
  # from identical configuration in the same session (dev and shadow picked
  # random 3.9.0, prod picked 3.7.2). aws 5.100.0 is the newest 5.x, so this is
  # what `~> 5.0` already resolves to today; random 3.7.2 is what
  # environments/prod's committed lock file records. Neither pin changes which
  # provider is selected right now -- it stops the selection moving under an
  # operator who runs `init` mid-incident.
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "5.100.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "3.7.2"
    }
  }

  # Backend bucket name is not committed to git (compliance requirement)
  # Initialize with: terraform init -backend-config="bucket=$(aws ssm get-parameter --name /ship/terraform-state-bucket --query Parameter.Value --output text)"
  # PF-621 / L99 finding F32. Measured starting position: this block declared
  # `key`, `region` and `encrypt` and nothing else -- no `dynamodb_table`, no
  # `use_lockfile` -- and there was no `aws_dynamodb_table` anywhere under
  # terraform/. There was no locking of any kind, in the one lane whose whole
  # claim is that the IaC is the source of truth. Two concurrent applies would
  # both write state and the loser's resources become orphans.
  #
  # `use_lockfile = true` is S3-native conditional-write locking: Terraform puts
  # a `<key>.tflock` object beside the state and relies on S3's compare-and-swap
  # to make acquisition atomic. Chosen over a DynamoDB lock table because it
  # adds ZERO resources (no table to create, pay for, or forget to create in a
  # second account), and because HashiCorp deprecated `dynamodb_table` in
  # Terraform 1.11 -- adding it now would be adopting a documented dead end.
  # Requires Terraform >= 1.10; `required_version` above is >= 1.6.0 and the
  # pinned toolchain in .terraform-version is what actually holds the floor.
  backend "s3" {
    key          = "ship/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "Terraform"
      Repository  = "ship"
    }
  }
}
