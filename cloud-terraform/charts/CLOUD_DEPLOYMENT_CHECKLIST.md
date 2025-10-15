# Cloud Deployment Checklist

## Prerequisites

### 1. ECR Image Registry
- ✅ ECR Repository: `567751785679.dkr.ecr.us-east-1.amazonaws.com`
- ✅ Images tagged and pushed:
  - `aegis/platform-api:latest`
  - `aegis/proxy:latest`

### 2. Kubernetes Cluster
- [ ] EKS cluster provisioned
- [ ] kubectl configured to access cluster
- [ ] Helm 3.x installed

### 3. DNS Configuration
- [ ] Domain configured (replace `yourdomain.com` in values files)
- [ ] DNS records for:
  - `platform-api.yourdomain.com` → Platform API HTTP
  - `platform-api-grpc.yourdomain.com` → Platform API gRPC
  - `proxy.yourdomain.com` → Proxy service

### 4. TLS Certificates
- [ ] cert-manager installed in cluster
- [ ] Let's Encrypt ClusterIssuer configured (`letsencrypt-prod`)
- OR manually provision TLS certificates

### 5. Database (PostgreSQL)
- [ ] RDS PostgreSQL instance created
- [ ] Database `aegis` created
- [ ] User `aegis_api` with appropriate permissions
- [ ] Connection details noted:
  - Host: `aegis-prod-rds.cluster-xxxx.us-east-1.rds.amazonaws.com`
  - Port: `5432`
  - SSL mode: `require`

## Configuration Updates Needed

### charts/aegis-services/values/cloud.yaml

#### Platform API
1. **Ingress Hosts** (lines 31-45):
   - Replace `platform-api.yourdomain.com` with your actual domain
   - Replace `platform-api-grpc.yourdomain.com` with your actual domain

2. **Database Configuration** (lines 54-58):
   - Update `DB_HOST` with your RDS endpoint
   - Verify `DB_PORT`, `DB_NAME`, `DB_USER`

3. **Proxy Configuration** (line 52):
   - Update `AEGIS_PROXY_BASE_URL` with your proxy domain

4. **Secrets** (lines 64-76):
   - Set via `--set-string` or external secret manager:
     ```bash
     --set-string platformApi.secrets.db-password="<password>" \
     --set-string platformApi.secrets.proxy-jwt-secret="<32-char-secret>"
     ```

5. **Kubeconfigs Volume** (lines 78-86):
   - Create secret with spoke cluster kubeconfigs:
     ```bash
     kubectl create secret generic aegis-kubeconfigs \
       --from-file=spoke1.kubeconfig \
       --from-file=spoke2.kubeconfig
     ```

#### Proxy
1. **Ingress Hosts** (lines 183-190):
   - Replace `proxy.yourdomain.com` with your actual domain

2. **JWT Secret** (line 193):
   - Must match Platform API JWT secret (32+ chars)
   - Set via `--set-string proxy.jwtSecret="<same-32-char-secret>"`

3. **TLS Certificates** (lines 209-211):
   - Option A: Let cert-manager handle it (recommended)
   - Option B: Provide via `--set-file`:
     ```bash
     --set-file proxy.tls.cert=/path/to/cert.pem \
     --set-file proxy.tls.key=/path/to/key.pem
     ```

4. **Public Host** (line 197):
   - Update to match your proxy domain

### aegis-spoke/values-cloud.yaml

1. **k8sAgent.env.AEGIS_CP_GRPC** (line 5):
   - Update service name if deploying to different namespace
   - Format: `<service>.<namespace>.svc.cluster.local:8081`

2. **k8sAgent.env.AEGIS_PROXY_INGRESS_HOST** (line 6):
   - Update to your proxy domain

## Deployment Commands

### 1. Deploy aegis-services (Hub/Control Plane)

