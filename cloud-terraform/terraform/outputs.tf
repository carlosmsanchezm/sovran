# Terraform Outputs for Aegis Infrastructure

# EKS Cluster Information
output "cluster_name" {
  description = "Name of the EKS cluster"
  value       = aws_eks_cluster.main.name
}

output "node_security_group_id" {
  description = "Primary security group used by EKS worker nodes"
  value       = aws_security_group.node.id
}

output "eks_cluster_security_group_id" {
  description = "AWS-managed cluster security group created by EKS"
  value       = aws_eks_cluster.main.vpc_config[0].cluster_security_group_id
}

# These outputs moved to eks.tf

# Node Groups
output "node_groups" {
  description = "EKS node groups information"
  value = {
    cpu_workers = {
      node_group_id  = aws_eks_node_group.cpu_workers.id
      node_group_arn = aws_eks_node_group.cpu_workers.arn
    }
    gpu_workers = {
      node_group_id  = aws_eks_node_group.gpu_workers.id
      node_group_arn = aws_eks_node_group.gpu_workers.arn
    }
    gpu_mig_workers = {
      node_group_id  = aws_eks_node_group.gpu_mig_workers.id
      node_group_arn = aws_eks_node_group.gpu_mig_workers.arn
    }
  }
}

# VPC Information
output "vpc_id" {
  description = "VPC ID"
  value       = module.vpc.vpc_id
}

output "vpc_cidr_block" {
  description = "VPC CIDR block"
  value       = module.vpc.vpc_cidr_block
}

output "private_subnet_ids" {
  description = "Private subnet IDs"
  value       = module.vpc.private_subnets
}

output "public_subnet_ids" {
  description = "Public subnet IDs"
  value       = module.vpc.public_subnets
}

output "database_subnet_ids" {
  description = "Database subnet IDs"
  value       = module.vpc.database_subnets
}

# RDS Information
output "rds_endpoint" {
  description = "RDS instance endpoint"
  value       = module.rds.db_instance_endpoint
  sensitive   = false
}

output "rds_port" {
  description = "RDS instance port"
  value       = module.rds.db_instance_port
}

output "rds_database_name" {
  description = "Name of the database"
  value       = module.rds.db_instance_name
}

output "rds_username" {
  description = "Master username for the database"
  value       = module.rds.db_instance_username
  sensitive   = true
}

output "rds_arn" {
  description = "RDS instance ARN"
  value       = module.rds.db_instance_arn
}

# Secrets Manager
output "secrets" {
  description = "AWS Secrets Manager secret information"
  value = var.create_secrets ? {
    db_password_secret_arn  = aws_secretsmanager_secret.db_password[0].arn
    db_password_secret_name = aws_secretsmanager_secret.db_password[0].name
    jwt_secret_secret_arn   = aws_secretsmanager_secret.jwt_secret[0].arn
    jwt_secret_secret_name  = aws_secretsmanager_secret.jwt_secret[0].name
  } : null
}

# ECR Repositories
output "ecr_repositories" {
  description = "ECR repository URLs"
  value       = local.ecr_repositories
}

output "ecr_registry_url" {
  description = "ECR registry URL"
  value       = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com"
}

# Helper outputs for Helm values
output "helm_values" {
  description = "Generated values for Helm chart deployment"
  sensitive   = true
  value = {
    # Platform API configuration
    platform_api = {
      image_repository = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/aegis/platform-api"
      db_host          = split(":", module.rds.db_instance_endpoint)[0]
      db_port          = module.rds.db_instance_port
      db_name          = module.rds.db_instance_name
      db_user          = module.rds.db_instance_username
    }

    # Proxy configuration
    proxy = {
      image_repository = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/aegis/proxy"
    }

    # K8s Agent configuration
    k8s_agent = {
      image_repository = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/aegis/k8s-agent"
      cluster_id       = "aws-${var.aws_region}-${var.environment}"
    }

    # Secrets configuration
    secrets = var.create_secrets ? {
      db_password_secret_name = aws_secretsmanager_secret.db_password[0].name
      jwt_secret_secret_name  = aws_secretsmanager_secret.jwt_secret[0].name
    } : null
  }
}

