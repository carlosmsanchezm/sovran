# TLS Testing Guide for VS Code Remote Connection

## Overview
This guide provides the complete workflow for testing the VS Code remote connection with proper TLS validation for NIST/FedRAMP compliance.

## Issue Identified
The proxy's TLS certificate was missing Subject Alternative Names (SANs), causing modern TLS clients (Node.js/VS Code) to reject the connection.

## Solution Implemented

### 1. Generated New TLS Certificate with SANs
Created a new self-signed certificate with proper SANs covering:
- `*.elb.amazonaws.com` (wildcard for all ELB hostnames)
- `a0e40ad639d0f4c31899c0b795bd68a2-927345761.us-east-1.elb.amazonaws.com` (specific ALB hostname)
- `*.us-east-1.elb.amazonaws.com` (region-specific wildcard)

Certificate details:
```
CN: *.elb.amazonaws.com
SANs:
  - DNS:*.elb.amazonaws.com
  - DNS:a0e40ad639d0f4c31899c0b795bd68a2-927345761.us-east-1.elb.amazonaws.com
  - DNS:*.us-east-1.elb.amazonaws.com
```

### 2. Updated Kubernetes Secret
```bash
kubectl delete secret aegis-proxy-tls -n aegis-system
kubectl create secret tls aegis-proxy-tls -n aegis-system \
  --cert=/tmp/proxy.crt \
  --key=/tmp/proxy.key
```

### 3. Restarted Proxy Deployment
```bash
kubectl rollout restart deployment aegis-proxy -n aegis-system
```

## VS Code Extension Configuration

### Required Settings
1. **CA Certificate Path**: `/Users/carlossanchez/aegis-proxy-ca.crt`
   - This is the CA bundle that will validate the proxy's self-signed certificate
   - Configure in VS Code settings:
     ```
     Settings → Aegis Remote → Security: Ca Path
     Value: /Users/carlossanchez/aegis-proxy-ca.crt
     ```

2. **TLS Validation**: Enable (default)
   - Keep "Reject Unauthorized" **ENABLED** (checked) for production compliance
   - This ensures proper certificate validation per NIST/FedRAMP requirements

### Configuration Steps
1. Open VS Code Settings (Cmd+, on Mac)
2. Search for "aegis"
3. Configure:
   - **Aegis Remote › Security: Ca Path**: `/Users/carlossanchez/aegis-proxy-ca.crt`
   - **Aegis Remote › Security: Reject Unauthorized**: ✓ ENABLED (checked)

## Testing Workflow

### Prerequisites
1. Running workload in the cluster
2. Platform API configured with proxy secret and endpoint
3. VS Code extension installed and configured

### Test Steps

1. **Verify Workload is Running**
   ```bash
   kubectl get pods -n aegis-workloads
   # Should show a running pod for the target workload
   ```

2. **Create Connection from VS Code**
   - Open Command Palette (Cmd+Shift+P)
   - Select "Aegis: Connect to Workspace"
   - Choose a workload from the list

3. **Monitor Connection**
   - Check Aegis Remote output logs in VS Code
   - Should NOT see TLS handshake errors
   - Should see successful WebSocket connection

4. **Verify TLS Handshake**
   ```bash
   # From terminal, test TLS connection
   openssl s_client -connect a0e40ad639d0f4c31899c0b795bd68a2-927345761.us-east-1.elb.amazonaws.com:8080 \
     -servername a0e40ad639d0f4c31899c0b795bd68a2-927345761.us-east-1.elb.amazonaws.com \
     -CAfile /Users/carlossanchez/aegis-proxy-ca.crt
   # Should show: Verify return code: 0 (ok)
   ```

## Troubleshooting

### TLS Handshake Errors
- **Error**: `TLS handshake error: EOF`
  - **Cause**: Certificate missing SANs or hostname mismatch
  - **Solution**: Verify certificate has proper SANs (see "Generated New TLS Certificate" above)

### Certificate Validation Errors
- **Error**: `unable to verify the first certificate`
  - **Cause**: CA certificate not configured
  - **Solution**: Set "Ca Path" in VS Code settings to `/Users/carlossanchez/aegis-proxy-ca.crt`

### 403 Forbidden Errors
- **Error**: `unexpected response status=403, body=access denied`
  - **Cause**: JWT token validation failing at proxy
  - **Solution**: Verify JWT secret matches between platform-api and proxy

## Production Considerations

### For Production Deployment:
1. **Use CA-Signed Certificates**: Replace self-signed cert with one from a trusted CA (Let's Encrypt, AWS ACM, etc.)
2. **Domain Name**: Configure a custom domain (e.g., `proxy.yourdomain.com`) instead of ALB hostname
3. **Certificate Rotation**: Implement automated certificate rotation (e.g., cert-manager)
4. **mTLS**: Consider enabling mutual TLS for additional security (AC-17b compliance)

### Current State:
- ✅ Proxy has proper TLS certificate with SANs
- ✅ Self-signed CA available for client validation
- ✅ VS Code extension supports CA bundle configuration
- ⚠️  Self-signed certificate (acceptable for testing, not for production)

## Next Steps
1. Test the connection with the new certificate configuration
2. Verify logs show successful TLS handshake
3. For production: Obtain CA-signed certificate or configure AWS Certificate Manager
