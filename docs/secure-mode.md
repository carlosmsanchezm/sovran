# Aegis Secure Mode Reference

## Why Secure Mode Exists

Traditional CUI environments force engineers to RDP into virtual machines (e.g., AWS Workspaces) inside a network boundary. With properly locked-down RDP (clipboard disabled, drive redirection disabled), the user sees only pixels — CUI data never leaves the VM. This provides strong data containment but creates a terrible developer experience: browser-based Jupyter, latency from multiple network hops, no real IDE.

Sovran's secure mode takes a different approach: instead of keeping data inside a VM boundary by restricting the user to pixels, it allows real VS Code Remote access to workspace pods while ensuring **no CUI persists on the local endpoint after the session ends** and protecting data in transit with single-use tokens.

### How Sovran Protects CUI Data on the Endpoint

| Protection Layer | What It Does | Implementation |
|---|---|---|
| **RAM-disk sandbox** | All VS Code runtime data (user-data, extensions, cache, temp files) lives on an encrypted RAM disk. Destroyed on session exit. | Secure Launcher creates RAM disk, sets `TMPDIR`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` to RAM disk paths |
| **Hot exit disabled** | VS Code normally caches unsaved file content to disk for crash recovery. Disabled in secure mode — editor buffers exist only in process memory. | `files.hotExit: "off"` pre-seeded in settings.json |
| **Ephemeral tokens** | Auth tokens stored in-memory only, never written to VS Code SecretStorage. No refresh tokens requested or stored. | `auth.ts` — `storePersisted()` skips `context.secrets.store()` in secure mode |
| **Full disk encryption** | FDE (FileVault/LUKS) verified at launch. Even if data touches persistent disk, it's encrypted. | Launcher checks `fdesetup status` (macOS) or `cryptsetup isLuks` (Linux) before creating RAM disk |
| **Session cleanup** | On exit: all secrets wiped from VS Code, RAM disk unmounted and destroyed. Terminal prints "No CUI persists on disk." | `extension.ts` — `clearAllSecrets()` on deactivate; launcher trap unmounts RAM disk on exit/SIGINT/SIGTERM |
| **Log sanitization** | URLs redacted, response bodies suppressed, settings masked. Logs clamped to `info` level. | `secure-mode.ts` — `redactUrl()`, `redactSettings()` |
| **TLS enforcement** | TLS certificate verification forced on, cannot be disabled. Warnings logged if bypass is attempted. | `config.ts` forces `rejectUnauthorized: true`; `http.ts` ignores override in secure mode |
| **No automation credentials** | Password grant and `.env` file loading disabled. Authentication must go through browser-based OIDC PKCE flow. | `auth.ts` — `automationSessionFromEnv()` returns `undefined` in secure mode |

### Comparison to Traditional RDP/VDI Access

| Property | RDP/Workspaces (locked down) | Sovran Secure Mode |
|---|---|---|
| **CUI on local disk after session** | Nothing (pixels only) | **Nothing** — RAM disk destroyed, hotExit off, secrets wiped |
| **CUI in memory during session** | Yes (pixel buffer in RDP client) | Yes (editor buffer in VS Code process memory) |
| **File download** | Disabled via drive redirection policy | **No download UI** — WebSocket tunnel uses VS Code Remote Authority binary protocol, not HTTP file transfer |
| **Clipboard during session** | Can be disabled via RDP policy | Not restricted (OS-level — requires MDM enforcement) |
| **Attack surface** | Full VM OS on the network | Single container pod — non-root, read-only rootfs, namespace-isolated, NetworkPolicy |
| **Session security** | Long-lived RDP session | Single-use JWT, 5-min TTL, JTI replay prevention |
| **Lateral movement** | VM can reach anything on VPC | Pod isolated by Kubernetes namespace + NetworkPolicy |
| **Post-session cleanup** | VM retains all data (persists between sessions) | RAM disk destroyed, secrets wiped, process killed |
| **Developer experience** | Browser-based Jupyter on remote desktop | Native VS Code with full terminal, debugging, GPU access |

### Known Gap: Clipboard

During an active session, a user can copy text from the VS Code editor to the OS clipboard. This clipboard data persists after the session ends. RDP can disable clipboard redirection at the protocol level — Sovran cannot today because clipboard is managed by the OS, not VS Code.

**Mitigation path:** MDM (Mobile Device Management) policy enforcement at the OS level. This is tracked in `docs/compliance-roadmap.md` as a P1 item.

### Where Sovran Secure Mode Operates

Sovran's data protections apply to the **local endpoint** (the engineer's workstation). The platform-level protections (mTLS, OIDC, RBAC, audit logging, namespace isolation) are enforced by the Aegis hub and spoke independently. These are separate, layered security controls — compromising the endpoint doesn't bypass platform authentication, and compromising platform auth doesn't give access to endpoint data.

---

## What is Secure Mode?

Secure Mode is an opt-in toggle for the Aegis VS Code extension, activated by setting the environment variable `AEGIS_SECURE_LAUNCH=1`. It is designed for environments handling CUI (Controlled Unclassified Information) under NIST 800-171 / CMMC Level 2.

## How to Activate

Set the environment variable before starting VS Code:

```bash
export AEGIS_SECURE_LAUNCH=1
code .
```

Or use the **Secure Launcher** scripts in `aegis-vscode-remote/launcher/` which set this automatically and also create a RAM-disk sandbox.

## Behavior Comparison

| Behavior | Normal Mode (default) | Secure Mode (`AEGIS_SECURE_LAUNCH=1`) |
|----------|----------------------|---------------------------------------|
| Token storage | VS Code SecretStorage (persists) | In-memory only (ephemeral) |
| Refresh tokens | Requested (`offline_access`) | Not requested, stripped if received |
| TLS verification | Configurable (default on) | Forced on, cannot disable |
| Log level | User configurable (info/debug/trace) | Clamped to `info` max |
| Log content | URLs logged, response bodies logged | URLs redacted, bodies suppressed |
| Hex payload preview | Removed (unconditional) | Removed (unconditional) |
| Settings in logs | Full JSON | Redacted (auth masked, caPath hidden) |
| Automation session | Password grant + file loading work | Disabled entirely |
| On deactivate | Session revocation (best-effort) | Session revocation + secret wipe |

## How It Works

### Settings Enforcement (`config.ts`)

When `isSecureMode()` returns `true`:
- `security.rejectUnauthorized` is forced to `true` regardless of user settings
- `logLevel` is clamped to `info` (no `debug` or `trace`)
- `offline_access` is filtered from `auth.scopes`
- `isSecureMode: true` is added to the settings object

### Ephemeral Authentication (`auth.ts`)

- `storePersisted()` keeps tokens in memory only — no `context.secrets.store()` call
- `ensurePersistedSession()` returns only the in-memory session — no `context.secrets.get()` call
- `createSession()` filters `offline_access` from requested scopes
- `buildPersistedFromResponse()` forces `refreshToken: undefined`
- `automationSessionFromEnv()` returns `undefined` immediately (no password grant, no file loading)
- `clearAllSecrets()` is called during `deactivate()` to wipe any residual secret keys

### Log Sanitization

- **URLs** are redacted via `redactUrl()` — strips query params, fragments, JWT-like strings
- **Settings** are redacted via `redactSettings()` — masks `auth.authority` to hostname only, omits `caPath`, replaces scopes with count
- **Response bodies** in `connection.ts` are suppressed entirely in secure mode, capped to 256 chars in normal mode
- **Hex payload previews** are unconditionally removed (replaced with byte count)

### TLS Defense-in-Depth (`http.ts`)

If `rejectUnauthorized=false` is somehow set while in secure mode, the HTTP module logs a warning and ignores the setting.

## How to Test

### Unit tests

```bash
# Run unit tests with secure mode active
AEGIS_SECURE_LAUNCH=1 npm run test:unit

