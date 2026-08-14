resource "random_password" "db_password" {
  length  = 32
  special = false # Avoid special chars that might cause issues
}

resource "aws_db_subnet_group" "aurora" {
  name       = "${var.project_name}-aurora"
  subnet_ids = aws_subnet.private[*].id

  tags = {
    Name = "${var.project_name}-aurora-subnet-group"
  }
}

resource "aws_rds_cluster_parameter_group" "aurora" {
  name   = "${var.project_name}-aurora-pg16"
  family = "aurora-postgresql16"

  parameter {
    name  = "log_statement"
    value = "ddl"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000" # Log queries taking > 1s
  }

  tags = {
    Name = "${var.project_name}-aurora-pg16"
  }
}

resource "aws_rds_cluster" "aurora" {
  cluster_identifier = "${var.project_name}-aurora"
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned"
  engine_version     = "16.8"
  database_name      = var.db_name
  master_username    = "postgres"
  master_password    = random_password.db_password.result
  storage_encrypted  = true
  # Unconditional, not `var.environment != "prod"`.
  #
  # `environment` defaults to "dev" and there is no committed terraform.tfvars,
  # so the old expression evaluated TRUE on the environment that actually holds
  # the graded data — a destroy took the cluster with no snapshot at all. Paired
  # with `backup_retention_period = 1` and an unset `delete_automated_backups`
  # (provider default: true), the automated backups went with it. That is
  # unrecoverable data loss, not a restore-from-backup inconvenience, and
  # "non-prod" was never a safe proxy for "disposable" here.
  #
  # The identifier has to move with it: AWS REQUIRES a name when the skip is
  # off, and the old expression left it null for every non-prod environment, so
  # flipping the skip alone would fail apply rather than protect anything.
  # `ignore_changes` below absorbs the `timestamp()` churn so this does not show
  # up as perpetual drift.
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.project_name}-final-snapshot-${formatdate("YYYY-MM-DD-hhmm", timestamp())}"
  # 7 days everywhere, for the same reason as `skip_final_snapshot` above: the
  # environment holding the graded data is called "dev", so every conditional
  # keyed on that name was quietly configuring the real database as if it were
  # scratch. One day of retention means a Friday mistake found on Monday has
  # nothing to restore from.
  backup_retention_period = 7
  # Provider default is TRUE — deleting the cluster also deletes its automated
  # backups, which is what made the old non-prod branch unrecoverable rather
  # than merely inconvenient. The final snapshot alone does not cover this:
  # a snapshot is one point in time, while these are the point-in-time recovery
  # window, and they are what you need when the problem is data corruption
  # noticed days later rather than an accidental teardown.
  delete_automated_backups        = false
  preferred_backup_window         = "03:00-04:00"
  preferred_maintenance_window    = "sun:04:00-sun:05:00"
  enabled_cloudwatch_logs_exports = ["postgresql"]

  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.aurora.name
  vpc_security_group_ids          = [aws_security_group.aurora.id]
  db_subnet_group_name            = aws_db_subnet_group.aurora.name

  serverlessv2_scaling_configuration {
    min_capacity = var.aurora_min_capacity
    max_capacity = var.aurora_max_capacity
  }

  tags = {
    Name = "${var.project_name}-aurora-cluster"
  }

  lifecycle {
    ignore_changes = [final_snapshot_identifier]
  }
}

resource "aws_rds_cluster_instance" "aurora" {
  cluster_identifier   = aws_rds_cluster.aurora.id
  identifier           = "${var.project_name}-aurora-instance-1"
  instance_class       = "db.serverless"
  engine               = aws_rds_cluster.aurora.engine
  engine_version       = aws_rds_cluster.aurora.engine_version
  publicly_accessible  = false
  db_subnet_group_name = aws_db_subnet_group.aurora.name

  tags = {
    Name = "${var.project_name}-aurora-instance-1"
  }
}

# CloudWatch Log Group for Aurora logs
resource "aws_cloudwatch_log_group" "aurora" {
  name              = "/aws/rds/cluster/${aws_rds_cluster.aurora.cluster_identifier}/postgresql"
  retention_in_days = 30

  tags = {
    Name = "${var.project_name}-aurora-logs"
  }
}
