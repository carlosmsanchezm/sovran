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

TERRAFORM_DIR="${TERRAFORM_DIR:-cloud-terraform/terraform}"
CA_BUNDLE="${CA_BUNDLE:-${HOME}/aegis-platform-api-ca.crt}"

MANAGED_KEYCLOAK_BASE_URL="${MANAGED_KEYCLOAK_BASE_URL:-${KEYCLOAK_BASE_URL:-}}"
MANAGED_KEYCLOAK_REALM="${MANAGED_KEYCLOAK_REALM:-${KEYCLOAK_REALM:-aegis}}"
DEFAULT_KEYCLOAK_BASE_URL="${DEFAULT_KEYCLOAK_BASE_URL:-https://keycloak.aegis.dev}"
MANAGED_KEYCLOAK_DISABLED=0

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

if [[ -n "${MANAGED_KEYCLOAK_BASE_URL}" ]]; then
  managed_host=$(python3 - <<'PY' "${MANAGED_KEYCLOAK_BASE_URL}"
import sys
from urllib.parse import urlparse

base = sys.argv[1].strip()
if not base:
    print("")
    sys.exit(0)
if not base.startswith(("http://", "https://")):
    base = "https://" + base
parsed = urlparse(base)
print((parsed.hostname or "").strip())
PY
)
  if [[ -z "${managed_host}" ]]; then
    log "Managed Keycloak base URL '${MANAGED_KEYCLOAK_BASE_URL}' is invalid; ignoring and falling back to cluster Keycloak"
    MANAGED_KEYCLOAK_BASE_URL=""
  else
    dig_result="$(dig +short "${managed_host}" | head -n1 || true)"
    if [[ -z "${dig_result}" ]]; then
      log "Managed Keycloak host ${managed_host} did not resolve; falling back to cluster Keycloak"
      MANAGED_KEYCLOAK_BASE_URL=""
      MANAGED_KEYCLOAK_DISABLED=1
    fi
  fi
fi

PLATFORM_LB="$(wait_for_lb "${HELM_RELEASE}-platform-api" "${K8S_NAMESPACE}")"
PROXY_LB="$(wait_for_lb "${HELM_RELEASE}-proxy" "${K8S_NAMESPACE}")"

KEYCLOAK_LB=""
KEYCLOAK_PORT=""
KEYCLOAK_SCHEME="https"

if [[ -z "${MANAGED_KEYCLOAK_BASE_URL}" ]]; then
  # Keycloak may be deployed in a dedicated namespace; try release namespace first, then fallback
  KEYCLOAK_LB="$(wait_for_lb "${HELM_RELEASE}-keycloak" "${K8S_NAMESPACE}")"
  if [[ -z "${KEYCLOAK_LB}" ]]; then
    KEYCLOAK_LB="$(wait_for_lb "${HELM_RELEASE}-keycloak" "keycloak")"
  fi

  if kubectl get svc "${HELM_RELEASE}-keycloak" -n "${K8S_NAMESPACE}" >/dev/null 2>&1; then
    KEYCLOAK_PORT="$(kubectl get svc "${HELM_RELEASE}-keycloak" -n "${K8S_NAMESPACE}" -o jsonpath='{.spec.ports[0].port}' 2>/dev/null || echo "")"
  elif kubectl get svc "${HELM_RELEASE}-keycloak" -n keycloak >/dev/null 2>&1; then
    KEYCLOAK_PORT="$(kubectl get svc "${HELM_RELEASE}-keycloak" -n keycloak -o jsonpath='{.spec.ports[0].port}' 2>/dev/null || echo "")"
  fi

  if [[ -z "${KEYCLOAK_PORT}" ]]; then
    KEYCLOAK_PORT="8080"
  fi

  if [[ "${KEYCLOAK_PORT}" == "443" ]]; then
    KEYCLOAK_SCHEME="https"
  else
    KEYCLOAK_SCHEME="http"
  fi

  if [[ -z "${KEYCLOAK_LB}" ]]; then
    if [[ "${MANAGED_KEYCLOAK_DISABLED}" -eq 1 ]]; then
      log "Managed Keycloak unavailable and no cluster Keycloak service detected; keycloak authority will remain unset"
    else
      MANAGED_KEYCLOAK_BASE_URL="${DEFAULT_KEYCLOAK_BASE_URL}"
      MANAGED_KEYCLOAK_REALM="${MANAGED_KEYCLOAK_REALM:-aegis}"
      log "Keycloak service not detected; defaulting to managed issuer ${MANAGED_KEYCLOAK_BASE_URL}"
    fi
  fi
