# Aegis Remote Extension

VS Code extension for connecting to remote Aegis workspaces.

## Installation

1. Package the extension:
   ```bash
   cd /Users/carlossanchez/code/sovran/aegis-vscode-remote/extension
   npm run build
   npx @vscode/vsce package --out aegis-remote.vsix
   ```

2. Install in VS Code:
   ```bash
   code --install-extension aegis-remote.vsix --force
   ```

## Running the Extension

**IMPORTANT:** This extension uses VS Code's proposed `resolvers` and `tunnels` APIs, which require special permissions.

### For Testing/Development

Always launch VS Code with the `--enable-proposed-api` flag:

```bash
# Launch VS Code with proposed API enabled
/Applications/Visual\ Studio\ Code.app/Contents/Resources/app/bin/code \
  --enable-proposed-api aegis.aegis-remote

# Or for VS Code Insiders:
/Applications/Visual\ Studio\ Code\ -\ Insiders.app/Contents/Resources/app/bin/code \
  --enable-proposed-api aegis.aegis-remote
```

### For Production

The extension **will not work** when launched from Backstage's "Open in VS Code" button or from `vscode://` URIs unless:

1. VS Code is already running with `--enable-proposed-api aegis.aegis-remote`
2. OR the extension is allow-listed by the VS Code team for proposed APIs
3. OR the `resolvers` API graduates from proposed to stable

## Configuration

Add these settings to your VS Code settings (Cmd+,):

```json
{
  "aegisRemote.platform.grpcEndpoint": "localhost:8081",
  "aegisRemote.platform.namespace": "default",
  "aegisRemote.platform.authScope": "aegis-platform",
  "aegisRemote.platform.projectId": "p-demo",
  "aegisRemote.security.rejectUnauthorized": false,
  "aegisRemote.logLevel": "debug"
}
```

## Usage

1. Start VS Code with proposed APIs enabled (see above)
2. Sign in: `Cmd+Shift+P` → "Aegis: Sign In"
   - Username: `dev-user@example.com`
   - Token: `supersecret`
3. Connect to a workspace:
   - `Cmd+Shift+P` → "Aegis: Connect"
   - Or click a workspace in the "Aegis Workspaces" sidebar

## Troubleshooting

If commands are not found or cause errors:
- Ensure VS Code was launched with `--enable-proposed-api aegis.aegis-remote`
- Check Developer Tools Console (Help → Toggle Developer Tools) for activation errors
- View extension logs: `Cmd+Shift+P` → "Aegis: Show Logs"

## Real Backend E2E Automation

The `test:e2e:real` script provisions a live workspace, runs the heartbeat smoke test, and cleans everything up automatically. This replaces the previous manual export of `AEGIS_*` variables.

### Required Environment

Export the following variables before invoking the test command:

- `AEGIS_GRPC_ADDR` – Fully qualified `host:port` for the Platform gRPC endpoint.
- `AEGIS_TEST_TOKEN` – Bearer token with permission to upsert queues and submit workspaces.
- `AEGIS_TEST_EMAIL` – Subject used for platform metadata headers.
- `AEGIS_PROJECT_ID` – Project under which the workspace should run.
- Optional knobs:
  - `AEGIS_PLATFORM_NAMESPACE` (defaults to `default`).
  - `AEGIS_CA_PEM` (filesystem path) or `AEGIS_CA_PEM_INLINE` (PEM string) for custom trust roots.
  - `AEGIS_TLS_SKIP_VERIFY=1` to disable TLS verification (only for dev endpoints).
  - `AEGIS_TEST_QUEUE`, `AEGIS_TEST_FLAVOR`, `AEGIS_TEST_IMAGE`, `AEGIS_TEST_CLUSTER_ID` for bespoke infra setups.
  - `VSCODE_QUALITY` / `VSCODE_COMMIT` to pin the Remote Extension Host build (auto-detected when omitted).

### Run the Suite


```
npm install
cp .env.real-e2e.example .env.real-e2e  # fill in your cluster/token details once
./scripts/run-real-e2e.sh                # sources .env.real-e2e and runs npm run test:e2e:real
```

The script executes the following steps:

1. Builds the extension and the E2E harness.
2. Runs `ts-node ./scripts/prepare-real-workspace.ts`, which upserts the demo project/queue, submits an interactive workspace, polls until it reaches `RUNNING`, and writes a ticket to `__tests__/e2e-real/.workspace-session.json` (override with `AEGIS_WORKSPACE_OUTPUT`).
3. Launches the VS Code smoke tests; they consume the session payload, configure TLS (copying the CA bundle to `__tests__/e2e-real/workspace-ca-from-session.pem` when needed), and verify the heartbeat over the real proxy.
4. Invokes the helper in cleanup mode on exit so the workspace is acknowledged/deleted even when tests fail.
5. Confirms the provisioned workspace is visible via `listWorkspaces()`, renews the proxy ticket, and ensures no non-terminal `w-vscode-e2e-*` workloads linger after the run.

Artifacts:

- Workspace ticket JSON: `__tests__/e2e-real/.workspace-session.json`.
- Copied CA bundle (when provided): `__tests__/e2e-real/workspace-ca-from-session.pem`.
- VS Code host logs: `__tests__/logs-real/` (set `AEGIS_E2E_DEBUG=1` to print log tails on failure).

If provisioning fails, re-run the command—the helper is idempotent and purges leftover `w-vscode-e2e-*` workloads before starting over.
