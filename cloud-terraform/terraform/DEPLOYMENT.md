# Aegis Infrastructure Deployment Guide

This guide covers deploying the complete Aegis platform infrastructure to AWS EKS.

## Prerequisites

- AWS CLI configured with credentials (profile: `myclaude`)
- Terraform >= 1.5
- kubectl
- Helm >= 3.0
- Docker with ECR authentication

## Deployment Steps

### 1. Deploy Infrastructure with Terraform

```bash
cd terraform

# Initialize Terraform
terraform init

# Review the plan
terraform plan

# Apply infrastructure
terraform apply
```

This creates:
- EKS cluster with CPU and GPU node groups
- RDS PostgreSQL database
- VPC with public/private/database subnets
- (Optional) ECR repositories *(set `manage_ecr_repositories = true` if you want Terraform to manage them)*
- AWS Secrets Manager secrets
- Security groups and IAM roles

### 2. Get Database Credentials

After Terraform completes, retrieve database connection information:

```bash
# Get all database connection info
terraform output -json database_connection_info | jq

# Or get individual values:
terraform output -raw db_password_secret_value    # Database password
terraform output rds_endpoint                      # Database host:port
terraform output rds_database_name                 # Database name
terraform output rds_username                      # Database username
```

**Save these credentials securely!** You'll need them for:
- Helm deployments
- Manual database operations
- Troubleshooting

### 3. Configure kubectl

```bash
# Configure kubectl to use the EKS cluster
terraform output -raw kubectl_config_command | bash

# Verify connection
kubectl get nodes
```

### 4. Build and Push Docker Images

```bash
cd ..  # Back to project root

# Authenticate with ECR
aws ecr get-login-password --region us-east-1 --profile myclaude | \
  docker login --username AWS --password-stdin \
  $(terraform -chdir=terraform output -raw ecr_registry_url)

# Build and push platform-api
docker buildx build --platform linux/amd64 \
  -t $(terraform -chdir=terraform output -raw ecr_registry_url)/aegis/platform-api:v1.0.5 \
  -f services/platform-api/Dockerfile . --push

# Build and push proxy
docker buildx build --platform linux/amd64 \
  -t $(terraform -chdir=terraform output -raw ecr_registry_url)/aegis/proxy:latest \
  -f services/proxy/Dockerfile . --push

# Build and push k8s-agent
docker buildx build --platform linux/amd64 \
  -t $(terraform -chdir=terraform output -raw ecr_registry_url)/aegis/k8s-agent:v1.0.0 \
  -f agents/k8s-agent/Dockerfile . --push
```

### 5. Run Database Migrations

```bash
cd terraform

# Get database password
DB_PASSWORD=$(terraform output -raw db_password_secret_value)
DB_HOST=$(terraform output -raw rds_endpoint | cut -d: -f1)

# Run migrations
kubectl run migrate-job --rm -i --restart=Never \
  --image=postgres:15 \
  --namespace=aegis-system \
  --env="PGPASSWORD=${DB_PASSWORD}" \
  -- psql -h ${DB_HOST} -U aegis_api -d aegis \
  -c "$(cat ../services/platform-api/migrations/0001_init.sql | grep -v '^--')"
```

### 6. Deploy Helm Charts

The `generate-helm-values.sh` script automates the deployment:

```bash
cd terraform

# Generate Helm values and deploy everything
./generate-helm-values.sh
```

This script will:
1. Generate Helm values from Terraform outputs
2. Configure kubectl
3. Create Kubernetes secrets
4. Deploy platform-api and proxy (aegis-services chart)
5. Deploy k8s-agent (aegis-spoke chart)
6. Update Backstage configuration

#### Manual Deployment (Alternative)

If you prefer manual control:

```bash
cd charts

# Get credentials
DB_PASSWORD=$(cd ../terraform && terraform output -raw db_password_secret_value)
JWT_SECRET=$(cd ../terraform && terraform output -raw jwt_secret_value)

# Create namespace and secrets
kubectl create namespace aegis-system --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic aegis-platform-secrets \
  --from-literal=db-password="${DB_PASSWORD}" \
  --from-literal=proxy-jwt-secret="${JWT_SECRET}" \
  --namespace aegis-system \
  --dry-run=client -o yaml | kubectl apply -f -

# Deploy aegis-services (platform-api + proxy)
helm upgrade --install aegis ./aegis-services \
  -f ./aegis-services/values/common.yaml \
  -f ./aegis-services/values/cloud.yaml \
  -f ./aegis-services/values-cloud-generated.yaml \
  --set platformApi.enabled=true \
  --set platformApi.image.tag=v1.0.5 \
  --set platformApi.replicaCount=1 \
  --set platformApi.env.DB_HOST=<RDS_ENDPOINT> \
  --set platformApi.env.DB_PORT=5432 \
  --set platformApi.env.DB_NAME=aegis \
  --set platformApi.env.DB_USER=aegis_api \
  --set platformApi.env.DB_PASSWORD="${DB_PASSWORD}" \
  --set platformApi.env.DB_SSLMODE=require \
  --set proxy.enabled=true \
  --set proxy.jwtSecret="${JWT_SECRET}" \
  --namespace aegis-system

# Deploy aegis-spoke (k8s-agent)
helm upgrade --install aegis-spoke ./aegis-spoke \
  -f ./aegis-spoke/values-cloud-generated.yaml \
  --set k8sAgent.enabled=true \
  --set k8sAgent.image.tag=v1.0.0 \
  --namespace aegis-system
```

