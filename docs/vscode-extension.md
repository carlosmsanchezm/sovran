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

## 5. Local and Remote E2E Testing with Keycloak

The real-backend E2E suite (`npm run test:e2e:real`) now exercises Keycloak end‑to-end in both
local and CI environments. A few key behaviours to keep in mind:

- **Local runs** – set the automation credentials and CA path as shown above, then execute
  `AEGIS_TEST_USERNAME=cloud@test.com AEGIS_TEST_PASSWORD=password npm run test:e2e:real` from
  `aegis-vscode-remote/extension/`. The helper script automatically reads the local TLS trust
  bundle, logs into Keycloak via Playwright, and provisions a workspace through the platform API.
  If your cluster uses a different Keycloak host, override `AEGIS_AUTH_AUTHORITY` accordingly.
- **Offline token fallback** – preview clusters may forbid the `offline_access` scope. The helper
  now retries the authorization code flow without that scope and promotes the email returned by
  Keycloak to `AEGIS_TEST_EMAIL`, guaranteeing consistent identity checks across the run.
- **GitHub Actions workflow** – `.github/workflows/cloud-e2e.yml` now exports
  `AEGIS_AUTH_DISABLE_OFFLINE=1` for both the deploy and extension jobs so the automation always
  requests only the online scopes in CI. Instead of standing up a throwaway instance, the deploy stage
  resolves the managed Keycloak issuer (`keycloak.aegis.dev`) using the `KEYCLOAK_BASE_URL` and
  `KEYCLOAK_REALM` secrets, shares the resulting authority with later steps, and skips all port-forward
  logic. The extension job reuses those outputs alongside the TLS CA bundle artifact to log in through
  the managed realm and execute the real E2E flow end-to-end.
  CI runs never port-forward a cluster Keycloak service; every token is minted through the managed
  issuer so the workflow stays independent of preview-cluster Keycloak readiness.
- **Debug fingerprints** – when `AEGIS_E2E_DEBUG=1`, the E2E suite emits SHA‑256 fingerprints for
  the expected email, token claims, and session subject. This avoids leaking raw credentials while
  still proving that Keycloak identities line up between the workspace payload and the issued tokens.

The Helm chart bundles the same `aegis-realm.json` import as the upstream Aegis repository so that
the automation user (`cloud@test.com`) and related roles stay aligned across local clusters and the
managed preview realm.

When chasing CI failures, download the workflow artifacts (particularly the extension job log) and
grep for `[real-e2e]` lines to confirm the port-forward, Keycloak login, and proxy ticket steps all
completed successfully.
