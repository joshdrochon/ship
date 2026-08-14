# Elastic Beanstalk Application
resource "aws_elastic_beanstalk_application" "api" {
  name        = "${var.project_name}-api"
  description = "Ship API - Express + WebSocket collaboration server"

  tags = {
    Name = "${var.project_name}-api"
  }
}

# EB Instance IAM Role
resource "aws_iam_role" "eb_instance" {
  name = "${var.project_name}-eb-instance-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = {
    Name = "${var.project_name}-eb-instance-role"
  }
}

# Attach AWS managed policies
resource "aws_iam_role_policy_attachment" "eb_web_tier" {
  role       = aws_iam_role.eb_instance.name
  policy_arn = "arn:aws:iam::aws:policy/AWSElasticBeanstalkWebTier"
}

resource "aws_iam_role_policy_attachment" "eb_worker_tier" {
  role       = aws_iam_role.eb_instance.name
  policy_arn = "arn:aws:iam::aws:policy/AWSElasticBeanstalkWorkerTier"
}

resource "aws_iam_role_policy_attachment" "eb_multicontainer_docker" {
  role       = aws_iam_role.eb_instance.name
  policy_arn = "arn:aws:iam::aws:policy/AWSElasticBeanstalkMulticontainerDocker"
}

# Instance Profile
resource "aws_iam_instance_profile" "eb" {
  name = "${var.project_name}-eb-instance-profile"
  role = aws_iam_role.eb_instance.name

  tags = {
    Name = "${var.project_name}-eb-instance-profile"
  }
}

# EB Service Role
resource "aws_iam_role" "eb_service" {
  name = "${var.project_name}-eb-service-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "elasticbeanstalk.amazonaws.com"
        }
        Action = "sts:AssumeRole"
        Condition = {
          StringEquals = {
            "sts:ExternalId" = "elasticbeanstalk"
          }
        }
      }
    ]
  })

  tags = {
    Name = "${var.project_name}-eb-service-role"
  }
}

resource "aws_iam_role_policy_attachment" "eb_service_policy" {
  role       = aws_iam_role.eb_service.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSElasticBeanstalkEnhancedHealth"
}

resource "aws_iam_role_policy_attachment" "eb_service_managed" {
  role       = aws_iam_role.eb_service.name
  policy_arn = "arn:aws:iam::aws:policy/AWSElasticBeanstalkManagedUpdatesCustomerRolePolicy"
}

