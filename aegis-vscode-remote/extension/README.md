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
  "aegisRemote.auth.authority": "https://keycloak.localtest.me/realms/aegis",
  "aegisRemote.auth.clientId": "vscode-extension",
  "aegisRemote.auth.redirectUri": "vscode://aegis.aegis-remote/auth",
  "aegisRemote.auth.scopes": [
    "openid",
    "profile",
    "email",
    "offline_access"
  ],
  "aegisRemote.security.rejectUnauthorized": false,
  "aegisRemote.logLevel": "debug"
}
```

## Usage

1. Start VS Code with proposed APIs enabled (see above)
2. Sign in: `Cmd+Shift+P` → "Aegis: Sign In"
   - A browser window opens to your Keycloak realm; complete the login/MFA flow.
   - Keycloak redirects back to `vscode://aegis.aegis-remote/auth`, which VS Code routes to the extension.
3. Connect to a workspace:
   - `Cmd+Shift+P` → "Aegis: Connect"
   - Or click a workspace in the "Aegis Workspaces" sidebar

## Troubleshooting

If commands are not found or cause errors:
- Ensure VS Code was launched with `--enable-proposed-api aegis.aegis-remote`
- Check Developer Tools Console (Help → Toggle Developer Tools) for activation errors
- View extension logs: `Cmd+Shift+P` → "Aegis: Show Logs"

If Keycloak shows `Restart login cookie not found` during extension sign-in:
- This is usually browser cookie policy blocking the OAuth flow launched from VS Code.
- Allow cookies for `https://keycloak.localtest.me` (or your Keycloak host) and retry `Aegis: Sign In`.
- Local fallback (no browser flow): launch VS Code with env credentials so the extension can request tokens directly:
  - `AEGIS_TEST_USERNAME=<email>`
  - `AEGIS_TEST_PASSWORD=<password>`

## Secure Mode

For environments handling CUI (Controlled Unclassified Information), the extension supports a
**Secure Mode** activated by the `AEGIS_SECURE_LAUNCH=1` environment variable.

When active:
- Tokens are stored in-memory only (not persisted to VS Code SecretStorage)
- `offline_access` scope is stripped (no refresh tokens)
- `security.rejectUnauthorized` is forced to `true` regardless of settings
- `logLevel` is clamped to `info` (no debug/trace output)
- URLs and settings are redacted in log output
- The automation session flow (password grant via env vars) is disabled
- All secrets are wiped from SecretStorage on extension deactivate

Use the Secure Launcher scripts in `launcher/` to automatically set this env var and run
VS Code inside a RAM-disk sandbox. See `docs/secure-mode.md` for the full reference.

## Keycloak Client Configuration

Create (or update) a public client for the extension with:

- **Valid redirect URI:** `vscode://aegis.aegis-remote/auth`
- **Web origins:** `vscode://aegis.aegis-remote` (optional for Keycloak ≥18)
- **Grant type:** Authorization Code with PKCE
- **Client authentication:** Disabled (public client)
- **Direct access grants:** Enabled (recommended for local dev fallback only)

The extension requests the `openid profile email offline_access` scopes by default so that it can derive the authenticated identity from token claims and refresh access tokens silently.

## Real Backend E2E Automation

The `test:e2e:real` script provisions a live workspace, runs the heartbeat smoke test, and cleans everything up automatically. This replaces the previous manual export of `AEGIS_*` variables.

### Required Environment

Export the following variables before invoking the test command:

- `AEGIS_GRPC_ADDR` – Fully qualified `host:port` for the Platform gRPC endpoint.
- `AEGIS_TEST_USERNAME` / `AEGIS_TEST_PASSWORD` – Keycloak credentials for the automation account.
- `AEGIS_TEST_TOTP_SECRET` – Optional base32 secret for generating TOTP codes when MFA is enforced.
- `AEGIS_TEST_EMAIL` – Optional override for the identity e-mail (auto-derived from Keycloak claims).
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
# Ensure no stale workspaces are running (optional but recommended)
kubectl delete workspace -n aegis-workloads-local --all 2>/dev/null || true
npm run test:e2e:real
```

The script executes the following steps:

1. Builds the extension and the E2E harness.
2. Runs `ts-node ./scripts/prepare-real-workspace.ts`, which upserts the demo project/queue, submits an interactive workspace, polls until it reaches `RUNNING`, and writes a ticket to `__tests__/e2e-real/.workspace-session.json` (override with `AEGIS_WORKSPACE_OUTPUT`).
3. Launches the VS Code smoke tests; they consume the session payload, configure TLS (copying the CA bundle to `__tests__/e2e-real/workspace-ca-from-session.pem` when needed), and verify the heartbeat over the real proxy.
4. Invokes the helper in cleanup mode on exit so the workspace is acknowledged/deleted even when tests fail.

Artifacts:

- Workspace ticket JSON: `__tests__/e2e-real/.workspace-session.json`.
- Copied CA bundle (when provided): `__tests__/e2e-real/workspace-ca-from-session.pem`.
- VS Code host logs: `__tests__/logs-real/` (set `AEGIS_E2E_DEBUG=1` to print log tails on failure).

If provisioning fails, re-run the command—the helper is idempotent and purges leftover `w-vscode-e2e-*` workloads before starting over.
If you see repeated `Timed out waiting for workspace ... to reach RUNNING` errors, clear any existing `w-vscode-e2e-*` entries:

```
kubectl delete workspace -n aegis-workloads-local --all
```
