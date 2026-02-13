# Sovran

**VS Code extension and proxy for connecting to Aegis GPU workspaces**

Sovran provides the tooling for connecting Visual Studio Code to remote GPU workspaces managed by the [Aegis Platform](https://github.com/carlosmsanchezm/aegis-platform). It includes a VS Code extension that authenticates via Keycloak, discovers workspaces through the Platform API, and tunnels into workspace pods through an authenticated WebSocket proxy.

## Components

| Component | Path | Purpose |
|-----------|------|---------|
| **VS Code Extension** | `aegis-vscode-remote/extension/` | Lists workspaces, requests proxy tickets via gRPC, opens WebSocket tunnels to remote VS Code servers |
| **Development Proxy** | `aegis-vscode-remote/proxy/` | JWT-validated WebSocket proxy for local development and testing |
| **Workspace Mock** | `aegis-vscode-remote/workspace-mock/` | Docker image that bootstraps the VS Code Remote Extension Host for testing |

## How It Works

```
VS Code UI ──▶ Aegis Extension ──gRPC──▶ Platform API
                    │                         │
                    │                    mints JWT ticket
                    │                         │
                    └──WSS──▶ Aegis Proxy ────▶ Workspace Pod
                              (validates JWT)    (VS Code Server)
```

1. User signs in via OAuth (Keycloak OIDC with PKCE)
2. Extension calls `ListWorkloads` to populate the workspace tree view
3. User selects a workspace; extension calls `CreateConnectionSession` to obtain a single-use JWT proxy ticket
4. Extension opens a WebSocket connection to the Aegis proxy with the JWT bearer token
5. Proxy validates the token, enforces single-use JTI, and forwards the connection to the VS Code server inside the workspace pod
6. VS Code remote session negotiates and opens the workspace

The extension handles automatic token renewal at 85% of TTL, heartbeat pings every 15 seconds, and idle timeout detection.

## Development

### Prerequisites

- Node.js 20+
- npm
- VS Code Insiders (required for proposed `resolvers` and `tunnels` APIs)
- Access to an Aegis Platform API instance (or `kubectl port-forward`)

### Build and Install

```bash
# Install dependencies and build
npm install
npm run build

# Package the extension
cd aegis-vscode-remote/extension
npx vsce package --allow-missing-repository

# Install into VS Code Insiders
code-insiders --install-extension ./aegis-remote-0.0.1.vsix \
  --enable-proposed-api aegis.aegis-remote
```

### Testing

```bash
# Run all tests (unit + integration + E2E)
npm test

# Run individually
npm run -w aegis-remote test:unit
npm run -w aegis-remote test:integration
npm run -w aegis-remote test:e2e
```

The test runner boots a local echo server, TLS bridge, and dev proxy so the extension exercises the full handshake without requiring cloud access.

### Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `platform.grpcEndpoint` | `localhost:8081` | Platform API gRPC address |
| `platform.namespace` | | Namespace for workspace scoping |
| `platform.projectId` | | Project filter for workspace listings |
| `security.rejectUnauthorized` | `true` | TLS certificate validation |
| `auth.authority` | | Keycloak OIDC issuer URL |
| `auth.clientId` | `vscode-extension` | OAuth client ID |

## Related Repositories

- [aegis-platform](https://github.com/carlosmsanchezm/aegis-platform) -- Central control plane (Go, gRPC, K8s operator)
- [aegis-ui](https://github.com/carlosmsanchezm/aegis-ui) -- Backstage web frontend

For detailed documentation, visit [aegis-platform.tech](https://aegis-platform.tech).
