#!/usr/bin/env bash
# aegis-secure-launch-linux.sh — Linux Secure Launcher for Aegis VS Code Extension
#
# Creates a tmpfs mount (RAM-backed), verifies LUKS full disk encryption, and
# launches VS Code with all user-data and cache directories on tmpfs.
# On exit the tmpfs is unmounted, leaving no CUI on disk.
#
# Usage:
#   ./aegis-secure-launch-linux.sh [-- <extra VS Code args>]
#
# Environment:
#   AEGIS_RAM_SIZE_MB  Size of the tmpfs in MB (default: 512)
#   AEGIS_VSCODE_BIN   Path to VS Code binary (auto-detected)
#   AEGIS_SKIP_FDE_CHECK  Set to 1 to skip FDE verification (not recommended)

set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────
RAM_SIZE_MB="${AEGIS_RAM_SIZE_MB:-512}"
VSCODE_BIN="${AEGIS_VSCODE_BIN:-}"
SKIP_FDE="${AEGIS_SKIP_FDE_CHECK:-0}"

# ── Detect VS Code binary ───────────────────────────────────────────────────
if [[ -z "$VSCODE_BIN" ]]; then
  if command -v code &>/dev/null; then
    VSCODE_BIN="code"
  elif command -v code-insiders &>/dev/null; then
    VSCODE_BIN="code-insiders"
  else
    echo "ERROR: VS Code binary not found. Set AEGIS_VSCODE_BIN." >&2
    exit 1
  fi
fi

# ── Verify LUKS Full Disk Encryption ────────────────────────────────────────
if [[ "$SKIP_FDE" != "1" ]]; then
  echo "[aegis-launcher] Checking LUKS FDE status..."
  ROOT_DEV=$(findmnt -n -o SOURCE / 2>/dev/null || true)
  LUKS_FOUND=0

  if command -v cryptsetup &>/dev/null; then
    # Check if root device is on a LUKS-encrypted volume
    if [[ -n "$ROOT_DEV" ]]; then
      # Walk up to the parent device to check for LUKS
      PARENT_DEV=$(lsblk -no PKNAME "$ROOT_DEV" 2>/dev/null | head -1 || true)
      if [[ -n "$PARENT_DEV" ]]; then
        if cryptsetup isLuks "/dev/$PARENT_DEV" 2>/dev/null; then
          LUKS_FOUND=1
        fi
      fi
      # Also check if the device itself is a dm-crypt mapping
      if [[ "$ROOT_DEV" == /dev/dm-* ]] || [[ "$ROOT_DEV" == /dev/mapper/* ]]; then
        LUKS_FOUND=1
      fi
    fi
  fi

  if [[ "$LUKS_FOUND" != "1" ]]; then
    echo "ERROR: LUKS full disk encryption not detected on root filesystem." >&2
    echo "       FDE is required for CUI handling. Set AEGIS_SKIP_FDE_CHECK=1 to override." >&2
    exit 1
  fi
  echo "[aegis-launcher] LUKS FDE: detected"
else
  echo "[aegis-launcher] WARNING: FDE check skipped (AEGIS_SKIP_FDE_CHECK=1)"
fi

# ── Create tmpfs mount ──────────────────────────────────────────────────────
MOUNT_POINT=$(mktemp -d -t aegis-ramdisk-XXXXXXXX)
echo "[aegis-launcher] Creating ${RAM_SIZE_MB}MB tmpfs at $MOUNT_POINT..."
sudo mount -t tmpfs -o "size=${RAM_SIZE_MB}m,mode=0700,uid=$(id -u),gid=$(id -g)" tmpfs "$MOUNT_POINT"
echo "[aegis-launcher] tmpfs mounted at $MOUNT_POINT"

# ── Cleanup trap ─────────────────────────────────────────────────────────────
cleanup() {
  echo "[aegis-launcher] Cleaning up..."
  if mount | grep -q "$MOUNT_POINT"; then
    sudo umount "$MOUNT_POINT" 2>/dev/null || sudo umount -l "$MOUNT_POINT" 2>/dev/null || true
  fi
  rmdir "$MOUNT_POINT" 2>/dev/null || true
  echo "[aegis-launcher] tmpfs destroyed. No CUI persists on disk."
}
trap cleanup EXIT INT TERM

# ── Create directory structure on tmpfs ──────────────────────────────────────
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
