# Terraform Destroy Checklist

## What's Automated

Terraform is now configured with proper dependencies:
- ✅ ECR repositories: Removed from state (won't be deleted)
- ✅ RDS: `skip_final_snapshot = true` (no snapshot conflicts)
- ✅ EKS node groups: Will delete before cluster (via module dependencies)
- ✅ Security groups: Proper deletion order configured

## What Requires Manual Steps

**⚠️ CRITICAL: You MUST delete Kubernetes LoadBalancers before running terraform destroy!**

Kubernetes creates AWS LoadBalancers that Terraform doesn't manage. These block subnet/VPC deletion.

## Pre-Destroy Steps

### 1. Delete Kubernetes Resources (if EKS cluster exists)
```bash
# Configure kubectl (if cluster is still running)
aws eks update-kubeconfig --region us-east-1 --name aegis-spoke-prod --profile myclaude

# Delete Helm releases (removes LoadBalancers)
helm delete aegis -n aegis-system 2>/dev/null || true
helm delete aegis-spoke -n aegis-system 2>/dev/null || true

# Wait for LoadBalancers to be deleted
echo "Waiting 60 seconds for LoadBalancers to be cleaned up..."
sleep 60
```

### 2. Force Delete LoadBalancers (if Kubernetes is unreachable)
```bash
# Delete Network Load Balancers
aws --profile myclaude elbv2 describe-load-balancers --region us-east-1 \
  --query 'LoadBalancers[?VpcId==`vpc-0a4b821294f120863`].[LoadBalancerArn]' \
  --output text | xargs -I {} aws --profile myclaude elbv2 delete-load-balancer --load-balancer-arn {} --region us-east-1

# Delete Classic Load Balancers
aws --profile myclaude elb describe-load-balancers --region us-east-1 \
  --query 'LoadBalancerDescriptions[?VPCId==`vpc-0a4b821294f120863`].[LoadBalancerName]' \
  --output text | xargs -I {} aws --profile myclaude elb delete-load-balancer --load-balancer-name {} --region us-east-1

# Wait for deletion
sleep 30
```

### 3. Run Terraform Destroy
```bash
cd /Users/carlossanchez/code/aegis/terraform
terraform destroy -auto-approve
```

## Common Issues

### Subnets won't delete
**Cause:** Network interfaces (ENIs) from LoadBalancers still attached

**Solution:** Delete LoadBalancers first (see step 2 above)

### Internet Gateway won't delete
**Cause:** IGW detachment takes time

**Solution:** Wait 30-60 seconds and retry terraform destroy

### EKS Cluster stuck destroying
**Cause:** Node groups still terminating

**Solution:** Manually delete node groups:
```bash
aws eks delete-nodegroup --cluster-name aegis-spoke-prod --nodegroup-name <NAME> --profile myclaude --region us-east-1
```

## Prevention

Always delete Kubernetes resources BEFORE destroying infrastructure:
1. Helm releases → deletes Services → deletes LoadBalancers
2. Then run `terraform destroy`
