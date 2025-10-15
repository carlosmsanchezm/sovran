# Aegis Deployment Quick Reference

## Get Database Credentials

```bash
cd terraform

# Get all database connection info (JSON)
terraform output -json database_connection_info | jq

# Get individual values
terraform output -raw db_password_secret_value     # Password
terraform output rds_endpoint                       # Host:Port
terraform output rds_database_name                  # Database name
terraform output rds_username                       # Username

# Pretty print for easy copy-paste
terraform output -json database_connection_info | jq -r '
"Host:     \(.host)
Port:     \(.port)
Database: \(.database)
Username: \(.username)
Password: \(.password)
SSL Mode: \(.sslmode)"
'
```

## Alternative: Get from AWS Secrets Manager

```bash
# Database password
aws secretsmanager get-secret-value \
  --secret-id aegis/prod/db-password \
  --profile myclaude --region us-east-1 \
  --query SecretString --output text

# JWT secret
aws secretsmanager get-secret-value \
  --secret-id aegis/prod/proxy-jwt-secret \
  --profile myclaude --region us-east-1 \
  --query SecretString --output text
```

## Deploy/Update Platform

```bash
cd terraform

# One-command deployment
./generate-helm-values.sh

# Or manual deployment
cd ../charts
helm upgrade --install aegis ./aegis-services \
  -f ./aegis-services/values/common.yaml \
  -f ./aegis-services/values/cloud.yaml \
  -f ./aegis-services/values-cloud-generated.yaml \
  --set platformApi.image.tag=v1.0.5 \
  --namespace aegis-system
```

## Common Troubleshooting

### Check Pod Status
```bash
kubectl get pods -n aegis-system
kubectl logs -n aegis-system -l app.kubernetes.io/component=platform-api --tail=50
```

### Test Database Connection
```bash
# Get password
DB_PASS=$(terraform -chdir=terraform output -raw db_password_secret_value)
DB_HOST=$(terraform -chdir=terraform output rds_endpoint | cut -d: -f1)

# Test connection
kubectl run psql-test --rm -i --restart=Never \
  --image=postgres:15 --namespace=aegis-system \
  --env="PGPASSWORD=${DB_PASS}" \
  -- psql -h ${DB_HOST} -U aegis_api -d aegis \
  -c "SELECT version();"
```

### Verify Cluster Registration
```bash
kubectl logs -n aegis-system -l app.kubernetes.io/component=platform-api \
  | grep "cluster registered"
```

## Environment Variables for Helm

When deploying manually, platform-api needs these DB environment variables:

```yaml
DB_HOST: <from terraform output rds_endpoint>
DB_PORT: 5432
DB_NAME: aegis
DB_USER: aegis_api
DB_PASSWORD: <from terraform output db_password_secret_value>
DB_SSLMODE: require
```

**Important**: The platform-api code uses `buildPostgresDSN()` which constructs the connection string from these individual environment variables. It will URL-encode the password automatically.

## Service Endpoints

```bash
# Platform API Load Balancer
kubectl get svc aegis-platform-api -n aegis-system \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'

# Proxy Load Balancer
kubectl get svc aegis-proxy -n aegis-system \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
```

## Image Versions

Current production versions:
- **platform-api**: v1.0.5
- **proxy**: latest
- **k8s-agent**: v1.0.0

Update versions in Helm values or via `--set` flags.
