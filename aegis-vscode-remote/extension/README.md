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