# Helm values for aegis-services chart (control plane / hub)
output "helm_values_aegis_services" {
  description = "Ready-to-use values for aegis-services Helm chart (control plane)"
  sensitive   = true
  value       = <<-EOT
  # Auto-generated from Terraform - aegis-services (Control Plane / Hub)
  # Cluster: ${aws_eks_cluster.main.name}
  # Region: ${var.aws_region}
  # Generated: ${timestamp()}

  platformApi:
    image:
      repository: ${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/aegis/platform-api
      tag: "latest"  # TODO: Use specific version tags

    env:
      DB_HOST: "${split(":", module.rds.db_instance_endpoint)[0]}"
      DB_PORT: "${module.rds.db_instance_port}"
      DB_NAME: "${module.rds.db_instance_name}"
      DB_USER: "${module.rds.db_instance_username}"
      DB_SSLMODE: "require"

  proxy:
    image:
      repository: ${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/aegis/proxy
      tag: "latest"  # TODO: Use specific version tags
  EOT
}

# Helm values for aegis-spoke chart (workload cluster)
output "helm_values_aegis_spoke" {
  description = "Ready-to-use values for aegis-spoke Helm chart (workload cluster)"
  sensitive   = true
  value       = <<-EOT
  # Auto-generated from Terraform - aegis-spoke (Workload Cluster)
  # Cluster: ${aws_eks_cluster.main.name}
  # Region: ${var.aws_region}
  # Generated: ${timestamp()}

  k8sAgent:
    image:
      repository: ${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/aegis/k8s-agent
      tag: "latest"  # TODO: Use specific version tags

    env:
      AEGIS_CP_GRPC: "aegis-platform-api.aegis-system.svc.cluster.local:8081"
      AEGIS_PROXY_INGRESS_HOST: "proxy.yourdomain.com"  # TODO: Update domain
      AEGIS_CLUSTER_ID: "aws-${var.aws_region}-${var.environment}"

  proxy:
    enabled: false  # Use aegis-services proxy for hub/spoke architecture
  EOT
}

# Secret values (sensitive outputs)
output "db_password_secret_value" {
  description = "Database password (use to create k8s secret)"
  value       = var.create_secrets ? nonsensitive(random_password.db_password.result) : "not-created"
  sensitive   = true
}

# Complete database connection information
output "database_connection_info" {
  description = "Complete database connection information for platform-api"
  sensitive   = true
  value = {
    host     = split(":", module.rds.db_instance_endpoint)[0]
    port     = module.rds.db_instance_port
    database = module.rds.db_instance_name
    username = module.rds.db_instance_username
    password = var.create_secrets ? nonsensitive(random_password.db_password.result) : "not-created"
    sslmode  = "require"
    # Connection string for reference
    connection_string = "postgres://${module.rds.db_instance_username}:<PASSWORD>@${split(":", module.rds.db_instance_endpoint)[0]}:${module.rds.db_instance_port}/${module.rds.db_instance_name}?sslmode=require"
  }
}

output "jwt_secret_value" {
  description = "JWT secret for proxy (use to create k8s secret)"
  value       = var.create_secrets ? nonsensitive(random_password.jwt_secret.result) : "not-created"
  sensitive   = true
}

# Convenience output for creating K8s secrets
output "k8s_secret_commands" {
  description = "Commands to create Kubernetes secrets from Terraform outputs"
  value       = <<-EOT
  # Create secrets in Kubernetes from Terraform outputs:

  # 1. For aegis-services (control plane):
  kubectl create secret generic aegis-platform-secrets \
    --from-literal=db-password="$(terraform output -raw db_password_secret_value)" \
    --from-literal=proxy-jwt-secret="$(terraform output -raw jwt_secret_value)" \
    --namespace aegis-system

  # 2. AWS Secrets Manager ARNs (for External Secrets Operator):
  # DB Password: ${var.create_secrets ? aws_secretsmanager_secret.db_password[0].arn : "not-created"}
  # JWT Secret: ${var.create_secrets ? aws_secretsmanager_secret.jwt_secret[0].arn : "not-created"}
  EOT
}

# AWS Account Information
data "aws_caller_identity" "current" {}

output "aws_account_id" {
  description = "AWS Account ID"
  value       = data.aws_caller_identity.current.account_id
}

output "aws_region" {
  description = "AWS Region"
  value       = var.aws_region
}

# Kubectl configuration command
output "kubectl_config_command" {
  description = "Command to configure kubectl"
  value       = var.aws_profile != "" ? "aws eks update-kubeconfig --region ${var.aws_region} --name ${aws_eks_cluster.main.name} --profile ${var.aws_profile}" : "aws eks update-kubeconfig --region ${var.aws_region} --name ${aws_eks_cluster.main.name}"
}

# Route53 DNS Information
output "route53_zone_id" {
  description = "Route53 hosted zone ID for aegist.dev"
  value       = aws_route53_zone.aegist.zone_id
}

output "route53_zone_name" {
  description = "Route53 hosted zone name"
  value       = aws_route53_zone.aegist.name
}

output "dns_platform_api_grpc" {
  description = "DNS hostname for platform-api gRPC endpoint (use for VSCode extension)"
  value       = aws_route53_record.platform_api_grpc.fqdn
}

output "dns_platform_api_http" {
  description = "DNS hostname for platform-api HTTP gateway"
  value       = aws_route53_record.platform_api_http.fqdn
}

output "dns_proxy" {
  description = "DNS hostname for proxy service"
  value       = aws_route53_record.proxy.fqdn
}

output "dns_keycloak" {
  description = "DNS hostname for Keycloak"
  value       = aws_route53_record.keycloak.fqdn
}
