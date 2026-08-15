# SSM Parameter Store - Database Connection String
resource "aws_ssm_parameter" "database_url" {
  name        = "/${var.project_name}/${var.environment}/DATABASE_URL"
  description = "PostgreSQL connection string for Ship application"
  type        = "SecureString"
  value = format(
    "postgresql://%s:%s@%s:%s/%s",
    aws_rds_cluster.aurora.master_username,
    random_password.db_password.result,
    aws_rds_cluster.aurora.endpoint,
    aws_rds_cluster.aurora.port,
    aws_rds_cluster.aurora.database_name
  )

  tags = {
    Name = "${var.project_name}-database-url"
  }
}

# SSM Parameter - Database Host (separate for easier access)
resource "aws_ssm_parameter" "db_host" {
  name        = "/${var.project_name}/${var.environment}/DB_HOST"
  description = "Aurora cluster endpoint"
  type        = "String"
  value       = aws_rds_cluster.aurora.endpoint

  tags = {
    Name = "${var.project_name}-db-host"
  }
}

# SSM Parameter - Database Name
resource "aws_ssm_parameter" "db_name" {
  name        = "/${var.project_name}/${var.environment}/DB_NAME"
  description = "Database name"
  type        = "String"
  value       = aws_rds_cluster.aurora.database_name

  tags = {
    Name = "${var.project_name}-db-name"
  }
}

# SSM Parameter - Database Username
resource "aws_ssm_parameter" "db_username" {
  name        = "/${var.project_name}/${var.environment}/DB_USERNAME"
  description = "Database username"
  type        = "String"
  value       = aws_rds_cluster.aurora.master_username

  tags = {
    Name = "${var.project_name}-db-username"
  }
}

# SSM Parameter - Database Password
resource "aws_ssm_parameter" "db_password" {
  name        = "/${var.project_name}/${var.environment}/DB_PASSWORD"
  description = "Database password"
  type        = "SecureString"
  value       = random_password.db_password.result

  tags = {
    Name = "${var.project_name}-db-password"
  }
}

# SSM Parameter - CORS Origin (for frontend URL)
resource "aws_ssm_parameter" "cors_origin" {
  name        = "/${var.project_name}/${var.environment}/CORS_ORIGIN"
  description = "CORS origin for API (frontend URL)"
  type        = "String"
  value       = var.app_domain_name != "" ? "https://${var.app_domain_name}" : "https://${aws_cloudfront_distribution.frontend.domain_name}"

  tags = {
    Name = "${var.project_name}-cors-origin"
  }
}

# SSM Parameter - CDN Domain (for file upload URLs)
resource "aws_ssm_parameter" "cdn_domain" {
  name        = "/${var.project_name}/${var.environment}/CDN_DOMAIN"
  description = "CDN domain for serving uploaded files"
  type        = "String"
  value       = var.app_domain_name != "" ? var.app_domain_name : aws_cloudfront_distribution.frontend.domain_name

  tags = {
    Name = "${var.project_name}-cdn-domain"
  }
}

# SSM Parameter - App Base URL (for OAuth redirect URIs)
resource "aws_ssm_parameter" "app_base_url" {
  name        = "/${var.project_name}/${var.environment}/APP_BASE_URL"
  description = "Base URL for the application (used in OAuth callbacks)"
  type        = "String"
  value       = var.app_domain_name != "" ? "https://${var.app_domain_name}" : "https://${aws_cloudfront_distribution.frontend.domain_name}"

  tags = {
    Name = "${var.project_name}-app-base-url"
  }
}

# Generate random session secret
resource "random_password" "session_secret" {
  length  = 64
  special = false
}

# SSM Parameter - Session Secret (for express-session)
resource "aws_ssm_parameter" "session_secret" {
  name        = "/${var.project_name}/${var.environment}/SESSION_SECRET"
  description = "Session secret for express-session cookie signing"
  type        = "SecureString"
  value       = random_password.session_secret.result

  tags = {
    Name = "${var.project_name}-session-secret"
  }
}