## Verification

### Check Pod Status

```bash
kubectl get pods -n aegis-system
```

Expected output:
```
NAME                                      READY   STATUS    RESTARTS   AGE
aegis-platform-api-xxxxx                  1/1     Running   0          2m
aegis-proxy-xxxxx                         1/1     Running   0          2m
aegis-spoke-k8s-agent-xxxxx               1/1     Running   0          2m
```

### Check Logs

```bash
# Platform API logs
kubectl logs -n aegis-system -l app.kubernetes.io/component=platform-api --tail=50

# K8s Agent logs
kubectl logs -n aegis-system -l app.kubernetes.io/component=k8s-agent --tail=50

# Look for successful cluster registration
kubectl logs -n aegis-system -l app.kubernetes.io/component=platform-api | grep "cluster registered"
```

### Get Service URLs

```bash
# Platform API Load Balancer
kubectl get svc aegis-platform-api -n aegis-system \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'

# Proxy Load Balancer
kubectl get svc aegis-proxy -n aegis-system \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
```

## Common Issues and Troubleshooting

### Database Connection Errors

If you see `password authentication failed`:

1. Verify password is correct:
   ```bash
   terraform output -raw db_password_secret_value
   ```

2. Test connection manually:
   ```bash
   kubectl run psql-test --rm -i --restart=Never \
     --image=postgres:15 --namespace=aegis-system \
     --env="PGPASSWORD=<PASSWORD>" \
     -- psql -h <RDS_HOST> -U aegis_api -d aegis -c "SELECT version();"
   ```

3. Check platform-api pod environment:
   ```bash
   kubectl get pod -n aegis-system -l app.kubernetes.io/component=platform-api \
     -o jsonpath='{.items[0].spec.containers[0].env[?(@.name=="DB_PASSWORD")].value}'
   ```

### Missing Tables

If you see `relation "clusters" does not exist`:

```bash
# Run migrations again (see step 5 above)
```

### Image Pull Errors

If pods can't pull images from ECR:

```bash
# Re-authenticate with ECR
aws ecr get-login-password --region us-east-1 --profile myclaude | \
  docker login --username AWS --password-stdin \
  $(terraform -chdir=terraform output -raw ecr_registry_url)

# Rebuild and push images (see step 4 above)
```

## Updating the Deployment

### Update Infrastructure

```bash
cd terraform
terraform plan   # Review changes
terraform apply  # Apply changes
```

### Update Application Code

```bash
# 1. Build new images with updated tags
docker buildx build --platform linux/amd64 \
  -t <ECR_URL>/aegis/platform-api:v1.0.6 \
  -f services/platform-api/Dockerfile . --push

# 2. Update Helm deployment
helm upgrade aegis ./aegis-services \
  -f ./aegis-services/values/common.yaml \
  -f ./aegis-services/values/cloud.yaml \
  --set platformApi.image.tag=v1.0.6 \
  --namespace aegis-system

# 3. Verify rollout
kubectl rollout status deployment/aegis-platform-api -n aegis-system
```

## Accessing Database Credentials Later

Database credentials are stored in Terraform state. To retrieve them:

```bash
cd terraform

# Get complete connection info as JSON
terraform output -json database_connection_info | jq

# Get specific values
terraform output -raw db_password_secret_value
terraform output rds_endpoint
terraform output rds_username
terraform output rds_database_name
```

**Alternative: AWS Secrets Manager**

Credentials are also stored in AWS Secrets Manager:

```bash
# Get DB password from Secrets Manager
aws secretsmanager get-secret-value \
  --secret-id aegis/prod/db-password \
  --profile myclaude --region us-east-1 \
  --query SecretString --output text

# Get JWT secret
aws secretsmanager get-secret-value \
  --secret-id aegis/prod/proxy-jwt-secret \
  --profile myclaude --region us-east-1 \
  --query SecretString --output text
```

## Security Best Practices

1. **Rotate Passwords**: Update `terraform/rds.tf` `keepers.reset` date and run `terraform apply`
2. **Backup State**: Ensure Terraform state is backed up (consider using S3 backend)
3. **Restrict Access**: Use AWS IAM policies to limit who can access Secrets Manager
4. **Enable Logging**: RDS and EKS audit logs are enabled by default
5. **Network Security**: Database is only accessible from EKS nodes (security groups)

## Clean Up

To destroy all infrastructure:

```bash
cd terraform

# Delete Helm releases first
helm uninstall aegis -n aegis-system
helm uninstall aegis-spoke -n aegis-system

# Destroy infrastructure
terraform destroy
```

## Quick Reference Commands

```bash
# Get database password
terraform -chdir=terraform output -raw db_password_secret_value

# Get platform-api Load Balancer URL
kubectl get svc aegis-platform-api -n aegis-system -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'

# Restart platform-api
kubectl rollout restart deployment/aegis-platform-api -n aegis-system

# View all resources
kubectl get all -n aegis-system

# Check cluster registration
kubectl logs -n aegis-system -l app.kubernetes.io/component=platform-api | grep "cluster registered"
```