else
  log "Using managed Keycloak endpoint: ${MANAGED_KEYCLOAK_BASE_URL} (realm ${MANAGED_KEYCLOAK_REALM})"
fi

if [[ -z "${PLATFORM_LB}" || -z "${PROXY_LB}" ]]; then
  log "Failed to resolve LoadBalancer hostnames"
  exit 1
fi

log "Updating Route53 records with actual hostnames"
pushd "${TERRAFORM_DIR}" >/dev/null
apply_cmd=(
  terraform apply -auto-approve -lock-timeout=5m \
    -var="platform_api_lb_hostname=${PLATFORM_LB}" \
    -var="proxy_lb_hostname=${PROXY_LB}" \
    -target=aws_route53_record.platform_api_grpc \
    -target=aws_route53_record.platform_api_http \
    -target=aws_route53_record.proxy
)

if [[ -n "${KEYCLOAK_LB}" ]]; then
  apply_cmd+=( -var="keycloak_lb_hostname=${KEYCLOAK_LB}" -var="manage_keycloak_dns=true" -target=aws_route53_record.keycloak )
fi

${apply_cmd[@]}

PLATFORM_DNS="$(terraform output -raw dns_platform_api_grpc 2>/dev/null || echo "")"
PROXY_DNS="$(terraform output -raw dns_proxy 2>/dev/null || echo "")"
KEYCLOAK_DNS="$(terraform output -raw dns_keycloak 2>/dev/null || echo "")"
popd >/dev/null

PLATFORM_DNS="${PLATFORM_DNS%.}"
PROXY_DNS="${PROXY_DNS%.}"
KEYCLOAK_DNS="${KEYCLOAK_DNS%.}"

if [[ -n "${MANAGED_KEYCLOAK_BASE_URL}" ]]; then
  managed_parse_output=$(python3 - <<'PY' "${MANAGED_KEYCLOAK_BASE_URL}" "${MANAGED_KEYCLOAK_REALM}"
import sys
from urllib.parse import urlparse

base = sys.argv[1].strip()
realm = sys.argv[2].strip() or "aegis"

if not base:
    print("Managed Keycloak base URL is empty", file=sys.stderr)
    sys.exit(1)

if not base.startswith(("http://", "https://")):
    base = "https://" + base

parsed = urlparse(base)
scheme = parsed.scheme or "https"
host = parsed.hostname or ""

if not host:
    print("Unable to parse Keycloak host from base URL", file=sys.stderr)
    sys.exit(1)

default_port = 443 if scheme == "https" else 80
port = parsed.port or default_port

path = (parsed.path or "").rstrip("/")
realm_path = f"/realms/{realm}".rstrip("/")

if not path:
    authority_path = realm_path
else:
    lower_path = path.lower()
    lower_realm = realm_path.lower()
    if lower_path.endswith(lower_realm):
        authority_path = path
    else:
        separator = "" if path.endswith("/") else "/"
        authority_path = f"{path}{separator}{realm_path.lstrip('/')}"

authority = f"{scheme}://{host}"
if port != default_port:
    authority += f":{port}"
authority += authority_path

print(f"{scheme} {host} {port} {authority.rstrip('/')}")
PY
  ) || exit 1

  read -r KEYCLOAK_SCHEME KEYCLOAK_HOST_FROM_BASE KEYCLOAK_PORT KEYCLOAK_AUTHORITY <<<"${managed_parse_output}"
  KEYCLOAK_DNS="${KEYCLOAK_HOST_FROM_BASE}"
