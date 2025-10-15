# Aegis Services Helm Chart

A unified Helm chart for deploying Aegis platform-api and proxy microservices in both local and cloud environments.

## Overview

This chart provides a streamlined, configurable deployment process for:
- **Platform API**: The central API service for managing Aegis workloads
- **Proxy**: The authentication proxy for secure access to workloads

## Quick Start

### Local Development

For local development with minikube, kind, or Docker Desktop:

```bash
# Install with local configuration
helm install aegis-services ./charts/aegis-services \
  -f ./charts/aegis-services/values/common.yaml \
  -f ./charts/aegis-services/values/local.yaml

# Access services (with ingress controller)
curl http://platform-api.localtest.me:8080/healthz
curl http://proxy.localtest.me/proxy/
```

### Cloud Deployment

For production deployment on cloud platforms:

```bash
# Install with cloud configuration
helm install aegis-services ./charts/aegis-services \
  -f ./charts/aegis-services/values/common.yaml \
  -f ./charts/aegis-services/values/cloud.yaml \
  --set-string platformApi.secrets.db-password="your-secret" \
  --set-string proxy.jwtSecret="your-jwt-secret-32-chars-min" \
  --set-file proxy.tls.cert=/path/to/cert.pem \
  --set-file proxy.tls.key=/path/to/key.pem
```

## Configuration

### Service Control

You can enable or disable individual services:

```yaml
# Deploy only platform-api
platformApi:
  enabled: true
proxy:
  enabled: false
```

### Environment-Specific Values

The chart includes layered values files:

1. **`values/common.yaml`** – Shared defaults (also exposed as `values.yaml` for Helm compatibility)
2. **`values/local.yaml`** – Optimized overrides for local development
3. **`values/cloud.yaml`** – Production-ready cloud configuration

## Platform API Configuration

### Basic Configuration

```yaml
platformApi:
  enabled: true
  replicaCount: 1

  image:
    repository: aegis/platform-api
    tag: "latest"
    pullPolicy: IfNotPresent

  service:
    type: ClusterIP
    grpcPort: 8081
    httpPort: 8080
```

### Environment Variables

```yaml
platformApi:
  # Direct environment variables
  env:
    LOG_LEVEL: "debug"
    CUSTOM_VAR: "value"

  # Environment variables from secrets
  envFromSecret:
    DATABASE_PASSWORD: "db-password"

  # Application-specific configuration
  kubeConfigsDir: "/tmp/kubeconfigs"
  targetNamespace: "default"
```

### Ingress Configuration

```yaml
platformApi:
  ingress:
    enabled: true
    className: "nginx"
    annotations:
      cert-manager.io/cluster-issuer: "letsencrypt-prod"
    hosts:
      - host: platform-api.yourdomain.com
        paths:
          - path: /
            pathType: Prefix
            service: "http"  # or "grpc"
    tls:
      - secretName: platform-api-tls
        hosts:
          - platform-api.yourdomain.com
```

## Proxy Configuration

### Basic Configuration

```yaml
proxy:
  enabled: true
  replicaCount: 1

  image:
    repository: aegis/proxy
    tag: "latest"
    pullPolicy: IfNotPresent

  service:
    type: ClusterIP
    port: 8080
```

### Proxy-Specific Settings

```yaml
proxy:
  jwtSecret: "your-jwt-secret-32-chars-minimum"
  expectedAudience: "aegis-proxy"
  allowedSuffix: ".svc.cluster.local"
  cluster: "prod-cluster-1"
  publicHost: "proxy.yourdomain.com"
```

### TLS Configuration

```yaml
proxy:
  tls:
    enabled: true
    cert: ""  # Set via --set-file proxy.tls.cert=/path/to/cert
    key: ""   # Set via --set-file proxy.tls.key=/path/to/key
```

## Security Configuration

### Pod Security Context

```yaml
platformApi:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    fsGroup: 2000

  containerSecurityContext:
    allowPrivilegeEscalation: false
    capabilities:
      drop: [ALL]
    readOnlyRootFilesystem: true
    runAsNonRoot: true
    runAsUser: 1000
```

### Secrets Management

Create secrets via values:

```yaml
platformApi:
  secrets:
    db-password: "secret-value"
    api-key: "api-secret"
```

Or reference existing secrets:

```yaml
platformApi:
  envFromSecret:
    DATABASE_PASSWORD: "db-password"  # References secret key
```

## Resource Management

### Resource Limits

```yaml
platformApi:
  resources:
    limits:
      cpu: "1000m"
      memory: "1Gi"
    requests:
      cpu: "500m"
      memory: "512Mi"
```

### High Availability

```yaml
platformApi:
  replicaCount: 3
  affinity:
    podAntiAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            labelSelector:
              matchExpressions:
                - key: app.kubernetes.io/component
                  operator: In
                  values: [platform-api]
            topologyKey: topology.kubernetes.io/zone
```