# Run in normal mode (default)
npm run test:unit
```

### Manual testing with the Secure Launcher

**Prerequisites:** Run `npm run build` first — VS Code loads from `out/`, not `src/`.

```bash
AEGIS_SKIP_FDE_CHECK=1 \
AEGIS_RAM_SIZE_MB=256 \
NODE_EXTRA_CA_CERTS="$HOME/aegis-step-ca-root.pem" \
bash aegis-vscode-remote/launcher/aegis-secure-launch.sh \
  --extensionDevelopmentPath="$HOME/code/sovran/aegis-vscode-remote/extension" \
  --enable-proposed-api aegis.aegis-remote \
  "$HOME/code/sovran"
```

`AEGIS_SKIP_FDE_CHECK=1` bypasses the FileVault check for dev machines. In production the check is enforced.

**What to verify:**

1. Open output channel (`Cmd+Shift+P` → "Aegis: Show Logs") — look for `[secure-mode] ACTIVE`
2. `Aegis: Sign In` opens browser to Keycloak (not password grant)
3. Logs show `[auth] automationSessionFromEnv disabled in secure mode`
4. Settings changes show redacted output (hostname only for authority, no caPath)
5. Closing VS Code prints "RAM disk destroyed. No CUI persists on disk." in the terminal

**Note:** Do NOT pass `AEGIS_TEST_USERNAME`/`AEGIS_TEST_PASSWORD` — secure mode ignores them. Authentication must go through the browser-based PKCE flow.

## Impact on Development

**None when the env var is unset.** The developer workflow is completely unchanged. All secure mode behaviors are gated behind `isSecureMode()` which checks `process.env.AEGIS_SECURE_LAUNCH === '1'`.

The **only unconditional change** is the removal of hex payload previews in trace logs, which has no impact on functionality.

## Launcher Scripts

See `aegis-vscode-remote/launcher/README.md` for the Secure Launcher documentation.