fi

if [[ -z "${PLATFORM_DNS}" || -z "${PROXY_DNS}" ]]; then
  log "Terraform did not return DNS records"
  exit 1
fi

if [[ -n "${KEYCLOAK_LB}" && -z "${KEYCLOAK_DNS}" ]]; then
  log "Terraform did not return keycloak DNS record"
fi

log "Route53 updated:"
log "  ${PLATFORM_DNS} → ${PLATFORM_LB}"
log "  ${PROXY_DNS} → ${PROXY_LB}"
if [[ -n "${KEYCLOAK_LB}" && -n "${KEYCLOAK_DNS}" ]]; then
  log "  ${KEYCLOAK_DNS} → ${KEYCLOAK_LB}"
fi

if [[ -z "${MANAGED_KEYCLOAK_BASE_URL}" ]]; then
  KEYCLOAK_AUTHORITY=""
  if [[ -n "${KEYCLOAK_DNS}" ]]; then
    KEYCLOAK_AUTHORITY="${KEYCLOAK_SCHEME}://${KEYCLOAK_DNS}"
    if [[ "${KEYCLOAK_SCHEME}" == "http" && "${KEYCLOAK_PORT}" != "80" ]]; then
      KEYCLOAK_AUTHORITY+=":${KEYCLOAK_PORT}"
    elif [[ "${KEYCLOAK_SCHEME}" == "https" && "${KEYCLOAK_PORT}" != "443" && -n "${KEYCLOAK_PORT}" ]]; then
      KEYCLOAK_AUTHORITY+=":${KEYCLOAK_PORT}"
    fi
    KEYCLOAK_AUTHORITY+="/realms/aegis"
  fi
fi

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
KEYCLOAK_IP=""
if [[ -n "${MANAGED_KEYCLOAK_BASE_URL}" && -n "${KEYCLOAK_DNS}" ]]; then
  managed_keycloak_ip="$(pick_reachable_ip "${KEYCLOAK_DNS}" "${KEYCLOAK_PORT}")"
  if [[ -n "${managed_keycloak_ip}" ]]; then
    log "  Managed Keycloak reachable at ${managed_keycloak_ip}:${KEYCLOAK_PORT}"
  else
    log "  Managed Keycloak still unreachable; disabling managed Keycloak for this run"
    MANAGED_KEYCLOAK_BASE_URL=""
    MANAGED_KEYCLOAK_DISABLED=1
  fi
  KEYCLOAK_IP="${managed_keycloak_ip}"
elif [[ -n "${KEYCLOAK_LB}" ]]; then
  KEYCLOAK_IP="$(pick_reachable_ip "${KEYCLOAK_LB}" "${KEYCLOAK_PORT}")"
fi

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

if [[ -n "${KEYCLOAK_IP}" && -n "${KEYCLOAK_DNS}" && -z "${MANAGED_KEYCLOAK_BASE_URL}" ]]; then
  log "  Keycloak IP: ${KEYCLOAK_IP}"
  sudo sed -i.bak "/${KEYCLOAK_DNS}/d" /etc/hosts 2>/dev/null || true
  echo "${KEYCLOAK_IP} ${KEYCLOAK_DNS}" | sudo tee -a /etc/hosts >/dev/null
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
    echo "keycloak_hostname=${KEYCLOAK_DNS}"
    echo "keycloak_ip=${KEYCLOAK_IP}"
    echo "keycloak_port=${KEYCLOAK_PORT}"
    echo "keycloak_scheme=${KEYCLOAK_SCHEME}"
    echo "keycloak_authority=${KEYCLOAK_AUTHORITY}"
  } >> "${GITHUB_OUTPUT}"
fi
