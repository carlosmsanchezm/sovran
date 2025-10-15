# Proxy Integration with Platform API

## Overview

The platform-api requires proxy configuration to create secure connection sessions for workloads. This document explains how the automatic integration works.

## Automatic Configuration

When both `platformApi.enabled=true` and `proxy.enabled=true` in your helm values, the following happens automatically:

### 1. JWT Secret Sharing

The platform-api deployment automatically mounts the same JWT secret that the proxy uses:

```yaml
# Automatically added to platform-api deployment
- name: AEGIS_PROXY_JWT_SECRET
  valueFrom:
    secretKeyRef:
      name: aegis-proxy-secret  # References the proxy's secret
      key: jwt-secret
```

**Why**: The platform-api mints connection tokens that the proxy validates. Both services must use the same signing key.

### 2. Proxy Base URL

If `AEGIS_PROXY_BASE_URL` is not explicitly set in `platformApi.env`, it defaults to the internal service DNS:

```yaml
# Automatically added to platform-api deployment
- name: AEGIS_PROXY_BASE_URL
  value: "http://aegis-proxy.aegis-system.svc.cluster.local:8080"
```

**Why**: For same-cluster deployments, platform-api communicates with the proxy via internal service DNS (faster, no external network hops).

## Configuration Options

### Same-Cluster Deployment (Default)

No manual configuration needed! Just enable both services:

```yaml
# charts/aegis-services/values/cloud.yaml
platformApi:
  enabled: true

proxy:
  enabled: true
  jwtSecret: "your-random-64-char-secret"  # This is shared with platform-api automatically
```

### External Proxy (Different Cluster)

If the proxy runs in a different cluster, override the base URL:

```yaml
platformApi:
  enabled: true
  env:
    AEGIS_PROXY_BASE_URL: "https://proxy.yourdomain.com"  # External public URL

proxy:
  enabled: false  # Proxy runs elsewhere
```

Then manually configure the platform-api to use the external proxy's JWT secret:

```yaml
platformApi:
  secrets:
    proxy-jwt-secret: "same-secret-as-external-proxy"
  envFromSecret:
    AEGIS_PROXY_JWT_SECRET: "proxy-jwt-secret"
```

## Implementation Details

### Files Modified

1. **templates/platform-api-deployment.yaml**
   - Added automatic `AEGIS_PROXY_JWT_SECRET` from proxy secret
   - Added automatic `AEGIS_PROXY_BASE_URL` defaulting logic

2. **values/cloud.yaml**
   - Removed manual `AEGIS_PROXY_JWT_SECRET` from `envFromSecret`
   - Removed placeholder `AEGIS_PROXY_BASE_URL` from `env`
   - Added documentation comments

3. **CLUSTER_CONFIGURATION.md**
   - Added "Proxy Configuration" section explaining automatic setup

## Verification

After deploying, verify the configuration:

```bash
# Check that platform-api has the proxy JWT secret
kubectl exec -n aegis-system deployment/aegis-platform-api -- \
  sh -c 'echo -n $AEGIS_PROXY_JWT_SECRET | wc -c'
# Should output: 64 (or your secret length)

# Check that platform-api has the proxy base URL
kubectl exec -n aegis-system deployment/aegis-platform-api -- \
  printenv AEGIS_PROXY_BASE_URL
# Should output: http://aegis-proxy.aegis-system.svc.cluster.local:8080

# Test creating a connection session via Backstage UI
# Click "Connect" on any running workload
# Should succeed without "proxy configuration not available" error
```

## Troubleshooting

### Error: "proxy configuration not available"

**Cause**: Platform-api doesn't have `AEGIS_PROXY_BASE_URL` or `AEGIS_PROXY_JWT_SECRET` set.

**Fix**:
1. Verify `proxy.enabled=true` in helm values
2. Redeploy: `helm upgrade aegis charts/aegis-services -n aegis-system -f charts/aegis-services/values/common.yaml -f charts/aegis-services/values/cloud.yaml`
3. Verify env vars as shown above

### Error: "invalid token signature"

**Cause**: Platform-api and proxy are using different JWT secrets.

**Fix**:
1. Ensure both use the same `proxy.jwtSecret` value
2. Redeploy both services to pick up the correct secret

## Migration from Manual Configuration

If you previously configured the proxy manually (via kubectl patch or manual secrets), follow these steps:

1. **Remove manual patches**:
   ```bash
   # The helm deployment will override these
   kubectl rollout restart deployment/aegis-platform-api -n aegis-system
   ```

2. **Update helm values**:
   - Remove `AEGIS_PROXY_BASE_URL` from `platformApi.env`
   - Remove `AEGIS_PROXY_JWT_SECRET` from `platformApi.envFromSecret`
   - Ensure `proxy.enabled=true` and `proxy.jwtSecret` is set

3. **Redeploy**:
   ```bash
   helm upgrade aegis charts/aegis-services -n aegis-system \
     -f charts/aegis-services/values/common.yaml \
     -f charts/aegis-services/values/cloud.yaml
   ```

4. **Verify**: Follow verification steps above

## Security Considerations

- **JWT Secret Rotation**: When rotating the proxy JWT secret, update `proxy.jwtSecret` in helm values and redeploy both proxy and platform-api
- **Secret Storage**: Store `proxy.jwtSecret` in a secure secret manager (AWS Secrets Manager, HashiCorp Vault, etc.) and inject via CI/CD
- **Never commit secrets**: Use `--set-string` or external secret operators instead of committing secrets to git
