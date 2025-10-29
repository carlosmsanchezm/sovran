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

```bash
export NODE_EXTRA_CA_CERTS="$HOME/aegis-local-trust.pem"
```

Provide the Keycloak test credentials (username/password) and TOTP secret so automation can
complete the MFA challenge:

```bash
export AEGIS_TEST_USERNAME="cloud@test.com"
export AEGIS_TEST_PASSWORD="password"
export AEGIS_TEST_TOTP_SECRET="NUZGUVTLIR2DM4CTMFDVIZTHINGFGT2U" # replace with your user secret
export AEGIS_AUTH_AUTHORITY="https://keycloak.aegis.dev/realms/aegis"
export AEGIS_AUTH_CLIENT_ID="vscode-extension"
export AEGIS_AUTH_REDIRECT_URI="vscode://aegis.aegis-remote/auth"
```

## 4. Launch VS Code

Now you can start VS Code normally:

```bash
code /path/to/workspace
```

When prompted, sign in via Keycloak. The packaged extension enforces TLS trust using `NODE_EXTRA_CA_CERTS`.

The E2E harness uses Playwright (Chromium) to launch the Keycloak login page, submit the test
credentials, and generate the time-based one-time password from the configured secret. Make sure the
test account already has TOTP configured in Keycloak (or uses the same shared secret) so repeat runs
stay deterministic.

---

If you need to rebuild the VSIX, rerun the Docker command above.
Also remember to remove test workspaces manually when finished:

```bash
kubectl delete aegisworkload <wid> -n aegis-workloads-local
```
