# VPC and Networking Configuration using AWS VPC module

data "aws_availability_zones" "available" {
  state = "available"
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "${local.cluster_name}-vpc"
  cidr = var.vpc_cidr

  azs              = slice(data.aws_availability_zones.available.names, 0, 3)
  private_subnets  = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
  public_subnets   = ["10.0.101.0/24", "10.0.102.0/24", "10.0.103.0/24"]
  database_subnets = ["10.0.201.0/24", "10.0.202.0/24", "10.0.203.0/24"]

  enable_nat_gateway   = true
  single_nat_gateway   = true # Cost optimization
  enable_vpn_gateway   = false
  enable_dns_hostnames = true
  enable_dns_support   = true

  # Create database subnet group
  create_database_subnet_group = true
  database_subnet_group_name   = "${local.cluster_name}-db-subnet-group"

  # Tags for EKS
  public_subnet_tags = {
    "kubernetes.io/role/elb"                      = "1"
    "kubernetes.io/cluster/${local.cluster_name}" = "shared"
  }

  private_subnet_tags = {
    "kubernetes.io/role/internal-elb"             = "1"
    "kubernetes.io/cluster/${local.cluster_name}" = "shared"
  }

  database_subnet_tags = {
    "Name" = "${local.cluster_name}-database-subnet"
  }

  tags = local.common_tags

  # Ensure proper deletion order - VPC resources depend on EKS being deleted first
  depends_on = [
    # EKS cluster must be deleted before VPC resources
    # This is handled by referencing the VPC in EKS module
  ]
}