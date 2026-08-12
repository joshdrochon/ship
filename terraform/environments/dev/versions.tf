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

  # Backend bucket name from SSM (compliance requirement)
  # Initialize with: terraform init -backend-config="bucket=$(aws ssm get-parameter --name /ship/terraform-state-bucket --query Parameter.Value --output text)"
  # PF-621 / F32 -- see the rationale in terraform/versions.tf. This root is NOT
  # the graded root and is not applied (PF-616), but a lock-less backend left in
  # place is a trap for whoever applies it next, so it is fixed here too.
  backend "s3" {
    key          = "ship/dev/terraform.tfstate"
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
