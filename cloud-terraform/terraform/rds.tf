# RDS PostgreSQL Database Configuration

# Generate random password for database
resource "random_password" "db_password" {
  length  = 32
  special = true
  # RDS doesn't allow: / @ " (space) and the connection string breaks on ':' or '?'
  override_special = "!#$%&*()-_=+[]{}<>"

  # Force new password generation
  keepers = {
    reset = "2025-10-04"
  }
}

# Store database password in AWS Secrets Manager
resource "aws_secretsmanager_secret" "db_password" {
  count = var.create_secrets ? 1 : 0

  name                    = "aegis/${var.environment}/db-password"
  description             = "PostgreSQL database password for Aegis platform-api"
  recovery_window_in_days = 0 # Force immediate deletion to avoid recreation issues

  tags = local.common_tags
}

resource "aws_secretsmanager_secret_version" "db_password" {
  count = var.create_secrets ? 1 : 0

  secret_id     = aws_secretsmanager_secret.db_password[0].id
  secret_string = random_password.db_password.result
}

# Generate JWT secret for proxy
resource "random_password" "jwt_secret" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "jwt_secret" {
  count = var.create_secrets ? 1 : 0

  name                    = "aegis/${var.environment}/proxy-jwt-secret"
  description             = "JWT secret for Aegis proxy service"
  recovery_window_in_days = 0 # Force immediate deletion to avoid recreation issues

  tags = local.common_tags
}

resource "aws_secretsmanager_secret_version" "jwt_secret" {
  count = var.create_secrets ? 1 : 0

  secret_id     = aws_secretsmanager_secret.jwt_secret[0].id
  secret_string = random_password.jwt_secret.result
}

# Data source to get EKS cluster-managed security group
data "aws_security_groups" "eks_cluster_sg" {
  filter {
    name   = "tag:aws:eks:cluster-name"
    values = [local.cluster_name]
  }

  filter {
    name   = "vpc-id"
    values = [module.vpc.vpc_id]
  }

  depends_on = [aws_eks_cluster.main]
}

# Security group for RDS
resource "aws_security_group" "rds" {
  name_prefix = "${local.cluster_name}-rds-"
  vpc_id      = module.vpc.vpc_id
  description = "Security group for Aegis RDS PostgreSQL instance"

  # Allow PostgreSQL access from EKS nodes (terraform-managed SG)
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.node.id]
    description     = "PostgreSQL access from EKS nodes"
  }

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_eks_cluster.main.vpc_config[0].cluster_security_group_id]
    description     = "PostgreSQL access from EKS cluster security group"
  }

  # Allow all outbound (though RDS typically doesn't need it)
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name = "${local.cluster_name}-rds-sg"
  })
}

# Additional security group rule for EKS cluster-managed security group
# RDS PostgreSQL instance
module "rds" {
  source  = "terraform-aws-modules/rds/aws"
  version = "~> 6.0"

  identifier = "${local.cluster_name}-db"

  # Database configuration
  engine               = "postgres"
  engine_version       = var.db_postgres_version
  family               = "postgres15"
  major_engine_version = "15"
  instance_class       = var.db_instance_class

  # Storage configuration
  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true

  # Database settings
  db_name  = "aegis"
  username = "aegis_api"
  password = random_password.db_password.result
  port     = 5432

  # Use Terraform-managed password instead of AWS-managed
  manage_master_user_password = false

  # Network configuration
  db_subnet_group_name   = module.vpc.database_subnet_group_name
  vpc_security_group_ids = [aws_security_group.rds.id]

  # Backup configuration
  backup_retention_period = var.db_backup_retention
  backup_window           = var.db_backup_window
  maintenance_window      = var.db_maintenance_window

  # Monitoring
  monitoring_interval    = 60
  monitoring_role_name   = "${local.cluster_name}-rds-monitoring-role"
  create_monitoring_role = true

  # Performance Insights
  performance_insights_enabled          = true
  performance_insights_retention_period = 7

  # Deletion protection
  deletion_protection              = var.db_deletion_protection
  skip_final_snapshot              = true
  final_snapshot_identifier_prefix = null

  # Enable automated minor version upgrades
  auto_minor_version_upgrade = true

  # Apply changes immediately (for password updates)
  apply_immediately = true

  # Database parameters
  create_db_parameter_group = true
  parameter_group_name      = "${local.cluster_name}-postgres-params"
  parameters = [
    {
      name  = "log_statement"
      value = "all"
    },
    {
      name  = "log_min_duration_statement"
      value = "1000" # Log queries taking more than 1 second
    },
    {
      name  = "shared_preload_libraries"
      value = "pg_stat_statements"
    }
  ]

  tags = merge(local.common_tags, {
    Name = "${local.cluster_name}-database"
  })
}