# ---------------------------------------------------------------------------
# PF-625 / L99 F91 — WEBHOOK_SECRET_KEY, the AES-256-GCM key that encrypts every
# webhook subscription's signing secret at rest (L15 PF-422).
#
# This is provisioned NOWHERE before this block. The only two places that ever
# set it are local drill harnesses (scripts/ttfe/harness.ts,
# scripts/l24-drill-server.ts), so the deployed environment has never had it.
#
# WHY THAT IS INVISIBLE UNTIL IT IS NOT. `api/src/deps.ts` builds the
# subscription repository with `envSecretCipher()`, which resolves the key
# LAZILY and deliberately -- eager resolution would turn a missing key into a
# boot failure for the whole application. So the container starts, /health goes
# green, `GET /api/v1/webhooks` works, and the FIRST `POST /api/v1/webhooks`
# throws `WebhookSecretCryptoError` out of `platform/webhooks/secretCipher.ts`.
# Fail-closed is correct -- the alternative is a body delivered unsigned. The
# defect is only that nothing supplied the key. PRD p.12's demo script ends with
# `ship webhooks tail` showing a VERIFIED signed delivery, and p.13's social post
# wants a screenshot of it, so this is the difference between the demo working
# and the demo 500ing on its own last line.
#
# WHY random_bytes AND NOT random_password. `secretCipher.ts` accepts base64 or
# hex and requires the decode to be EXACTLY 32 bytes. `random_password` produces
# CHARACTERS, not bytes: the `length = 64, special = false` shape used for
# session_secret above is 64 base62 characters, which is not valid hex (it
# contains g-z) and base64-decodes to 48 bytes, so the key would be rejected at
# first use with the same error this block exists to prevent. `random_bytes`
# generates 32 actual bytes and exposes `.base64`, which is the shape the
# application parses. hashicorp/random 3.7.2 is pinned in versions.tf and has it.
#
# WHY SSM AND NOT AN EB ENVIRONMENT VARIABLE. Same reasoning platform-apps.tf
# sets out for the three client secrets: an EB option setting stores the value
# in the environment's configuration in clear text, readable by anyone with
# `elasticbeanstalk:DescribeConfigurationSettings`. The application already
# reads its secrets from SSM at boot, and the instance role's inline policy
# above is already scoped to `parameter/${project}/${environment}/*`, so this
# needs NO IAM change.
#
# NO `terraform output` FOR THIS ONE, unlike grader_client_secret. That one is
# published in the README because a grader has to type it (p.13). This key is
# never presented to anybody; the only consumer is the API process, via SSM.
# Not emitting an output is the smaller blast radius.
#
# ROTATION IS DESTRUCTIVE AND IS NOT A MAINTENANCE CHORE. Replacing this key
# makes every already-stored `secret_ciphertext` undecryptable, and deliveries
# for those subscriptions then fail closed (pipeline.ts logs exactly that).
# `random_bytes` is stable across applies with no `keepers`, so a routine
# `terraform apply` will not move it. A deliberate rotation means re-issuing
# every subscriber's signing secret, which is a subscriber-visible event, not a
# `-replace`.
# ---------------------------------------------------------------------------
resource "random_bytes" "webhook_secret_key" {
  length = 32 # AES-256. `WEBHOOK_SECRET_KEY_BYTES` in secretCipher.ts.
}

resource "aws_ssm_parameter" "webhook_secret_key" {
  name        = "/${var.project_name}/${var.environment}/WEBHOOK_SECRET_KEY"
  description = "AES-256-GCM key encrypting webhook signing secrets at rest (L15 PF-422). Read at boot by api/src/config/ssm.ts. Rotating it orphans every stored subscription secret."
  type        = "SecureString"
  value       = random_bytes.webhook_secret_key.base64

  tags = {
    Name = "${var.project_name}-webhook-secret-key"
  }
}

# IAM Role for EB instances to read SSM parameters
resource "aws_iam_role_policy" "eb_ssm_access" {
  name = "${var.project_name}-eb-ssm-access"
  role = aws_iam_role.eb_instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:GetParametersByPath"
        ]
        Resource = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "kms:Decrypt"
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:ViaService" = "ssm.${var.aws_region}.amazonaws.com"
          }
        }
      }
    ]
  })
}

data "aws_caller_identity" "current" {}

# IAM Role for EB instances to invoke Bedrock models (AI quality analysis)
resource "aws_iam_role_policy" "eb_bedrock_access" {
  name = "${var.project_name}-eb-bedrock-access"
  role = aws_iam_role.eb_instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel"
        ]
        Resource = [
          "arn:aws:bedrock:*::foundation-model/anthropic.*",
          "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/anthropic.*",
          "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/global.anthropic.*"
        ]
      }
    ]
  })
}

# IAM Role for EB instances to access Secrets Manager (FPKI OAuth credentials)
resource "aws_iam_role_policy" "eb_secrets_manager_access" {
  name = "${var.project_name}-eb-secrets-manager-access"
  role = aws_iam_role.eb_instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:CreateSecret",
          "secretsmanager:UpdateSecret",
          "secretsmanager:TagResource"
        ]
        Resource = [
          "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:${var.project_name}/*",
          "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:/${var.project_name}/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey"
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:ViaService" = "secretsmanager.${var.aws_region}.amazonaws.com"
          }
        }
      }
    ]
  })
}
