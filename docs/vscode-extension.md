# Building and Installing the Aegis VS Code Extension

## TL;DR

1. Package the extension in a case-sensitive environment (Docker).
2. Install the resulting VSIX once.
3. Configure VS Code to trust the Aegis CA and proposed API.
4. Launch VS Code normally.

## 1. Package the extension

```bash
cd /Users/carlossanchez/code/sovran

docker run --rm \
  -v "$PWD/aegis-vscode-remote/extension":/workspace \
  -w /workspace \
  node:20-bullseye \
  bash -lc "npm ci && npx @vscode/vsce package --allow-missing-repository --out aegis-remote.vsix"
```

The VSIX will be created at:
`aegis-vscode-remote/extension/aegis-remote.vsix`

## 2. Install the extension

```bash
code --install-extension aegis-vscode-remote/extension/aegis-remote.vsix --force
```

## 3. Configure VS Code

Add the proposed API flag for the extension once in `argv.json`:

```
~/Library/Application\ Support/Code/argv.json
{
  "enable-proposed-api": ["aegis.aegis-remote"]
}
```

Ensure your shell profile exports the Aegis CA path, for example:

```bash	export NODE_EXTRA_CA_CERTS="$HOME/aegis-local-trust.pem"
```

## 4. Launch VS Code

Now you can start VS Code normally:

```bash
code /path/to/workspace
```

When prompted, sign in via Keycloak. The packaged extension enforces TLS trust using `NODE_EXTRA_CA_CERTS`.

---

If you need to rebuild the VSIX, rerun the Docker command above.
Also remember to remove test workspaces manually when finished:

```bash
kubectl delete aegisworkload <wid> -n aegis-workloads-local
```
