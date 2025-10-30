# Variables for Aegis Infrastructure

variable "aws_region" {
  description = "AWS region for resources"
  type        = string
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "AWS profile name for AWS CLI (leave blank when using environment-based auth)"
  type        = string
  default     = ""
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
  default     = "prod"
}

variable "cluster_name_prefix" {
  description = "Prefix for EKS cluster name"
  type        = string
  default     = "aegis-spoke"
}

variable "cluster_version" {
  description = "EKS cluster version"
  type        = string
  default     = "1.33"
}

# VPC Configuration
variable "vpc_cidr" {
  description = "CIDR block for VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "Availability zones to use"
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b", "us-east-1c"]
}

# EKS Node Groups
variable "cpu_instance_type" {
  description = "Instance type for CPU workers"
  type        = string
  default     = "t3.medium"
}

variable "gpu_instance_type" {
  description = "Instance type for GPU workers"
  type        = string
  default     = "g4dn.xlarge"
}

variable "gpu_mig_instance_type" {
  description = "Instance type for MIG-capable GPU workers"
  type        = string
  default     = "g5.xlarge"
}

variable "cpu_desired_capacity" {
  description = "Desired capacity for CPU worker nodes"
  type        = number
  default     = 2
}

variable "gpu_desired_capacity" {
  description = "Desired capacity for GPU worker nodes"
  type        = number
  default     = 0
}

variable "gpu_max_capacity" {
  description = "Maximum capacity for GPU worker nodes"
  type        = number
  default     = 2
}

variable "gpu_mig_desired_capacity" {
  description = "Desired capacity for MIG GPU worker nodes"
  type        = number
  default     = 0
}

variable "gpu_mig_max_capacity" {
  description = "Maximum capacity for MIG GPU worker nodes"
  type        = number
  default     = 1
}

variable "use_spot_instances" {
  description = "Use spot instances for cost optimization"
  type        = bool
  default     = true
}

# RDS Configuration
variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t3.micro"
}

variable "db_allocated_storage" {
  description = "RDS allocated storage in GB"
  type        = number
  default     = 20
}

variable "db_max_allocated_storage" {
  description = "RDS maximum allocated storage in GB"
  type        = number
  default     = 100
}

variable "db_postgres_version" {
  description = "PostgreSQL version"
  type        = string
  default     = "15.12"
}

variable "db_backup_retention" {
  description = "Database backup retention period in days"
  type        = number
  default     = 7
}

variable "db_backup_window" {
  description = "Database backup window"
  type        = string
  default     = "03:00-04:00"
}

variable "db_maintenance_window" {
  description = "Database maintenance window"
  type        = string
  default     = "sun:04:00-sun:05:00"
}

variable "db_skip_final_snapshot" {
  description = "Skip final snapshot when destroying database"
  type        = bool
  default     = false
}

variable "db_deletion_protection" {
  description = "Enable deletion protection on the database"
  type        = bool
  default     = false
}

# ECR Configuration
variable "ecr_repositories" {
  description = "List of ECR repositories to create"
  type        = list(string)
  default     = ["aegis/k8s-agent", "aegis/proxy", "aegis/platform-api", "aegis/workspace-vscode"]
}

variable "manage_ecr_repositories" {
  description = "Whether Terraform should create and manage ECR repositories"
  type        = bool
  default     = false
}

# Secrets Configuration
variable "create_secrets" {
  description = "Create AWS Secrets Manager secrets"
  type        = bool
  default     = true
}

# Route53 Configuration
variable "platform_api_lb_hostname" {
  description = "Platform API LoadBalancer hostname (populated after K8s deployment)"
  type        = string
  default     = ""
}

variable "proxy_lb_hostname" {
  description = "Proxy LoadBalancer hostname (populated after K8s deployment)"
  type        = string
  default     = ""
}

variable "keycloak_lb_hostname" {
  description = "Keycloak LoadBalancer hostname (populated after K8s deployment)"
  type        = string
  default     = ""
}
