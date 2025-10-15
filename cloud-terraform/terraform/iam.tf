# IAM roles and policies for EKS add-ons

module "ebs_csi_driver_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.0"

  role_name_prefix      = "${local.cluster_name}-ebs-csi-driver"
  attach_ebs_csi_policy = true
  role_description      = "IRSA role for the EKS aws-ebs-csi-driver add-on"

  oidc_providers = {
    this = {
      provider_arn               = aws_iam_openid_connect_provider.cluster.arn
      namespace_service_accounts = ["kube-system:ebs-csi-controller-sa"]
    }
  }

  tags = local.common_tags
}