# Elastic Beanstalk Environment
resource "aws_elastic_beanstalk_environment" "api" {
  name                = "${var.project_name}-api-prod"
  application         = aws_elastic_beanstalk_application.api.name
  # AWS retires EB solution stacks unilaterally. v4.9.0 was pinned from an earlier
  # week and no longer exists in any account — CreateEnvironment fails with
  # InvalidParameterValue, not a deprecation warning. Verified 2026-08-12:
  # `aws elasticbeanstalk list-available-solution-stacks` returns exactly one
  # Docker stack, the one below. This is the one "pinned version" in the config
  # whose validity is not ours to control; re-check it before any destroy-redeploy.
  solution_stack_name = "64bit Amazon Linux 2023 v4.13.6 running Docker"

  # VPC Configuration
  setting {
    namespace = "aws:ec2:vpc"
    name      = "VPCId"
    value     = aws_vpc.main.id
  }

  setting {
    namespace = "aws:ec2:vpc"
    name      = "Subnets"
    value     = join(",", aws_subnet.private[*].id)
  }

  setting {
    namespace = "aws:ec2:vpc"
    name      = "ELBSubnets"
    value     = join(",", aws_subnet.public[*].id)
  }

  setting {
    namespace = "aws:ec2:vpc"
    name      = "ELBScheme"
    value     = "public"
  }

  setting {
    namespace = "aws:ec2:vpc"
    name      = "AssociatePublicIpAddress"
    value     = "false"
  }

  # Instance Configuration
  setting {
    namespace = "aws:autoscaling:launchconfiguration"
    name      = "IamInstanceProfile"
    value     = aws_iam_instance_profile.eb.name
  }

  setting {
    namespace = "aws:autoscaling:launchconfiguration"
    name      = "InstanceType"
    value     = "t3.small"
  }

  setting {
    namespace = "aws:autoscaling:launchconfiguration"
    name      = "SecurityGroups"
    value     = aws_security_group.eb_instance.id
  }

  setting {
    namespace = "aws:autoscaling:launchconfiguration"
    name      = "DisableIMDSv1"
    value     = "true"
  }

  # Auto Scaling
  setting {
    namespace = "aws:autoscaling:asg"
    name      = "MinSize"
    value     = "1"
  }

  setting {
    namespace = "aws:autoscaling:asg"
    name      = "MaxSize"
    value     = "4"
  }

  # Load Balancer
  setting {
    namespace = "aws:elasticbeanstalk:environment"
    name      = "EnvironmentType"
    value     = "LoadBalanced"
  }

  setting {
    namespace = "aws:elasticbeanstalk:environment"
    name      = "LoadBalancerType"
    value     = "application"
  }

  setting {
    namespace = "aws:elasticbeanstalk:environment"
    name      = "ServiceRole"
    value     = aws_iam_role.eb_service.arn
  }

  setting {
    namespace = "aws:elbv2:loadbalancer"
    name      = "SecurityGroups"
    value     = aws_security_group.alb.id
  }

  # Rolling Deployment with Additional Batch (zero-downtime)
  setting {
    namespace = "aws:elasticbeanstalk:command"
    name      = "DeploymentPolicy"
    value     = "RollingWithAdditionalBatch"
  }

  setting {
    namespace = "aws:elasticbeanstalk:command"
    name      = "BatchSizeType"
    value     = "Fixed"
  }

  setting {
    namespace = "aws:elasticbeanstalk:command"
    name      = "BatchSize"
    value     = "1"
  }

  # PF-628. Raised from 600s.
  #
  # This platform builds the Dockerfile ON THE INSTANCE from the source bundle,
  # and this Dockerfile is a two-stage monorepo build: pnpm install for four
  # workspace packages, then tsc for shared + agent + api, then a Vite build of
  # the web frontend. On the t3.small this environment runs, that does not fit
  # in ten minutes, and the failure mode is not a clear error -- the deploy is
  # torn down mid-build and the environment reports a generic command timeout
  # while the previous version keeps serving. That reads exactly like "the app
  # is broken" and sends you looking in the wrong place.
  #
  # 30 minutes is chosen against the measured shape of the build rather than as
  # a round number: it leaves room for a cold Docker layer cache (the expensive
  # case, and the one that applies to a fresh instance) without letting a
  # genuinely wedged deploy hold the environment for an hour.
  setting {
    namespace = "aws:elasticbeanstalk:command"
    name      = "Timeout"
    value     = "1800"
  }

  # Environment Variables
  setting {
    namespace = "aws:elasticbeanstalk:application:environment"
    name      = "NODE_ENV"
    value     = "production"
  }

  # PF-625/PF-628 — was the hardcoded string "prod", and that was a boot-killer.
  #
  # `api/src/config/ssm.ts` builds its parameter path as `/ship/${ENVIRONMENT}`
  # and every parameter in ssm.tf is named `/${var.project_name}/${var.environment}/*`.
  # `var.environment` defaults to "dev", so the parameters that exist are
  # `/ship/dev/*` while the container was being told to look in `/ship/prod/*`.
  #
  # Nothing warns about this. The container would have started, called
  # GetParameter on /ship/prod/DATABASE_URL, and died in `migrate.js` before the
  # server ever listened -- and because loadProductionSecrets() runs in all three
  # entrypoints, it dies in the first one. Worse, the instance role's inline
  # ssm policy is scoped to `parameter/ship/dev/*`, so the real error would have
  # been AccessDenied rather than ParameterNotFound, sending you to debug IAM for
  # what is a string mismatch.
  #
  # Deriving it from the same variable that names the parameters makes the two
  # incapable of disagreeing. It is also why this value currently reads "dev"
  # while the environment is named ship-api-prod -- that mismatch is cosmetic and
  # documented in docs/infra/topology.md; changing var.environment to "prod"
  # would rename every SSM parameter and the S3 buckets, which is a replacement,
  # not a rename.
  setting {
    namespace = "aws:elasticbeanstalk:application:environment"
    name      = "ENVIRONMENT"
    value     = var.environment
  }

  setting {
    namespace = "aws:elasticbeanstalk:application:environment"
    name      = "PORT"
    value     = "80"
  }

  setting {
    namespace = "aws:elasticbeanstalk:application:environment"
    name      = "AWS_REGION"
    value     = var.aws_region
  }

  # Health Check Path
  setting {
    namespace = "aws:elasticbeanstalk:environment:process:default"
    name      = "HealthCheckPath"
    value     = "/health"
  }

  # Health Reporting
  setting {
    namespace = "aws:elasticbeanstalk:healthreporting:system"
    name      = "SystemType"
    value     = "enhanced"
  }

  # Ignore version_label changes (managed by deploy script)
  lifecycle {
    ignore_changes = [
      version_label,
    ]
  }

  tags = {
    Name = "${var.project_name}-api-prod"
  }
}

output "eb_application_name" {
  description = "Elastic Beanstalk application name"
  value       = aws_elastic_beanstalk_application.api.name
}

output "eb_environment_name" {
  description = "Elastic Beanstalk environment name"
  value       = aws_elastic_beanstalk_environment.api.name
}

output "eb_environment_url" {
  description = "Elastic Beanstalk environment URL"
  value       = aws_elastic_beanstalk_environment.api.endpoint_url
}

output "eb_instance_profile" {
  description = "Instance profile for EB instances"
  value       = aws_iam_instance_profile.eb.name
}

output "eb_service_role" {
  description = "Service role ARN for EB"
  value       = aws_iam_role.eb_service.arn
}

output "eb_vpc_id" {
  description = "VPC ID for EB environment"
  value       = aws_vpc.main.id
}

output "eb_private_subnets" {
  description = "Private subnet IDs for EB instances"
  value       = join(",", aws_subnet.private[*].id)
}

output "eb_public_subnets" {
  description = "Public subnet IDs for ALB"
  value       = join(",", aws_subnet.public[*].id)
}

output "eb_instance_security_group" {
  description = "Security group for EB instances"
  value       = aws_security_group.eb_instance.id
}

output "eb_alb_security_group" {
  description = "Security group for ALB"
  value       = aws_security_group.alb.id
}
