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
need timeout

log() {
  printf '[configure-preview] %s\n' "$*" >&2
}

check_tcp() {
  local ip="$1"
  local port="$2"
  if command -v nc >/dev/null 2>&1; then
    nc -z -w3 "$ip" "$port" >/dev/null 2>&1
  else
    timeout 3 bash -c "cat < /dev/null > /dev/tcp/${ip}/${port}" >/dev/null 2>&1
  fi
}

pick_reachable_ip() {
  local host="$1"
  local port="$2"
  local attempts="${3:-20}"
  local delay="${4:-3}"

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    local ips
    ips=$(dig +short "$host" | sort -u)
    if [[ -z "${ips}" ]]; then
      log "  Attempt ${attempt}/${attempts}: dig returned no IPs for ${host}"
    fi
    for ip in $ips; do
      if [[ -z "${ip}" ]]; then
        continue
      fi
      if check_tcp "$ip" "$port"; then
        if [[ "${attempt}" -gt 1 ]]; then
          log "  Found reachable IP ${ip} for ${host}:${port} on attempt ${attempt}"
        fi
        echo "$ip"
        return 0
      fi
      log "  Attempt ${attempt}/${attempts}: ${ip}:${port} not reachable yet"
    done
    if [[ "${attempt}" -lt "${attempts}" ]]; then
      sleep "${delay}"
    fi
  done

  log "  Exhausted ${attempts} attempts without finding reachable IP for ${host}:${port}"
  echo ""
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

TARGET_PROXY_BASE="wss://${PROXY_DNS}:8080"
log "Ensuring platform-api uses ${TARGET_PROXY_BASE} for proxy tickets"
kubectl -n "${K8S_NAMESPACE}" set env deployment/"${HELM_RELEASE}-platform-api" \
  AEGIS_PROXY_BASE_URL="${TARGET_PROXY_BASE}" --overwrite >/dev/null
kubectl -n "${K8S_NAMESPACE}" rollout status deployment/"${HELM_RELEASE}-platform-api" --timeout=2m
log "  platform-api rollout complete with updated proxy base URL"

if [[ -n "${PROXY_CLUSTER_ID:-}" ]]; then
  log "Ensuring proxy advertises cluster ${PROXY_CLUSTER_ID}"
  kubectl -n "${K8S_NAMESPACE}" set env deployment/"${HELM_RELEASE}-proxy" \
    AEGIS_PROXY_CLUSTER="${PROXY_CLUSTER_ID}" --overwrite >/dev/null
  kubectl -n "${K8S_NAMESPACE}" rollout status deployment/"${HELM_RELEASE}-proxy" --timeout=2m
  log "  proxy rollout complete with updated cluster ID"
else
  log "PROXY_CLUSTER_ID not set; skipping proxy cluster env update"
fi

log "Resolving LoadBalancer IPs for local /etc/hosts overrides"
PLATFORM_IP="$(pick_reachable_ip "${PLATFORM_LB}" 8081)"
PROXY_IP="$(pick_reachable_ip "${PROXY_LB}" 8080)"

if [[ -z "${PLATFORM_IP}" ]]; then
  PLATFORM_IP="$(dig +short "${PLATFORM_LB}" | head -1)"
  if [[ -n "${PLATFORM_IP}" ]]; then
    log "  No reachable platform IP detected; falling back to first IP ${PLATFORM_IP}"
  fi
fi

if [[ -z "${PROXY_IP}" ]]; then
  PROXY_IP="$(dig +short "${PROXY_LB}" | head -1)"
  if [[ -n "${PROXY_IP}" ]]; then
    log "  No reachable proxy IP detected; falling back to first IP ${PROXY_IP}"
  fi
fi

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
    echo "platform_dns=${PLATFORM_DNS}"
    echo "platform_ip=${PLATFORM_IP}"
    echo "proxy_dns=${PROXY_DNS}"
    echo "proxy_ip=${PROXY_IP}"
  } >> "${GITHUB_OUTPUT}"
fi