## Health Checks

### Liveness and Readiness Probes

```yaml
platformApi:
  livenessProbe:
    httpGet:
      path: /healthz
      port: 8080
    initialDelaySeconds: 30
    periodSeconds: 10
    timeoutSeconds: 5
    failureThreshold: 3

  readinessProbe:
    httpGet:
      path: /readyz
      port: 8080
    initialDelaySeconds: 5
    periodSeconds: 5
    timeoutSeconds: 3
    failureThreshold: 3
```

## Volume Management

### Volume Mounts

```yaml
platformApi:
  volumeMounts:
    - name: kubeconfigs
      mountPath: /tmp/kubeconfigs
      readOnly: true

  volumes:
    - name: kubeconfigs
      configMap:
        name: kubeconfigs
```

## Deployment Examples

### Development Deployment

```bash
# Basic local development
helm install aegis-dev ./charts/aegis-services \
  -f ./charts/aegis-services/values/common.yaml \
  -f ./charts/aegis-services/values/local.yaml

# With custom images
helm install aegis-dev ./charts/aegis-services \
  -f ./charts/aegis-services/values/common.yaml \
  -f ./charts/aegis-services/values/local.yaml \
  --set platformApi.image.tag=my-dev-tag \
  --set proxy.image.tag=my-dev-tag
```

### Production Deployment

```bash
# Full production deployment
helm install aegis-prod ./charts/aegis-services \
  -f ./charts/aegis-services/values/common.yaml \
  -f ./charts/aegis-services/values/cloud.yaml \
  --set-string platformApi.secrets.db-password="$(cat /path/to/db-secret)" \
  --set-string proxy.jwtSecret="$(openssl rand -base64 32)" \
  --set-file proxy.tls.cert=/path/to/production-cert.pem \
  --set-file proxy.tls.key=/path/to/production-key.pem \
  --set platformApi.image.repository=123456789.dkr.ecr.us-east-1.amazonaws.com/aegis/platform-api \
  --set proxy.image.repository=123456789.dkr.ecr.us-east-1.amazonaws.com/aegis/proxy
```

### Partial Deployment

```bash
# Deploy only platform-api
helm install aegis-api ./charts/aegis-services \
  --set proxy.enabled=false \
  -f ./charts/aegis-services/values/common.yaml \
  -f ./charts/aegis-services/values/local.yaml

# Deploy only proxy
helm install aegis-proxy ./charts/aegis-services \
  --set platformApi.enabled=false \
  -f ./charts/aegis-services/values/common.yaml \
  -f ./charts/aegis-services/values/local.yaml
```

## Troubleshooting

### Check Deployment Status

```bash
# Check all resources
kubectl get all -l app.kubernetes.io/instance=aegis-services

# Check specific components
kubectl get pods -l app.kubernetes.io/component=platform-api
kubectl get pods -l app.kubernetes.io/component=proxy

# Check logs
kubectl logs -l app.kubernetes.io/component=platform-api
kubectl logs -l app.kubernetes.io/component=proxy
```

### Common Issues

1. **Image Pull Errors**: Ensure image repositories and tags are correct
2. **Secret Not Found**: Verify secrets are created or referenced correctly
3. **Ingress Issues**: Check ingress controller is installed and configured
4. **TLS Errors**: Ensure certificate and key files are valid and match

### Debug Mode

Enable debug logging:

```yaml
platformApi:
  env:
    LOG_LEVEL: "debug"

proxy:
  env:
    LOG_LEVEL: "debug"
```

## Upgrading

```bash
# Upgrade with new values
helm upgrade aegis-services ./charts/aegis-services \
  -f ./charts/aegis-services/values/common.yaml \
  -f ./charts/aegis-services/values/cloud.yaml

# Check upgrade status
helm status aegis-services
helm history aegis-services
```

## Uninstalling

```bash
# Remove the release
helm uninstall aegis-services

# Clean up any remaining resources
kubectl delete pvc -l app.kubernetes.io/instance=aegis-services
```

## Development

### Template Testing

```bash
# Generate templates for review
helm template aegis-services ./charts/aegis-services \
  -f ./charts/aegis-services/values/common.yaml \
  -f ./charts/aegis-services/values/local.yaml

# Validate templates
helm lint ./charts/aegis-services
```

### Custom Values

Create your own values file:

```yaml
# my-values.yaml
platformApi:
  enabled: true
  image:
    repository: my-registry/platform-api
    tag: "custom"

proxy:
  enabled: false
```

```bash
helm install aegis-custom ./charts/aegis-services -f my-values.yaml
```

## Contributing

When modifying this chart:

1. Update version in `Chart.yaml`
2. Test with both local and cloud values
3. Update this README with any new configuration options
4. Validate with `helm lint`

## Chart Information

- **Chart Version**: 0.1.0
- **App Version**: latest
- **Kubernetes**: 1.19+
- **Helm**: 3.0+
