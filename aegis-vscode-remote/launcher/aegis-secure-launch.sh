#!/usr/bin/env bash
# aegis-secure-launch.sh — macOS Secure Launcher for Aegis VS Code Extension
#
# Creates an encrypted RAM disk, pre-seeds restrictive VS Code settings, and
# launches VS Code with all user-data and cache directories on the RAM disk.
# On exit the RAM disk is unmounted and destroyed, leaving no CUI on disk.
#
# Usage:
#   ./aegis-secure-launch.sh [-- <extra VS Code args>]
#
# Environment:
#   AEGIS_RAM_SIZE_MB    Size of the RAM disk in MB (default: 512)
#   AEGIS_VSCODE_BIN     Path to VS Code binary (auto-detected)
#   AEGIS_SKIP_FDE_CHECK Set to 1 to skip FileVault check (dev/test only)

set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────
RAM_SIZE_MB="${AEGIS_RAM_SIZE_MB:-512}"
VSCODE_BIN="${AEGIS_VSCODE_BIN:-}"
SKIP_FDE="${AEGIS_SKIP_FDE_CHECK:-0}"

# ── Detect VS Code binary ───────────────────────────────────────────────────
if [[ -z "$VSCODE_BIN" ]]; then
  if command -v code &>/dev/null; then
    VSCODE_BIN="code"
  elif [[ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]]; then
    VSCODE_BIN="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
  elif [[ -x "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders" ]]; then
    VSCODE_BIN="/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders"
  else
    echo "ERROR: VS Code binary not found. Set AEGIS_VSCODE_BIN." >&2
    exit 1
  fi
fi

# ── Verify FileVault (Full Disk Encryption) ──────────────────────────────────
if [[ "$SKIP_FDE" != "1" ]]; then
  echo "[aegis-launcher] Checking FileVault status..."
  FV_STATUS=$(fdesetup status 2>/dev/null || true)
  if ! echo "$FV_STATUS" | grep -qi "FileVault is On"; then
    echo "ERROR: FileVault is not enabled. Full disk encryption is required." >&2
    echo "       Enable FileVault in System Settings > Privacy & Security." >&2
    echo "       For dev/test only: set AEGIS_SKIP_FDE_CHECK=1 to bypass." >&2
    exit 1
  fi
  echo "[aegis-launcher] FileVault: ON"
else
  echo "[aegis-launcher] WARNING: FileVault check skipped (AEGIS_SKIP_FDE_CHECK=1)"
fi

# ── Create RAM disk ─────────────────────────────────────────────────────────
SECTORS=$((RAM_SIZE_MB * 2048))
echo "[aegis-launcher] Creating ${RAM_SIZE_MB}MB RAM disk..."
RAM_DEV=$(hdiutil attach -nomount "ram://${SECTORS}")
RAM_DEV=$(echo "$RAM_DEV" | xargs)  # trim whitespace

MOUNT_POINT=$(mktemp -d -t aegis-ramdisk)
newfs_hfs -v "AegisSecure" "$RAM_DEV" >/dev/null 2>&1
mount -t hfs "$RAM_DEV" "$MOUNT_POINT"
echo "[aegis-launcher] RAM disk mounted at $MOUNT_POINT ($RAM_DEV)"

# ── Cleanup trap ─────────────────────────────────────────────────────────────
cleanup() {
  echo "[aegis-launcher] Cleaning up..."
  if mount | grep -q "$MOUNT_POINT"; then
    umount "$MOUNT_POINT" 2>/dev/null || umount -f "$MOUNT_POINT" 2>/dev/null || true
  fi
  hdiutil detach "$RAM_DEV" -force 2>/dev/null || true
  rmdir "$MOUNT_POINT" 2>/dev/null || true
  echo "[aegis-launcher] RAM disk destroyed. No CUI persists on disk."
}
trap cleanup EXIT INT TERM

# ── Create directory structure on RAM disk ───────────────────────────────────
USER_DATA_DIR="$MOUNT_POINT/user-data"
EXTENSIONS_DIR="$MOUNT_POINT/extensions"
CACHE_DIR="$MOUNT_POINT/cache"
CRASH_DIR="$MOUNT_POINT/crash"

mkdir -p "$USER_DATA_DIR/User" "$EXTENSIONS_DIR" "$CACHE_DIR" "$CRASH_DIR"

# ── Pre-seed settings.json ───────────────────────────────────────────────────
cat > "$USER_DATA_DIR/User/settings.json" <<'SETTINGS_EOF'
{
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "extensions.autoUpdate": false,
  "extensions.autoCheckUpdates": false,
  "workbench.enableExperiments": false,
  "workbench.settings.enableNaturalLanguageSearch": false,
  "files.hotExit": "off",
  "settingsSync.enabled": false
}
SETTINGS_EOF

# ── Pre-seed argv.json (disable crash reporter) ─────────────────────────────
cat > "$USER_DATA_DIR/argv.json" <<'ARGV_EOF'
{
  "enable-proposed-api": ["aegis.aegis-remote"],
  "enable-crash-reporter": false
}
ARGV_EOF

# ── Set environment variables ────────────────────────────────────────────────
export AEGIS_SECURE_LAUNCH=1
export TMPDIR="$CACHE_DIR"
export XDG_CACHE_HOME="$CACHE_DIR"
export XDG_CONFIG_HOME="$MOUNT_POINT/config"
export XDG_DATA_HOME="$MOUNT_POINT/data"

mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"

echo "[aegis-launcher] AEGIS_SECURE_LAUNCH=1"
echo "[aegis-launcher] Launching VS Code..."

# ── Launch VS Code ───────────────────────────────────────────────────────────
"$VSCODE_BIN" \
  --user-data-dir "$USER_DATA_DIR" \
  --extensions-dir "$EXTENSIONS_DIR" \
  --skip-add-to-recently-opened \
  --crash-reporter-directory "$CRASH_DIR" \
  --disable-gpu-shader-disk-cache \
  --wait \
  "$@"

echo "[aegis-launcher] VS Code exited."
