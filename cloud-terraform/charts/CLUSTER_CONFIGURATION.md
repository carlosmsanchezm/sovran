# Aegis Cluster Configuration Guide

This guide explains how to configure Aegis for scalable, multi-cluster deployments with proper authentication, authorization, and workload placement.

## Table of Contents
1. [Architecture Overview](#architecture-overview)
2. [Single Cluster Setup](#single-cluster-setup)
3. [Multi-Cluster Setup](#multi-cluster-setup)
4. [Flavor Configuration](#flavor-configuration)
5. [Scaling Considerations](#scaling-considerations)

---

## Architecture Overview

Aegis uses a hub-and-spoke model:

```
┌─────────────────┐
│  Platform API   │  ← Central control plane
│   (Hub)         │
└────────┬────────┘
         │
    ┌────┴────┬────────────┐
    │         │            │
┌───▼───┐ ┌──▼────┐  ┌───▼────┐
│ Spoke │ │ Spoke │  │ Spoke  │  ← Workload execution clusters
│  US-E │ │ US-W  │  │  EU-W  │
└───────┘ └───────┘  └────────┘
```

### Components:
- **Platform API**: Receives workload requests, performs placement, creates AegisWorkload CRs
- **Spoke Agent**: Runs in each cluster, reports capacity, executes workloads
- **Proxy**: Provides secure tunnel access to running workloads (SSH, VS Code Remote)
- **PostgreSQL**: Stores cluster metadata, flavors, budgets, workloads

### Proxy Configuration:
The platform-api automatically configures itself to communicate with the proxy when both are deployed in the same cluster:
- **JWT Secret**: Shared automatically between platform-api and proxy for session token signing
- **Base URL**: Auto-set to internal service DNS (`http://aegis-proxy.aegis-system.svc.cluster.local:8080`)
- **No manual configuration needed** for same-cluster deployments

---

## Single Cluster Setup

When Platform API and workloads run in the **same cluster** (common for development/single-region deployments).

### 1. Configure aegis-services helm values

```yaml
# charts/aegis-services/values/cloud.yaml
platformApi:
  enabled: true
  targetNamespace: "aegis-workloads"  # Where workloads run

  # Cluster configurations
  clusters:
    my-cluster-name:  # Must match AEGIS_CLUSTER_ID in spoke agent
      inCluster: true  # Use service account token
```

### 2. Configure aegis-spoke helm values

```yaml
# charts/aegis-spoke/values.yaml
k8sAgent:
  env:
    AEGIS_CLUSTER_ID: "my-cluster-name"  # Must match cluster name above
    AEGIS_CP_GRPC: "aegis-platform-api.aegis-system.svc.cluster.local:8081"
    AEGIS_REGION: "us-east-1"
    AEGIS_PROVIDER: "aws"
    AEGIS_FLAVORS: "cpu-small,cpu-large,gpu-a100"  # Flavors this cluster supports
```

### 3. Deploy

```bash
# Deploy platform services
helm upgrade --install aegis charts/aegis-services \
  -n aegis-system --create-namespace \
  -f charts/aegis-services/values/common.yaml \
  -f charts/aegis-services/values/cloud.yaml

# Deploy spoke agent in the same cluster
helm upgrade --install aegis-spoke charts/aegis-spoke \
  -n aegis-system \
  -f charts/aegis-spoke/values.yaml
```

### What gets created:
✅ `aegis-workloads` namespace
✅ RBAC for platform-api to create AegisWorkloads
✅ Kubeconfig secret using service account token
✅ Spoke agent reporting to platform-api

---

## Multi-Cluster Setup

When Platform API runs in one cluster and manages workloads across **multiple remote clusters**.

### Architecture:

```
┌──────────────────────────────┐
│   Cluster A (Hub)            │
│  ┌────────────────┐          │
│  │ Platform API   │          │
│  │ + PostgreSQL   │          │
│  └────────────────┘          │
└──────────────────────────────┘
              │
              │ gRPC
              │
     ┌────────┼─────────┐
     │                  │
┌────▼──────────┐  ┌───▼───────────┐
│ Cluster B     │  │ Cluster C     │
│ (Spoke)       │  │ (Spoke)       │
│ us-east-1     │  │ eu-west-1     │
│ ┌───────────┐ │  │ ┌───────────┐ │
│ │ K8s Agent │ │  │ │ K8s Agent │ │
│ │ Workloads │ │  │ │ Workloads │ │
│ └───────────┘ │  │ └───────────┘ │
└───────────────┘  └───────────────┘
```

### 1. Configure Hub Cluster (Platform API)

```yaml
# charts/aegis-services/values/cloud.yaml
platformApi:
  enabled: true
  targetNamespace: "aegis-workloads"

  clusters:
    # Cluster B (us-east-1)
    aws-us-east-1-prod:
      server: "https://1847DFBAA7CF6BBF9090AB4653AD5EE5.gr7.us-east-1.eks.amazonaws.com"
      certificateAuthorityData: "LS0tLS1CRUdJTi..." # Base64 CA cert
      userConfig: |
        exec:
          apiVersion: client.authentication.k8s.io/v1beta1
          command: aws
          args:
            - --region
            - us-east-1
            - eks
            - get-token
            - --cluster-name
            - aegis-spoke-prod
          env:
            - name: AWS_PROFILE
              value: production

    # Cluster C (eu-west-1)
    aws-eu-west-1-prod:
      server: "https://ABCDEF123456.gr7.eu-west-1.eks.amazonaws.com"
      certificateAuthorityData: "LS0tLS1CRUdJTi..." # Base64 CA cert
      userConfig: |
        token: "eyJhbGciOiJSUzI1NiIs..." # Service account token

    # OR provide raw kubeconfig
    gcp-us-central1:
      kubeconfig: |
        apiVersion: v1
        kind: Config
        clusters:
          - cluster:
              server: https://34.66.123.45
              certificate-authority-data: LS0tLS...
            name: gcp-cluster
        # ... full kubeconfig
```

### 2. Deploy Hub Cluster

```bash
helm upgrade --install aegis charts/aegis-services \
  -n aegis-system --create-namespace \
  -f charts/aegis-services/values/common.yaml \
  -f charts/aegis-services/values/cloud.yaml \
  --set platformApi.env.DB_HOST="aegis-rds.us-east-1.rds.amazonaws.com" \
  --set platformApi.env.DB_PASSWORD="$DB_PASSWORD"
```

### 3. Configure Each Spoke Cluster

```yaml
# Cluster B: charts/aegis-spoke/values-us-east-1.yaml
k8sAgent:
  env:
    AEGIS_CLUSTER_ID: "aws-us-east-1-prod"  # Must match hub config
    AEGIS_CP_GRPC: "platform-api.example.com:8081"  # Hub's external endpoint
    AEGIS_REGION: "us-east-1"
    AEGIS_PROVIDER: "aws"
    AEGIS_FLAVORS: "cpu-small,gpu-a100-40gb,gpu-h100-80gb"
```

```yaml
# Cluster C: charts/aegis-spoke/values-eu-west-1.yaml
k8sAgent:
  env:
    AEGIS_CLUSTER_ID: "aws-eu-west-1-prod"
    AEGIS_CP_GRPC: "platform-api.example.com:8081"
    AEGIS_REGION: "eu-west-1"
    AEGIS_PROVIDER: "aws"
    AEGIS_FLAVORS: "cpu-small,gpu-a100-40gb"
```

### 4. Deploy Spoke Clusters

```bash
# In Cluster B context
kubectl config use-context aws-us-east-1-prod
helm upgrade --install aegis-spoke charts/aegis-spoke \
  -n aegis-system --create-namespace \
  -f charts/aegis-spoke/values-us-east-1.yaml

# In Cluster C context
kubectl config use-context aws-eu-west-1-prod
helm upgrade --install aegis-spoke charts/aegis-spoke \
  -n aegis-system --create-namespace \
  -f charts/aegis-spoke/values-eu-west-1.yaml
```

---

## Flavor Configuration

Flavors represent compute profiles that clusters can provide. They're used for workload placement.

### Defining Flavors

Flavors are defined in **two places**:

1. **Spoke Agent** (`AEGIS_FLAVORS`): What the cluster **advertises**
2. **Platform API** (via `UpsertFlavor` RPC): What the platform **knows about**

### Example: Creating Flavors

```bash
# Define flavor metadata in platform
grpcurl -plaintext \
  -d '{
    "flavor": {
      "name": "gpu-a100-40gb",
      "chip": "nvidia-a100",
      "gpu_count": 1,
      "memory_gib": 40,
      "price_usd_per_gpu_hour": 1.50,
      "cpu_cores_request": "8",
      "memory_request": "64Gi"
    }
  }' \
  platform-api.example.com:8081 aegis.v1.AegisPlatform/UpsertFlavor
```

### Spoke Agent Configuration

```yaml
k8sAgent:
  env:
    # This cluster can run any of these flavors:
    AEGIS_FLAVORS: "cpu-small,cpu-large,gpu-a100-40gb,gpu-h100-80gb"
```

### Flavor Matching Logic

When a workload is submitted with `flavor: "gpu-a100-40gb"`:

1. Platform API queries clusters with that flavor in their `available_flavors`
2. Filters by project's allowed regions
3. Chooses cluster with lowest time-to-first-GPU (TTFG)
4. Creates AegisWorkload CR in chosen cluster

---

## Scaling Considerations

### High-Scale Deployments (1000s of GPUs)

#### 1. Database Sizing

```yaml
platformApi:
  env:
    PG_MAX_OPEN_CONNS: "200"    # Scale with workload volume
    PG_MAX_IDLE_CONNS: "50"
    PG_CONN_MAX_LIFETIME: "30m"
```

**Recommendation**:
- **Small** (<100 GPUs): 50 connections
- **Medium** (100-1000 GPUs): 200 connections
- **Large** (>1000 GPUs): 500+ connections, consider read replicas

#### 2. Platform API Replicas

```yaml
platformApi:
  replicaCount: 3  # Horizontal scaling for high availability

  resources:
    requests:
      cpu: "2000m"
      memory: "2Gi"
    limits:
      cpu: "4000m"
      memory: "4Gi"
```

#### 3. Heartbeat Tuning

Modify `agents/k8s-agent/internal/cpclient/client.go:35`:

```go
// Default: 10 seconds
ticker := time.NewTicker(10 * time.Second)

// For 100+ clusters, increase to reduce DB load:
ticker := time.NewTicker(30 * time.Second)
```

#### 4. Cluster Sharding

For 100+ clusters, consider sharding by region:

```
Platform API US → Manages US clusters
Platform API EU → Manages EU clusters
Platform API APAC → Manages APAC clusters
```

Each platform-api instance connects to the same PostgreSQL but manages different cluster sets.

---

## Verification

After deployment, verify the setup:

```bash
# 1. Check platform-api can reach clusters
kubectl logs -n aegis-system -l app.kubernetes.io/component=platform-api | grep "cluster registered"
# Expected: {"msg":"cluster registered","cluster_id":"aws-us-east-1-prod","provider":"aws","region":"us-east-1"}

# 2. Check spoke agents are sending heartbeats
kubectl logs -n aegis-system -l app.kubernetes.io/name=aegis-spoke-k8s-agent | grep heartbeat
# Expected: {"msg":"starting heartbeat loop","flavor_count":3}

# 3. List available clusters
grpcurl -plaintext platform-api:8081 list

# 4. Submit test workload
grpcurl -plaintext \
  -d '{"workload":{"project_id":"test","queue":"default","workspace":{"flavor":"cpu-small","image":"ubuntu:22.04"}}}' \
  platform-api:8081 aegis.v1.AegisPlatform/SubmitWorkload

# 5. Verify workload placed
kubectl get aegisworkloads -n aegis-workloads
```

---

## Troubleshooting

### Issue: "no eligible cluster for flavor"

**Cause**: No cluster is advertising the requested flavor in the allowed regions.

**Fix**:
1. Check spoke agent has flavor: `kubectl logs -l app=k8s-agent | grep flavor_count`
2. Verify region matches: Project policy allows the cluster's region
3. Check database: Flavors persisted in `cluster_flavors` table

### Issue: "failed to create AegisWorkload"

**Cause**: Platform-api lacks RBAC permissions or can't reach cluster.

**Fix**:
1. Check RBAC: `kubectl auth can-i create aegisworkloads --as=system:serviceaccount:aegis-system:aegis-platform-api`
2. Check kubeconfig: `kubectl exec -it platform-api-xxx -- ls /etc/kubeconfigs`
3. Check connectivity: `kubectl exec -it platform-api-xxx -- curl kubernetes.default.svc`

### Issue: Heartbeat not received

**Cause**: Network connectivity or gRPC endpoint misconfigured.

**Fix**:
1. From spoke cluster: `kubectl exec -it aegis-spoke-xxx -- ping aegis-platform-api.aegis-system.svc`
2. Check endpoint: `echo $AEGIS_CP_GRPC` in spoke pod
3. Check firewall rules between clusters

---

## Next Steps

- [Configure Projects and Policies](./PROJECTS.md)
- [Set up Budget Management](./BUDGETS.md)
- [VS Code Extension Setup](../aegis-vscode-remote/README.md)