```bash
# Set your values
DOMAIN="yourdomain.com"
DB_PASSWORD="<your-db-password>"
JWT_SECRET="<your-32-char-jwt-secret>"
DB_HOST="<your-rds-endpoint>"

# Install/Upgrade
helm upgrade --install aegis-services ./charts/aegis-services \
  -f ./charts/aegis-services/values/common.yaml \
  -f ./charts/aegis-services/values/cloud.yaml \
  --set-string platformApi.ingress.hosts[0].host="platform-api.${DOMAIN}" \
  --set-string platformApi.ingress.hosts[1].host="platform-api-grpc.${DOMAIN}" \
  --set-string platformApi.ingress.tls[0].hosts[0]="platform-api.${DOMAIN}" \
  --set-string platformApi.ingress.tls[0].hosts[1]="platform-api-grpc.${DOMAIN}" \
  --set-string platformApi.env.DB_HOST="${DB_HOST}" \
  --set-string platformApi.env.AEGIS_PROXY_BASE_URL="https://proxy.${DOMAIN}" \
  --set-string platformApi.secrets.db-password="${DB_PASSWORD}" \
  --set-string platformApi.secrets.proxy-jwt-secret="${JWT_SECRET}" \
  --set-string proxy.ingress.hosts[0].host="proxy.${DOMAIN}" \
  --set-string proxy.ingress.tls[0].hosts[0]="proxy.${DOMAIN}" \
  --set-string proxy.jwtSecret="${JWT_SECRET}" \
  --set-string proxy.publicHost="proxy.${DOMAIN}" \
  --namespace aegis-system \
  --create-namespace
```

### 2. Deploy aegis-spoke (Workload Cluster)

```bash
# Set your values
DOMAIN="yourdomain.com"
CP_GRPC_ENDPOINT="aegis-services-platform-api.aegis-system.svc.cluster.local:8081"
PROXY_HOST="proxy.${DOMAIN}"

# Install/Upgrade
helm upgrade --install aegis-spoke ./charts/aegis-spoke \
  -f ./charts/aegis-spoke/values-cloud.yaml \
  --set-string k8sAgent.env.AEGIS_CP_GRPC="${CP_GRPC_ENDPOINT}" \
  --set-string k8sAgent.env.AEGIS_PROXY_INGRESS_HOST="${PROXY_HOST}" \
  --namespace aegis-system \
  --create-namespace
```

## Post-Deployment Verification

### 1. Check Pods
```bash
kubectl get pods -n aegis-system
```

### 2. Check Services
```bash
kubectl get svc -n aegis-system
```

### 3. Check Ingress
```bash
kubectl get ingress -n aegis-system
```

### 4. Test Platform API
```bash
# HTTP endpoint
curl https://platform-api.${DOMAIN}/healthz

# gRPC endpoint (requires grpcurl)
grpcurl platform-api-grpc.${DOMAIN}:443 aegis.v1.AegisPlatform/ListWorkloads
```

### 5. Test Proxy
```bash
curl -v https://proxy.${DOMAIN}/proxy
```

## Local Values (Locked & Working)

The following local values files are confirmed working:

### charts/aegis-services/values/local.yaml
- ✅ Platform API on port 8080 (HTTP) and 8081 (gRPC)
- ✅ Proxy on port 8085 with TLS enabled
- ✅ JWT secret: `a-very-secret-key-for-local-dev-must-be-32-chars`
- ✅ Static auth: `dev-user@example.com` / `supersecret`
- ✅ Port-forward for access (no ingress needed)

### charts/aegis-spoke/values-local.yaml
- ✅ k8sAgent connects to: `aegis-services-aegis-services-platform-api.default.svc.cluster.local:8081`
- ✅ Proxy ingress: `localhost:10085`
- ✅ Spoke proxy disabled (uses hub proxy)

## Notes

1. **JWT Secret**: Must be 32+ characters and match between Platform API and Proxy
2. **TLS**: Proxy always uses TLS (self-signed for local, cert-manager/manual for cloud)
3. **Database**: Platform API requires PostgreSQL in cloud (uses in-memory for local)
4. **Namespaces**:
   - Control plane: `aegis-system`
   - Workloads: `aegis-workloads` or configured via `targetNamespace`
5. **Health Checks**: Local has probes disabled; cloud has full liveness/readiness probes
6. **Security Context**: Cloud has strict security contexts; local is relaxed
