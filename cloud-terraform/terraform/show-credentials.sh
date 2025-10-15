#!/bin/bash
# Quick script to display all Aegis credentials

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

echo "═══════════════════════════════════════════════════"
echo "  🔐 Aegis Platform Credentials"
echo "═══════════════════════════════════════════════════"
echo ""

# Database credentials
echo "📊 DATABASE CONNECTION"
echo "───────────────────────────────────────────────────"
terraform output -json database_connection_info | jq -r '
"Host:     \(.host)
Port:     \(.port)
Database: \(.database)
Username: \(.username)
Password: \(.password)
SSL Mode: \(.sslmode)"
'
echo ""

# JWT Secret
echo "🔑 JWT SECRET (for proxy)"
echo "───────────────────────────────────────────────────"
terraform output -raw jwt_secret_value
echo ""
echo ""

# AWS Secrets Manager references
echo "☁️  AWS SECRETS MANAGER"
echo "───────────────────────────────────────────────────"
terraform output -json secrets | jq -r '
if . != null then
  "DB Password ARN:  \(.db_password_secret_arn)
JWT Secret ARN:   \(.jwt_secret_secret_arn)"
else
  "Secrets not created (create_secrets=false)"
end
'
echo ""

# Service endpoints
echo "🌐 SERVICE ENDPOINTS"
echo "───────────────────────────────────────────────────"
echo "Cluster: $(terraform output -raw cluster_name)"
echo "Region:  $(terraform output -raw aws_region)"
echo ""
echo "Get Load Balancer URLs:"
echo "  kubectl get svc -n aegis-system"
echo ""

# ECR URLs
echo "🐳 DOCKER IMAGE REGISTRY"
echo "───────────────────────────────────────────────────"
terraform output -raw ecr_registry_url
echo ""
echo ""

# Quick commands
echo "📝 QUICK COMMANDS"
echo "───────────────────────────────────────────────────"
echo "Configure kubectl:"
echo "  $(terraform output -raw kubectl_config_command)"
echo ""
echo "Test database connection:"
echo "  kubectl run psql-test --rm -i --restart=Never \\"
echo "    --image=postgres:15 --namespace=aegis-system \\"
echo "    --env=\"PGPASSWORD=\$(terraform output -raw db_password_secret_value)\" \\"
echo "    -- psql -h \$(terraform output rds_endpoint | cut -d: -f1) \\"
echo "    -U aegis_api -d aegis -c 'SELECT version();'"
echo ""

echo "═══════════════════════════════════════════════════"
echo "💾 Save this output securely!"
echo "═══════════════════════════════════════════════════"
