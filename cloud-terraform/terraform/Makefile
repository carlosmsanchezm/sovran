# Makefile for Aegis Terraform Infrastructure

.PHONY: help init plan apply destroy validate format check-vars helm-values clean

# Default target
help: ## Show this help message
	@echo "Aegis Infrastructure Management"
	@echo "Usage: make [target]"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# Variables
AWS_PROFILE ?= myclaude
AWS_REGION ?= us-east-1
ENVIRONMENT ?= prod

# Check if terraform.tfvars exists
check-vars: ## Check if terraform.tfvars exists
	@if [ ! -f terraform.tfvars ]; then \
		echo "❌ terraform.tfvars not found. Copy from terraform.tfvars.example and configure."; \
		echo "   cp terraform.tfvars.example terraform.tfvars"; \
		exit 1; \
	fi

init: ## Initialize Terraform
	@echo "🔧 Initializing Terraform..."
	terraform init

validate: init ## Validate Terraform configuration
	@echo "✅ Validating Terraform configuration..."
	terraform validate

format: ## Format Terraform files
	@echo "🎨 Formatting Terraform files..."
	terraform fmt -recursive

plan: check-vars validate ## Show Terraform execution plan
	@echo "📋 Creating Terraform plan..."
	terraform plan -out=tfplan

apply: check-vars validate ## Apply Terraform configuration
	@echo "🚀 Applying Terraform configuration..."
	terraform apply tfplan || terraform apply

destroy: check-vars ## Destroy all infrastructure (WARNING: DESTRUCTIVE)
	@echo "🚨 WARNING: This will destroy ALL infrastructure!"
	@echo "This includes:"
	@echo "  - EKS Cluster and all workloads"
	@echo "  - RDS Database (with final snapshot if configured)"
	@echo "  - VPC and all networking"
	@echo "  - ECR Repositories and images"
	@echo ""
	@read -p "Type 'DESTROY' to confirm: " confirmation; \
	if [ "$$confirmation" = "DESTROY" ]; then \
		terraform destroy; \
	else \
		echo "❌ Cancelled"; \
		exit 1; \
	fi

helm-values: ## Generate Helm values from Terraform outputs
	@echo "📊 Generating Helm values..."
	@if ! terraform show -json > /dev/null 2>&1; then \
		echo "❌ No Terraform state found. Run 'make apply' first."; \
		exit 1; \
	fi
	@terraform output -json helm_values | jq '.' > helm_values.json
	@echo "✅ Generated helm_values.json"
	@echo ""
	@echo "📝 To deploy Aegis services:"
	@echo "   1. Configure kubectl: $$(terraform output -raw kubectl_config_command)"
	@echo "   2. Install NGINX Ingress: make install-ingress"
	@echo "   3. Deploy Aegis: make deploy-aegis"

install-ingress: ## Install NGINX Ingress Controller
	@echo "🌐 Installing NGINX Ingress Controller..."
	helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx --force-update
	helm repo update
	kubectl create namespace kube-system --dry-run=client -o yaml | kubectl apply -f -
	helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
		-n kube-system \
		--wait \
		--timeout=300s

deploy-aegis: helm-values ## Deploy Aegis services with Helm
	@echo "📦 Deploying Aegis services..."
	@if [ ! -f helm_values.json ]; then \
		echo "❌ helm_values.json not found. Run 'make helm-values' first."; \
		exit 1; \
	fi
	kubectl create namespace aegis-services --dry-run=client -o yaml | kubectl apply -f -

	# Create secrets from Terraform outputs
	@DB_PASSWORD=$$(aws secretsmanager get-secret-value \
		--secret-id "$$(terraform output -raw secrets | jq -r '.db_password_secret_name')" \
		--query SecretString \
		--output text \
		--profile $(AWS_PROFILE) \
		--region $(AWS_REGION)) && \
	JWT_SECRET=$$(aws secretsmanager get-secret-value \
		--secret-id "$$(terraform output -raw secrets | jq -r '.jwt_secret_secret_name')" \
		--query SecretString \
		--output text \
		--profile $(AWS_PROFILE) \
		--region $(AWS_REGION)) && \
		helm upgrade --install aegis-services ../charts/aegis-services \
		-n aegis-services \
		-f ../charts/aegis-services/values/common.yaml \
		-f ../charts/aegis-services/values/cloud.yaml \
		--set-string platformApi.secrets.db-password="$$DB_PASSWORD" \
		--set-string proxy.jwtSecret="$$JWT_SECRET" \
		--set-string platformApi.image.repository="$$(terraform output -raw helm_values | jq -r '.platform_api.image_repository')" \
		--set-string proxy.image.repository="$$(terraform output -raw helm_values | jq -r '.proxy.image_repository')" \
		--set-string platformApi.env.DB_HOST="$$(terraform output -raw helm_values | jq -r '.platform_api.db_host')" \
		--set-string platformApi.env.DB_PORT="$$(terraform output -raw helm_values | jq -r '.platform_api.db_port')" \
		--set-string platformApi.env.DB_NAME="$$(terraform output -raw helm_values | jq -r '.platform_api.db_name')" \
		--set-string platformApi.env.DB_USER="$$(terraform output -raw helm_values | jq -r '.platform_api.db_user')" \
		--wait \
		--timeout=600s

status: ## Show infrastructure status
	@echo "📊 Infrastructure Status:"
	@echo ""
	@echo "🏗️  EKS Cluster:"
	@terraform output cluster_name 2>/dev/null || echo "  Not deployed"
	@echo ""
	@echo "💾 RDS Database:"
	@terraform output rds_endpoint 2>/dev/null || echo "  Not deployed"
	@echo ""
	@echo "📦 ECR Repositories:"
	@terraform output ecr_repositories 2>/dev/null || echo "  Not deployed"

logs: ## Show logs from Aegis services
	@echo "📋 Aegis Service Logs:"
	@echo ""
	@echo "Platform API logs:"
	@kubectl logs -l app.kubernetes.io/component=platform-api -n aegis-services --tail=50 || echo "  No platform-api pods found"
	@echo ""
	@echo "Proxy logs:"
	@kubectl logs -l app.kubernetes.io/component=proxy -n aegis-services --tail=50 || echo "  No proxy pods found"

clean: ## Clean up temporary files
	@echo "🧹 Cleaning up temporary files..."
	rm -f tfplan
	rm -f helm_values.json
	rm -f aegis-services-values.yaml
	rm -f .terraform.lock.hcl

# Development shortcuts
dev-up: init plan apply install-ingress deploy-aegis ## Full development deployment
	@echo "🎉 Development environment ready!"

dev-down: destroy clean ## Destroy development environment
	@echo "🧹 Development environment destroyed!"

# Cost optimization
scale-gpu-up: ## Scale GPU workers to 1
	@echo "📈 Scaling GPU workers up..."
	aws eks update-nodegroup-config \
		--cluster-name $$(terraform output -raw cluster_name) \
		--nodegroup-name gpu-workers-g4 \
		--scaling-config minSize=0,maxSize=2,desiredSize=1 \
		--profile $(AWS_PROFILE) \
		--region $(AWS_REGION)

scale-gpu-down: ## Scale GPU workers to 0 (cost savings)
	@echo "📉 Scaling GPU workers down for cost savings..."
	aws eks update-nodegroup-config \
		--cluster-name $$(terraform output -raw cluster_name) \
		--nodegroup-name gpu-workers-g4 \
		--scaling-config minSize=0,maxSize=2,desiredSize=0 \
		--profile $(AWS_PROFILE) \
		--region $(AWS_REGION)
