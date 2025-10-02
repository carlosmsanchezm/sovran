# Aegis VS Code Remote Toolkit

This repository packages the pieces we use to connect Visual Studio Code (VS Code) to remote
Aegis workspaces:

- `aegis-vscode-remote/extension` – the VS Code extension that lists workspaces, requests proxy
  tickets from Platform API, and opens tunnels into remote servers.
- `aegis-vscode-remote/proxy` – a development proxy that validates JWT tickets and upgrades
  WebSocket connections when you want to run everything locally.
- `aegis-vscode-remote/workspace-mock` – a lightweight container that bootstraps the VS Code
  server inside a mock workspace.

The extension is now capable of driving real platform-issued tickets, understands the Aegis proxy
handshake, and surfaces the active workspace ID in the VS Code status bar so we always know which
remote environment is in use.

## High-level Flow

1. **VS Code extension** (`aegis-remote`) calls Platform API `CreateConnectionSession` using an
   authenticated user session.
2. **Platform API** mints a one-time proxy ticket that carries the destination service, cluster
   metadata, and a short-lived JWT.
3. **VS Code extension** opens a WebSocket to `https://<proxy>/proxy/<workspace>` (or
   `wss://localhost:8085` when port-forwarding) and supplies the bearer token.
4. **Aegis proxy** validates the JWT, enforces single-use JTIs, and forwards the connection to the
   remote VS Code server inside the workspace pod.
5. **VS Code server** must match the client commit; once the versions align the remote session is
   negotiated and VS Code opens the workspace.

```
VS Code UI ─┬─▶ Aegis extension ─▶ Platform API (8081) ─▶ proxy ticket
            │
            └─▶ Aegis proxy (8085) ──▶ workspace pod ──▶ VS Code server
```

## Repository Layout

```text
aegis-vscode-remote/
  extension/        # VS Code extension source (TypeScript)
  proxy/            # Dev proxy server (Node.js)
  workspace-mock/   # Docker image that runs the VS Code remote server
code-insiders/      # Helper scripts and notes for Insiders builds
README.md           # This document
```

## Prerequisites

- VS Code Insiders (client) installed locally.
- Node.js 20+ and npm for building the extension.
- `vsce` (`npm install -g @vscode/vsce`) to package the extension.
- Docker Desktop when building the workspace image.
- Access to Aegis Platform API and proxy endpoints (normally via `kubectl port-forward`).

## Building and Installing the Extension

```bash
cd aegis-vscode-remote/extension
npm install
npm run build
npx vsce package --allow-missing-repository

# Install into an isolated Insiders profile
"/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code" \
  --extensions-dir "$HOME/.vscode-aegis-ext" \
  --user-data-dir "$HOME/.vscode-aegis-data" \
  --install-extension ./aegis-remote-0.0.1.vsix --force \
  --enable-proposed-api aegis.aegis-remote
```

Key extension settings (Configurable under `Settings → Aegis Remote`):

- `platform.grpcEndpoint`: normally `localhost:8081` when port-forwarding.
- `platform.namespace`, `platform.projectId`: used to scope workspace listings.
- `security.rejectUnauthorized`: keep `false` for local proxy testing.
- `defaultWorkspaceId`: optional; leave blank so the tree view drives the selection.

The status bar now reads `Aegis: Connected workspace <wid>` so the active workspace ID is always
visible.

## Workspace Image (VS Code Server)

The mock workspace downloads the VS Code server on boot using the baked commit hash.

### Dockerfile defaults

- `VSCODE_COMMIT=80e42490bbf07d83fe573204416be3949ef27bd1`
- `VSCODE_QUALITY=insider`

`start-reh.sh` caches the extracted server under `/reh/bin/current` and only re-downloads when the
commit changes. A marker file (`.commit`) keeps track of the current version.

### Build & Push

```bash
cd aegis-vscode-remote
docker build --platform linux/arm64 \
  --build-arg VSCODE_COMMIT=80e42490bbf07d83fe573204416be3949ef27bd1 \
  --build-arg VSCODE_QUALITY=insider \
  -t carlosmsanchez/aegis-workspace-mock:80e42490 \
  -t carlosmsanchez/aegis-workspace-mock:latest \
  workspace-mock

docker push carlosmsanchez/aegis-workspace-mock:80e42490
docker push carlosmsanchez/aegis-workspace-mock:latest
```

Reference the tagged image in your Kubernetes `Deployment`/`StatefulSet` so that every new pod uses
the correct commit without a manual download.

## Local Development Workflow

1. **Port-forward services**
   ```bash
   kubectl port-forward -n default svc/aegis-services-aegis-services-platform-api 8081:8081
   kubectl port-forward -n default svc/aegis-services-aegis-services-proxy 8085:8085
   ```

2. **Launch VS Code Insiders** with the custom data + extension directories:
   ```bash
   "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code" \
     --user-data-dir "$HOME/.vscode-aegis-data" \
     --extensions-dir "$HOME/.vscode-aegis-ext" \
     --enable-proposed-api aegis.aegis-remote \
     /Users/carlossanchez/code/sovran
   ```

3. **Sign in** via the extension when prompted (uses VS Code authentication providers).

4. **Refresh workspaces** (`Aegis: Refresh Workspaces`). The tree view lists live workspaces from
   Platform API. Clicking one triggers a connection using its ID.

5. **Verify successful connection** – status bar shows the workspace ID and the VS Code server
   explorer loads from the remote environment.

## Maintenance Checklist

- **Client/Server parity** – After Insiders updates, run `code-insiders --version` to obtain the new
  commit hash and rebuild the workspace image with that value.
- **Extension rebuild** – When TypeScript changes land, run `npm run build` and repackage the VSIX.
- **Proxy tickets** – Tickets are single-use and expire quickly. If you see repeated 403s, refresh
  the workspaces tree to mint a fresh ticket.
- **Certificates** – For real deployments set `security.rejectUnauthorized=true` and supply the
  proxy CA bundle path.

## Troubleshooting

| Symptom | Likely Cause | Fix |
| --- | --- | --- |
| `403 access denied` after requesting a ticket | Workspace ID is stale, token reused, or proxy cluster mismatch | Refresh the workspace list, ensure the pod exists, check proxy logs for `reason=` field |
| `Client refused: version mismatch` | Workspace VS Code server commit differs from local Insiders | Redeploy workspace image with matching `VSCODE_COMMIT` (or install the matching Insiders build) |
| TLS handshake errors | Connecting with `ws://` to TLS proxy or CA rejected | Always use `wss://` for the proxy and disable `rejectUnauthorized` only when testing |
| Workspace not listed | Missing `projectId`, expired auth session, or Platform API unreachable | Confirm settings, sign in again, verify 8081 port-forward |

## How This Fits Together

- The **Aegis extension** is the user-facing entry point. It wraps the remote authority resolver
  proposal and handles token renewal.
- The **Platform API** remains the source of truth for workspace metadata and proxy authorization.
- The **Aegis proxy** enforces security (JWT, cluster scoping) and upgrades WebSocket traffic into the
  cluster network.
- The **workspace image** provides a reproducible VS Code server runtime with the expected Insiders
  commit baked in, making local testing deterministic.

This documentation captures the end-to-end workflow so the system is easy to reproduce and maintain
as the platform evolves.
