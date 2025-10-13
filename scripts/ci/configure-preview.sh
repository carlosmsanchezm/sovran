#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${HELM_RELEASE:-}" ]]; then
  echo "HELM_RELEASE environment variable is required" >&2
  exit 1
fi

if [[ -z "${K8S_NAMESPACE:-}" ]]; then
  echo "K8S_NAMESPACE environment variable is required" >&2
  exit 1
fi

TERRAFORM_DIR="${TERRAFORM_DIR:-infra/terraform}"
CA_BUNDLE="${CA_BUNDLE:-${HOME}/aegis-platform-api-ca.crt}"

if [[ ! -d "${TERRAFORM_DIR}" ]]; then
  echo "Terraform directory ${TERRAFORM_DIR} not found" >&2
  exit 1
fi

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1" >&2
    exit 2
  fi
}

need kubectl
need terraform
need dig

log() {
  printf '[configure-preview] %s\n' "$*" >&2
}

wait_for_lb() {
  local svc="$1"
  local namespace="$2"
  local hostname=""
  for i in {1..60}; do
    hostname="$(kubectl get svc "${svc}" -n "${namespace}" -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)"
    if [[ -n "${hostname}" ]]; then
      log "LoadBalancer ready for ${svc}: ${hostname}"
      echo "${hostname}"
      return 0
    fi
    log "Waiting for LoadBalancer hostname for ${svc} (${i}/60)"
    sleep 5
  done
  echo ""
}

log "Waiting for preview LoadBalancers..."
PLATFORM_LB="$(wait_for_lb "${HELM_RELEASE}-platform-api" "${K8S_NAMESPACE}")"
PROXY_LB="$(wait_for_lb "${HELM_RELEASE}-proxy" "${K8S_NAMESPACE}")"

if [[ -z "${PLATFORM_LB}" || -z "${PROXY_LB}" ]]; then
  log "Failed to resolve LoadBalancer hostnames"
  exit 1
fi

log "Updating Route53 records with actual hostnames"
pushd "${TERRAFORM_DIR}" >/dev/null
terraform apply -auto-approve \
  -var="platform_api_lb_hostname=${PLATFORM_LB}" \
  -var="proxy_lb_hostname=${PROXY_LB}" \
  -target=aws_route53_record.platform_api_grpc \
  -target=aws_route53_record.platform_api_http \
  -target=aws_route53_record.proxy

PLATFORM_DNS="$(terraform output -raw dns_platform_api_grpc 2>/dev/null || echo "")"
PROXY_DNS="$(terraform output -raw dns_proxy 2>/dev/null || echo "")"
popd >/dev/null

PLATFORM_DNS="${PLATFORM_DNS%.}"
PROXY_DNS="${PROXY_DNS%.}"

if [[ -z "${PLATFORM_DNS}" || -z "${PROXY_DNS}" ]]; then
  log "Terraform did not return DNS records"
  exit 1
fi

log "Route53 updated:"
log "  ${PLATFORM_DNS} → ${PLATFORM_LB}"
log "  ${PROXY_DNS} → ${PROXY_LB}"

log "Resolving LoadBalancer IPs for local /etc/hosts overrides"
PLATFORM_IP="$(dig +short "${PLATFORM_LB}" | head -1)"
PROXY_IP="$(dig +short "${PROXY_LB}" | head -1)"

if [[ -n "${PLATFORM_IP}" ]]; then
  log "  Platform API IP: ${PLATFORM_IP}"
  sudo sed -i.bak "/${PLATFORM_DNS}/d" /etc/hosts 2>/dev/null || true
  echo "${PLATFORM_IP} ${PLATFORM_DNS}" | sudo tee -a /etc/hosts >/dev/null
fi

if [[ -n "${PROXY_IP}" ]]; then
  log "  Proxy IP: ${PROXY_IP}"
  sudo sed -i.bak "/${PROXY_DNS}/d" /etc/hosts 2>/dev/null || true
  echo "${PROXY_IP} ${PROXY_DNS}" | sudo tee -a /etc/hosts >/dev/null
fi

sudo resolvectl flush-caches >/dev/null 2>&1 || true

GRPC_ADDR="${PLATFORM_DNS}:8081"
GRPC_HOST="${PLATFORM_DNS}"
PROXY_HOSTNAME="${PROXY_DNS}"

log "Preview endpoints configured:"
log "  gRPC: ${GRPC_ADDR}"
log "  Proxy: ${PROXY_HOSTNAME}"
log "  CA bundle: ${CA_BUNDLE}"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "grpc_addr=${GRPC_ADDR}"
    echo "grpc_host=${GRPC_HOST}"
    echo "proxy_hostname=${PROXY_HOSTNAME}"
    echo "grpc_ca=${CA_BUNDLE}"
  } >> "${GITHUB_OUTPUT}"
fi
