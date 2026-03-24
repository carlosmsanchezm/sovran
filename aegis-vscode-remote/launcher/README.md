# Aegis Secure Launcher

Scripts that launch VS Code inside a RAM-disk sandbox with `AEGIS_SECURE_LAUNCH=1`, ensuring no CUI (Controlled Unclassified Information) persists on the endpoint after the session ends.

## Prerequisites

- **Full Disk Encryption** enabled:
  - macOS: FileVault
  - Linux: LUKS
- VS Code installed (auto-detected or set `AEGIS_VSCODE_BIN`)
- The Aegis Remote extension VSIX installed in VS Code

## Usage

### macOS

```bash
./aegis-secure-launch.sh
# Or with extra VS Code args:
./aegis-secure-launch.sh -- --enable-proposed-api aegis.aegis-remote
```

### Linux

```bash
# Requires sudo for tmpfs mount
./aegis-secure-launch-linux.sh
```

## What the Launcher Does

1. **Verifies FDE** — checks FileVault (macOS) or LUKS (Linux) is enabled
2. **Creates a RAM disk** — `hdiutil` RAM disk (macOS) or `tmpfs` (Linux)
3. **Pre-seeds VS Code settings** — disables telemetry, hot exit, auto-update, crash reporter, settings sync
4. **Sets `AEGIS_SECURE_LAUNCH=1`** — activates secure mode in the Aegis extension
5. **Redirects all VS Code data dirs** — user-data, extensions, cache, crash reports all go to RAM
6. **Launches VS Code with `--wait`** — blocks until VS Code closes
7. **Destroys the RAM disk** — on exit (normal or signal), unmounts and detaches the RAM disk

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AEGIS_RAM_SIZE_MB` | `512` | Size of the RAM disk in MB |
| `AEGIS_VSCODE_BIN` | auto-detect | Path to VS Code binary |
| `AEGIS_SKIP_FDE_CHECK` | `0` | Linux only: set to `1` to skip LUKS check (not recommended) |

## Pre-seeded VS Code Settings

The launcher creates a `settings.json` with:

- `"telemetry.telemetryLevel": "off"` — no telemetry
- `"update.mode": "none"` — no auto-updates
- `"files.hotExit": "off"` — prevents unsaved content caching to disk
- `"settingsSync.enabled": false` — no cloud sync of settings
- `"workbench.enableExperiments": false` — no A/B testing
- Crash reporter disabled via `argv.json`

## Platform Support

| Platform | Script | FDE Check | RAM Disk |
|----------|--------|-----------|----------|
| macOS | `aegis-secure-launch.sh` | FileVault via `fdesetup` | `hdiutil` RAM disk |
| Linux | `aegis-secure-launch-linux.sh` | LUKS via `cryptsetup` | `tmpfs` (requires sudo) |
| Windows | Not yet supported | BitLocker | TBD |

## FIPS Notes

The launcher does not configure FIPS mode for Node.js/OpenSSL. VS Code bundles its own Node.js runtime which does not ship with a FIPS-validated OpenSSL provider. For FIPS compliance, the current approach documents that:

1. All TLS is handled by the OS TLS stack (configured in FIPS mode via MDM)
2. The extension delegates cryptographic operations to the OS where possible
3. This gap is tracked in `docs/compliance-roadmap.md` with a POA&M timeline
