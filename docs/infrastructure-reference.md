# Aegis Infrastructure Reference

This document covers common infrastructure issues and their solutions for local development.

## TLS Certificate Authority Configuration

### The Problem

When developing locally with self-signed certificates or a custom CA (like `aegis-local-trust.pem`), you need to configure Node.js HTTP and gRPC clients to trust your custom CA. However, **both undici (HTTP) and @grpc/grpc-js libraries replace system root CAs entirely when you provide a custom CA**.

This means if you only pass your custom CA:
- Connections to services using your custom CA will work (e.g., `platform-api-grpc.localtest.me`)
- Connections to services using public CAs (Cloudflare, Let's Encrypt, etc.) will FAIL with "unable to get local issuer certificate"

Example failure scenario:
1. Extension tries to authenticate via Keycloak at `keycloak.aegis-platform.tech` (Cloudflare certificate)
2. Only custom CA is loaded → Cloudflare's certificate chain cannot be verified
3. Token exchange fails with: `fetch failed (unable to get local issuer certificate)`

### Long-Term Architecture (IL-5/IL-6/FedRAMP HIGH/Air-Gapped)

Aegis targets air-gapped and high-security environments where:
- **No internet access** - Let's Encrypt/public ACME is not available
- **Custom CA required** - Every deployment has its own internal CA
- **Strict certificate management** - PKI must be auditable and compliant

#### Server-Side: Internal CA + cert-manager

Deploy an internal CA solution in each cluster:

| Solution | Use Case |
|----------|----------|
| **HashiCorp Vault PKI** | Enterprise, audit logging required |
| **step-ca (smallstep)** | Lightweight, Kubernetes-native |
| **DoD/Agency PKI** | Must integrate with existing PKI |

cert-manager works with internal CAs:

```yaml
# Example: Vault PKI issuer
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: vault-issuer
spec:
  vault:
    server: https://vault.aegis-system.svc:8200
    path: pki/sign/aegis-role
    auth:
      kubernetes:
        role: cert-manager
        mountPath: /v1/auth/kubernetes
```

#### CA Distribution Strategy

```yaml
# Option A: Kubernetes ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: aegis-ca-bundle
data:
  ca.crt: |
    -----BEGIN CERTIFICATE-----
    ...
    -----END CERTIFICATE-----
```

```dockerfile
# Option B: Bake into container images (preferred for air-gapped)
FROM base-image:latest
COPY ca-bundle.pem /etc/pki/ca-trust/source/anchors/
RUN update-ca-trust
```

#### Client-Side: Shared TLS Utility

The extension includes `src/tls.ts` which **always** combines the environment's CA with system CAs.

Operators configure their environment's CA:
```json
{
  "aegisRemote.security.caPath": "/path/to/environment-ca.pem"
}
```

**RULE: Never pass a custom CA directly to TLS clients. Always use the tls.ts utilities.**

#### Local Development Only: mkcert

For developer workstations (not production), [mkcert](https://github.com/FiloSottimo/mkcert) can simplify local testing:

```bash
brew install mkcert        # macOS
mkcert -install            # Adds CA to system trust store
mkcert platform-api-grpc.localtest.me  # Generates trusted cert
```

### The Solution (Current Implementation)

**Always combine system root CAs with your custom CA.** This allows the client to verify both:
- Public certificates (Cloudflare, Let's Encrypt, DigiCert, etc.)
- Your development certificates

#### Shared TLS Utility - `src/tls.ts`

All TLS configuration MUST go through this utility:

```typescript
// src/tls.ts - The single source of truth for CA handling
import * as tls from 'tls';

// For undici (returns string array)
export function getCombinedCAsArray(customCAPem: string | Buffer): string[];

// For @grpc/grpc-js (returns Buffer)
export function getCombinedCAsBuffer(customCAPem: string | Buffer): Buffer;

// Convenience loaders that handle file reading + error handling
export async function loadCombinedCAsArray(caPath: string | undefined): Promise<string[] | undefined>;
export async function loadCombinedCAsBuffer(caPath: string | undefined): Promise<Buffer | undefined>;
```

**Usage in HTTP Client (`src/http.ts`):**

```typescript
import { getCombinedCAsArray } from './tls';

// CORRECT: Use the shared utility
const combinedCAs = getCombinedCAsArray(customCA);
const agent = new Agent({ connect: { ca: combinedCAs } });

// WRONG: Never do this - it replaces system CAs!
// const agent = new Agent({ connect: { ca: customCA } });
```

**Usage in gRPC Client (`src/platform.ts`):**

```typescript
import { loadCombinedCAsBuffer } from './tls';

// CORRECT: Use the shared utility
const combinedCA = await loadCombinedCAsBuffer(security.caPath);
return grpc.credentials.createSsl(combinedCA);

// WRONG: Never do this - it replaces system CAs!
// const ca = await fs.readFile(caPath);
// return grpc.credentials.createSsl(ca);
```

### Key Points

1. **`tls.rootCertificates`** - Node.js exposes system root CAs as an array of PEM strings
2. **PEM extraction regex** - Custom CA files may contain multiple certificates; extract each one
3. **Join with newlines** - For gRPC, combine all PEM strings into a single buffer
4. **Array format for undici** - undici accepts an array of PEM strings directly

### Debugging TLS Issues

1. **Check channel state** - gRPC channels stuck in CONNECTING (state 1) usually indicate TLS handshake failure:
   ```
   IDLE = 0
   CONNECTING = 1
   READY = 2
   TRANSIENT_FAILURE = 3
   SHUTDOWN = 4
   ```

2. **Test with openssl** - Verify the server's certificate chain:
   ```bash
   openssl s_client -connect platform-api-grpc.localtest.me:443 \
     -CAfile ~/aegis-local-trust.pem \
     -servername platform-api-grpc.localtest.me
   ```

3. **Test with grpcurl** - Verify gRPC connectivity:
   ```bash
   grpcurl -cacert ~/aegis-local-trust.pem \
     platform-api-grpc.localtest.me:443 list
   ```

4. **Check extension logs** - Look for these patterns in Aegis Remote output:
   ```
   [platform] loaded 8 custom CA cert(s) from /path/to/ca.pem + 146 system CAs
   [platform] gRPC channel state changed: 1 -> 2  # Success!
   [platform] gRPC channel state changed: 0 -> 1  # Stuck here = TLS issue
   ```

### Common Errors and Solutions

| Error | Cause | Solution |
|-------|-------|----------|
| `unable to get local issuer certificate` | Custom CA replaces system CAs | Combine system + custom CAs |
| `DEADLINE_EXCEEDED: Waiting for LB pick` | gRPC channel stuck in CONNECTING | Fix TLS CA configuration |
| `self signed certificate in certificate chain` | Custom CA not loaded | Check `caPath` setting and file permissions |
| `certificate has expired` | Expired custom CA | Regenerate certificates |

### Environment Variables

For Node.js processes outside the extension (e.g., CLI tools):

```bash
export NODE_EXTRA_CA_CERTS="$HOME/aegis-local-trust.pem"
```

Note: `NODE_EXTRA_CA_CERTS` adds to system CAs, while programmatic CA configuration typically replaces them.

### Local Development Setup Checklist

1. Generate local CA and certificates (see TESTING_GUIDE.md)
2. Export CA bundle to `~/aegis-local-trust.pem`
3. Configure VS Code extension settings:
   ```json
   {
     "aegisRemote.security.caPath": "/Users/you/aegis-local-trust.pem",
     "aegisRemote.security.rejectUnauthorized": true
   }
   ```
4. Ensure extension code combines system + custom CAs (already implemented)
5. Restart VS Code Extension Development Host

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    VS Code Extension                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────┐         ┌─────────────────────────────┐    │
│  │   http.ts       │         │   platform.ts               │    │
│  │   (undici)      │         │   (@grpc/grpc-js)           │    │
│  └────────┬────────┘         └────────────┬────────────────┘    │
│           │                               │                      │
│           ▼                               ▼                      │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              Combined CA Bundle                          │    │
│  │  ┌──────────────────┐   ┌──────────────────────────┐    │    │
│  │  │ System Root CAs  │ + │ Custom CA (local dev)    │    │    │
│  │  │ (146 certs)      │   │ (aegis-local-trust.pem)  │    │    │
│  │  └──────────────────┘   └──────────────────────────┘    │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
    ┌─────────────────┐ ┌───────────┐ ┌─────────────────┐
    │ Keycloak        │ │ Platform  │ │ Spoke Cluster   │
    │ (Cloudflare)    │ │ API       │ │ Proxy           │
    │                 │ │ (Custom)  │ │ (Custom)        │
    └─────────────────┘ └───────────┘ └─────────────────┘
```

## Code Review Checklist for TLS

When reviewing PRs that touch TLS/certificate configuration, verify:

- [ ] **No direct CA passing** - Code does NOT pass custom CA directly to `grpc.credentials.createSsl()`, `undici Agent`, or `https.Agent`
- [ ] **Uses shared utility** - All CA configuration uses functions from `src/tls.ts`
- [ ] **Comments reference docs** - Code includes comment `// See /docs/infrastructure-reference.md`
- [ ] **Error handling** - CA file read errors are logged, not silently ignored

**Red flags to look for:**

```typescript
// BAD - These patterns will break connections to public CA services
grpc.credentials.createSsl(await fs.readFile(caPath))
new Agent({ connect: { ca: customCaBuffer } })
https.request({ ca: customCa })

// GOOD - Always use the shared utilities
grpc.credentials.createSsl(await loadCombinedCAsBuffer(caPath))
new Agent({ connect: { ca: getCombinedCAsArray(customCa) } })
```

## New Spoke Cluster Provisioning

When deploying a new EKS spoke cluster, follow these steps to enable VS Code extension connectivity.

### Prerequisites

- EKS cluster is provisioned and accessible
- `kubectl` configured to access the new cluster
- Public IP of a node (for NodePort access) or load balancer

### Step 1: Generate Spoke-Proxy TLS Certificate

Each spoke cluster needs its own TLS certificate. The certificate **must** include:
- `basicConstraints = CA:TRUE` (required for Node.js to trust it)
- `subjectAltName` with the actual hostname/IP

```bash
#!/bin/bash
# save as: generate-spoke-cert.sh
# Usage: ./generate-spoke-cert.sh <PUBLIC_IP> [NODEPORT]
# Example: ./generate-spoke-cert.sh 54.89.45.129 31484

PUBLIC_IP=$1
NODEPORT=${2:-31484}
HOSTNAME="spoke-proxy.${PUBLIC_IP}.nip.io"

cat > /tmp/spoke-proxy-san.cnf << EOF
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_ca
prompt = no

[req_distinguished_name]
CN = spoke-proxy.aegis.local

[v3_ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, digitalSignature, keyEncipherment, keyCertSign
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = spoke-proxy.aegis.local
DNS.2 = ${HOSTNAME}
DNS.3 = *.nip.io
IP.1 = ${PUBLIC_IP}
EOF

openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /tmp/spoke-proxy.key \
  -out /tmp/spoke-proxy.crt \
  -subj "/CN=spoke-proxy.aegis.local" \
  -config /tmp/spoke-proxy-san.cnf

echo "Certificate generated:"
echo "  Cert: /tmp/spoke-proxy.crt"
echo "  Key:  /tmp/spoke-proxy.key"
echo "  Hostname: ${HOSTNAME}:${NODEPORT}"

# Verify the certificate
echo ""
echo "Certificate SANs:"
openssl x509 -in /tmp/spoke-proxy.crt -noout -text | grep -A1 "Subject Alternative Name"
```

### Step 2: Deploy aegis-spoke Helm Chart

```bash
# Get the cluster's public IP (from an EC2 node or load balancer)
PUBLIC_IP="<YOUR_CLUSTER_PUBLIC_IP>"
CLUSTER_ID="<YOUR_CLUSTER_ID>"  # e.g., "end-us-east-1-atlas-train-govcloud-2"

helm upgrade --install aegis-spoke ./charts/aegis-spoke \
  --namespace aegis-system \
  --create-namespace \
  --set k8sAgent.env.AEGIS_CLUSTER_ID="${CLUSTER_ID}" \
  --set k8sAgent.env.AEGIS_PROXY_INGRESS_HOST="spoke-proxy.${PUBLIC_IP}.nip.io:31484" \
  --set k8sAgent.env.AEGIS_FLAVORS="cpu-small,cpu-medium,cpu-large,gpu-standard,gpu-large" \
  --set proxy.service.type=NodePort \
  --set proxy.service.nodePort=31484 \
  --set-file proxy.tls.cert=/tmp/spoke-proxy.crt \
  --set-file proxy.tls.key=/tmp/spoke-proxy.key
```

### Step 3: Verify Cluster Registration

The k8s-agent auto-registers with the hub. Verify the `proxy_url` is set:

```bash
# Check cluster registration in database
kubectl exec -n aegis-system platform-postgres-0 -- \
  psql -U aegis_platform -d aegis_platform -c \
  "SELECT id, proxy_url, last_heartbeat FROM clusters;"
```

If `proxy_url` is empty, set it manually:

```bash
kubectl exec -n aegis-system platform-postgres-0 -- \
  psql -U aegis_platform -d aegis_platform -c \
  "UPDATE clusters SET proxy_url = 'wss://spoke-proxy.${PUBLIC_IP}.nip.io:31484' WHERE id = '${CLUSTER_ID}';"
```

### Step 4: Update Client Trust Bundle (CRITICAL)

**This step is required for VS Code extension to connect to the new cluster.**

Add the spoke-proxy certificate to your local trust bundle:

```bash
# Append the new cert to your trust bundle
cat /tmp/spoke-proxy.crt >> ~/aegis-local-trust.pem

# Verify the cert was added
grep -c "BEGIN CERTIFICATE" ~/aegis-local-trust.pem
# Should show increased count (e.g., 8 → 9)
```

Your trust bundle structure:
```
~/aegis-local-trust.pem
├── Aegis Local Root CA
├── platform-api.localtest.me cert
├── keycloak.localtest.me cert
├── spoke-proxy-cluster-1.crt (existing clusters)
├── spoke-proxy-cluster-2.crt
└── spoke-proxy-NEW-CLUSTER.crt  ← Add new cert here
```

### Step 5: Restart VS Code Extension

The extension caches TLS settings. Restart to pick up the new certificate:

1. Close VS Code completely
2. Reopen VS Code
3. Or reload the extension development host (if in dev mode)

### Step 6: Verify Connectivity

```bash
# Test TLS connection to spoke-proxy
openssl s_client -connect spoke-proxy.${PUBLIC_IP}.nip.io:31484 \
  -servername spoke-proxy.${PUBLIC_IP}.nip.io \
  -CAfile ~/aegis-local-trust.pem

# Check for "Verify return code: 0 (ok)"
```

### Verification Checklist

| Item | Command | Expected |
|------|---------|----------|
| Spoke agent running | `kubectl -n aegis-system get pods -l app=aegis-spoke-k8s-agent` | Running |
| Spoke proxy running | `kubectl -n aegis-system get pods -l app=aegis-spoke-proxy` | Running |
| Cluster registered | `SELECT * FROM clusters WHERE id='...'` | Row exists with proxy_url |
| TLS cert valid | `openssl s_client -connect ...` | Verify return code: 0 |
| Trust bundle updated | `grep -c "BEGIN CERTIFICATE" ~/aegis-local-trust.pem` | Includes new cert |

### Troubleshooting

| Error | Cause | Solution |
|-------|-------|----------|
| `unable to verify the first certificate` | Cert not in trust bundle | Add cert to `~/aegis-local-trust.pem` |
| `Hostname/IP does not match certificate's altnames` | Cert missing SAN | Regenerate with correct PUBLIC_IP |
| `ECONNREFUSED` | Spoke proxy not running or wrong port | Check NodePort and pod status |
| `proxy_url is NULL` | Agent didn't register URL | Manually set in database |

### Why This Is Manual (For Now)

Each spoke cluster generates its own self-signed certificate. Without centralized PKI (step-ca):
- Each cert must be manually generated
- Each cert must be added to every client's trust bundle
- This doesn't scale for many clusters

**Future improvement:** Implement step-ca + cert-manager so all spoke certs are signed by a single CA. Clients only need to trust that one CA.

## Related Documentation

- [vscode-extension.md](./vscode-extension.md) - Building and installing the extension
- [TESTING_GUIDE.md](../TESTING_GUIDE.md) - E2E testing setup
- [README.md](../README.md) - Project overview
- [aegis-platform infrastructure-reference.md](../../aegis-platform/docs/infrastructure-reference.md) - Full platform infrastructure docs
