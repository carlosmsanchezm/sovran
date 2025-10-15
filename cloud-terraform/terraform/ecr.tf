# ECR Repositories for Aegis container images

locals {
  ecr_repository_names = toset(var.ecr_repositories)
}

module "ecr" {
  source  = "terraform-aws-modules/ecr/aws"
  version = "~> 2.0"

  for_each = var.manage_ecr_repositories ? local.ecr_repository_names : toset([])

  repository_name = each.value

  # Repository configuration
  repository_type = "private"

  # Image scanning
  repository_image_scan_on_push = true

  # Lifecycle policy to manage image retention
  repository_lifecycle_policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 10 production images"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["v", "prod"]
          countType     = "imageCountMoreThan"
          countNumber   = 10
        }
        action = {
          type = "expire"
        }
      },
      {
        rulePriority = 2
        description  = "Keep last 5 development images"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["dev", "staging", "amd64"]
          countType     = "imageCountMoreThan"
          countNumber   = 5
        }
        action = {
          type = "expire"
        }
      },
      {
        rulePriority = 3
        description  = "Delete untagged images older than 1 day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = {
          type = "expire"
        }
      }
    ]
  })

  # Repository policy for cross-account access if needed
  create_repository_policy = true
  repository_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowPull"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action = [
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:BatchCheckLayerAvailability"
        ]
      }
    ]
  })

  tags = merge(local.common_tags, {
    Name = "aegis-${replace(each.value, "/", "-")}"
  })
}

# Output ECR repository URLs for use in Helm values. When repositories are not
# managed by Terraform, compute the URLs directly so downstream modules can
# continue to reference the expected locations.
locals {
  ecr_repositories = var.manage_ecr_repositories ? {
    for repo_name, repo in module.ecr : repo_name => repo.repository_url
  } : {
    for repo_name in local.ecr_repository_names :
    repo_name => "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/${repo_name}"
  }
}
