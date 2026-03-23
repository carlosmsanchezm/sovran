# Aegis VS Code Extension — Project Context

## Overview

Aegis Remote is a VS Code extension that connects developers to remote GPU workspaces in the Aegis DoD/IC AI platform. It implements a Remote Authority Resolver — files, execution, and LSP all stay server-side. The extension handles authentication (OIDC/PKCE via Keycloak), WebSocket tunneling to workspace proxies, and session lifecycle management.

## Repository Structure

```
aegis-vscode-remote/extension/     # VS Code extension source
  src/
    auth.ts                        # OIDC/PKCE auth provider, token management
    config.ts                      # Settings interface and getSettings()
    connection.ts                  # WebSocket connection manager
    resolver.ts                    # RemoteAuthorityResolver implementation
    extension.ts                   # activate() / deactivate() entry point
    platform.ts                    # gRPC client for Platform API
    http.ts                        # Custom undici dispatcher for TLS
    diagnostics.ts                 # Diagnostics command
    errors.ts                      # Error categorization, retry utility
    secure-mode.ts                 # Secure mode detection and redaction utilities
    ui.ts                          # Output channel, status bar helpers
    tls.ts                         # TLS/CA utilities
  __tests__/
    unit/                          # Jest unit tests
    stubs/                         # Module stubs (vscode mock, config stub)
    e2e-real/                      # Real-backend E2E tests
  proto/                           # gRPC proto definitions
aegis-vscode-remote/launcher/      # Secure Launcher scripts (RAM disk + FDE)
cloud-terraform/                   # Infrastructure (Helm, Terraform)
compliance/nist/                   # NIST control mappings
docs/                              # Documentation
```

## Build & Test

```bash
cd aegis-vscode-remote/extension
npm install
npm run build          # TypeScript compilation — REQUIRED before launching VS Code
npm run test:unit      # Jest unit tests
npm run test:e2e:real  # Real-backend E2E (requires cluster)
```

**IMPORTANT:** VS Code loads compiled JS from `out/`, not TypeScript from `src/`. After ANY code change, you MUST run `npm run build` before launching VS Code, otherwise VS Code runs stale code.

## Launching the Extension

### Normal mode (development)

```bash
AEGIS_TEST_USERNAME="user@example.com" \
AEGIS_TEST_PASSWORD="password" \
NODE_EXTRA_CA_CERTS="$HOME/aegis-step-ca-root.pem" \
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --extensionDevelopmentPath="$HOME/code/sovran/aegis-vscode-remote/extension" \
  --enable-proposed-api aegis.aegis-remote \
  "$HOME/code/sovran"
```

This uses password grant for auto-login. Tokens persist. Debug/trace logging available.

### Secure mode (testing CUI controls)

```bash
AEGIS_SKIP_FDE_CHECK=1 \
AEGIS_RAM_SIZE_MB=256 \
NODE_EXTRA_CA_CERTS="$HOME/aegis-step-ca-root.pem" \
bash ~/code/sovran/aegis-vscode-remote/launcher/aegis-secure-launch.sh \
  --extensionDevelopmentPath="$HOME/code/sovran/aegis-vscode-remote/extension" \
  --enable-proposed-api aegis.aegis-remote \
  "$HOME/code/sovran"
```

This creates a RAM disk, sets `AEGIS_SECURE_LAUNCH=1`, and launches VS Code in a sandbox. Password grant is disabled — you must sign in via browser (Keycloak PKCE flow). On exit the RAM disk is destroyed.

`AEGIS_SKIP_FDE_CHECK=1` is needed for dev machines without FileVault. In production this check is enforced.

## Configuration

All settings are under `aegisRemote.*` in VS Code settings. Key ones:

- `aegisRemote.platform.grpcEndpoint` — Platform API gRPC address
- `aegisRemote.auth.authority` — Keycloak realm URL
- `aegisRemote.auth.clientId` — OAuth client ID
- `aegisRemote.security.rejectUnauthorized` — TLS verification (default: true)
- `aegisRemote.logLevel` — info | debug | trace

## Environment Variables

- `AEGIS_SECURE_LAUNCH=1` — Activates secure mode (ephemeral tokens, TLS enforced, logs clamped)
- `AEGIS_TEST_USERNAME` / `AEGIS_TEST_PASSWORD` — Automation credentials (dev/test only)
- `AEGIS_AUTH_AUTHORITY` — Override Keycloak authority URL
- `AEGIS_AUTH_CLIENT_ID` — Override OAuth client ID
- `AEGIS_CA_PEM` — Path to custom CA bundle
- `AEGIS_TLS_SKIP_VERIFY=1` — Skip TLS verification (dev only)

## Secure Mode

When `AEGIS_SECURE_LAUNCH=1` is set:
- Tokens are in-memory only (no SecretStorage persistence)
- `offline_access` scope is stripped (no refresh tokens)
- TLS verification is forced on
- Log level clamped to `info`
- URLs and settings are redacted in logs
- Automation session (password grant) is disabled
- All secrets are wiped on deactivate

See `docs/secure-mode.md` for full reference.

## Testing Conventions

- Jest with ts-jest transform
- Module stubs in `__tests__/stubs/` (vscode mock auto-loaded via jest.config moduleNameMapper)
- Config stub provides `__setSettings()` / `__resetSettings()` for test control
- E2E tests use real Keycloak + Platform API backend

## Key Patterns

- **Settings enforcement**: `config.ts:getSettings()` applies secure-mode overrides at read time
- **Token storage**: `auth.ts` — `storePersisted()` gates on `isSecureMode()` for in-memory vs persistent
- **Log redaction**: `secure-mode.ts` — `redactUrl()` and `redactSettings()` used across all modules
- **Error handling**: `errors.ts` — `withRetry()` for exponential backoff, `categorizeConnectionError()` for user-facing messages
