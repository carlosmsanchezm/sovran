# Aegis Deployment Modes

This document explains the different deployment configurations and how to use them.

## Deployment Modes

### 1. **Local Development** (no TLS)
**Use case**: Local Kubernetes cluster (minikube, kind, Docker Desktop)

```bash
cd terraform
./generate-helm-values.sh
```

**Configuration**:
- Platform API: HTTP on port 8080, insecure gRPC on 8081
- Proxy: HTTP WebSocket (no TLS)
- No certificates required
- Services use ClusterIP (accessed via kubectl port-forward)

**VSCode Extension Settings**:
```json
{
  "aegisRemote.platform.grpcEndpoint": "localhost:8081",
  "aegisRemote.security.rejectUnauthorized": false
}
```

---

### 2. **Cloud with TLS** (recommended for production-like testing)
**Use case**: AWS EKS with LoadBalancers and TLS

```bash
cd terraform
./generate-helm-values.sh --tls
```

**Configuration**:
- Platform API: TLS-enabled gRPC on port 8081
- Proxy: TLS-enabled WebSocket on port 8080
- Self-signed certificates with DNS SANs
- LoadBalancer services with Route53 DNS
- Auto-updates /etc/hosts for local resolution

**VSCode Extension Settings**:
```json
{
  "aegisRemote.platform.grpcEndpoint": "platform-api-grpc.aegist.dev:8081",
  "aegisRemote.security.caPath": "/Users/YOUR_USERNAME/aegis-platform-api-ca.crt",
  "aegisRemote.security.rejectUnauthorized": true
}
```

**What happens**:
1. Generates TLS certificates with SANs: `platform-api-grpc.aegist.dev`, `proxy.aegist.dev`
2. Updates `/etc/hosts` with LoadBalancer IPs
3. Deploys with `values-cloud.yaml` + `values-cloud-tls.yaml`
4. Sets `AEGIS_PROXY_BASE_URL=wss://proxy.aegist.dev:8080`
5. Uses proxy image tag `no-client-cert` (server-side TLS only, no mTLS)

---

### 3. **Cloud without TLS** (for debugging)
**Use case**: Cloud deployment but want to avoid TLS complexity

```bash
cd terraform
./generate-helm-values.sh
# Don't use --tls flag
```

**Configuration**:
- Platform API: Insecure gRPC on port 8081
- Proxy: HTTP WebSocket (no TLS)
- LoadBalancer services
- No certificates

**VSCode Extension Settings**:
```json
{
  "aegisRemote.platform.grpcEndpoint": "a2359cd286b834952ae64c73e797f6c9-eddab4c24f09b0fd.elb.us-east-1.amazonaws.com:8081",
  "aegisRemote.security.rejectUnauthorized": false
}
```

---

## Key Configuration Files

### Always Applied
- `values-cloud.yaml` - Base cloud configuration (LoadBalancer, resources, replicas)
- `values-cloud-generated.yaml` - Auto-generated from Terraform (DB, ECR, secrets)

### Conditional (--tls flag)
- `values-cloud-tls.yaml` - TLS overlay (enables TLS for platform-api and proxy)

### Important Settings

#### Proxy Image Tags
- `no-client-cert` - Server-side TLS only (for VSCode extension compatibility)
- `latest` - May require client certificates (not compatible with current extension)

#### Platform API Environment
- `AEGIS_PROXY_BASE_URL` - Must match deployment mode:
  - Local: `ws://aegis-proxy.aegis-system.svc.cluster.local:8080`
  - Cloud no-TLS: `ws://${PROXY_LB}:8080`
  - Cloud TLS: `wss://proxy.aegist.dev:8080`

---

## Switching Between Modes

### From Cloud to Local
```bash
# Stop cloud resources
cd terraform
terraform destroy

# Deploy locally
./generate-helm-values.sh  # without --tls
```

### From Local to Cloud
```bash
# Provision AWS resources
cd terraform
terraform apply

# Deploy with TLS
./generate-helm-values.sh --tls
```

### Updating TLS Certificates
If LoadBalancer IPs change, rerun:
```bash
cd terraform
./generate-helm-values.sh --tls
```

This will:
- Regenerate certificates
- Update /etc/hosts
- Update Route53 DNS records
- Redeploy with new configuration

---

## Troubleshooting

### "unable to get local issuer certificate"
- **Cause**: Proxy requires client certificates (mTLS)
- **Fix**: Ensure proxy uses `no-client-cert` image tag
- **Verify**: `kubectl get deployment aegis-proxy -n aegis-system -o jsonpath='{.spec.template.spec.containers[0].image}'`

### "Name resolution failed for target dns:platform-api-grpc.aegist.dev"
- **Cause**: DNS not resolving locally
- **Fix**: Check `/etc/hosts` has entry for `platform-api-grpc.aegist.dev`
- **Verify**: `ping platform-api-grpc.aegist.dev`

### "Hostname/IP does not match certificate's altnames"
- **Cause**: Certificate doesn't include the hostname you're connecting to
- **Fix**: Use hostname in certificate SANs (`platform-api-grpc.aegist.dev` or `proxy.aegist.dev`)
- **Verify**: `openssl x509 -in ~/aegis-platform-api-ca.crt -text -noout | grep DNS:`

### WorkloadConnection fails but platform-api works
- **Cause**: Proxy URL is wrong or proxy is unreachable
- **Fix 1**: Verify `AEGIS_PROXY_BASE_URL` in platform-api deployment
- **Fix 2**: Add proxy IP to /etc/hosts for `proxy.aegist.dev`
- **Verify**: `kubectl get deployment aegis-platform-api -n aegis-system -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="AEGIS_PROXY_BASE_URL")].value}'`

---

## Automation

The `generate-helm-values.sh` script automatically:
1. Detects deployment mode (local vs cloud, TLS vs no-TLS)
2. Generates appropriate certificates (TLS mode only)
3. Updates /etc/hosts with current LoadBalancer IPs (TLS mode only)
4. Updates Route53 DNS records (TLS mode only)
5. Deploys with correct Helm values
6. Validates deployment and shows connection instructions

**The script is the single source of truth for deployment configuration.**
