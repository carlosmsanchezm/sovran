#!/usr/bin/env bash
set -euo pipefail

trap 'echo "[reh] received termination signal"; exit 0' TERM INT

COMMIT="${VSCODE_COMMIT:-}"
if [ -z "${COMMIT}" ]; then
  echo "Set VSCODE_COMMIT to your local VS Code Insiders commit (code-insiders --version | sed -n '2p')."
  exit 1
fi

REH_DIR="/reh"
mkdir -p "$REH_DIR/bin/current" "$REH_DIR/workspace"

WORKSPACE_ROOT="/home/project"
if [ -e "$WORKSPACE_ROOT" ] && [ ! -d "$WORKSPACE_ROOT" ]; then
  rm -f "$WORKSPACE_ROOT"
fi
mkdir -p "$WORKSPACE_ROOT"
if [ ! -f "$WORKSPACE_ROOT/README.md" ]; then
  cat <<'EOF' > "$WORKSPACE_ROOT/README.md"
# Aegis Sample Workspace

This folder is provisioned by the Aegis mock remote server.

Feel free to add files here to validate remote editing via VS Code.
EOF
fi

# Detect architecture
ARCH="$(uname -m)"
if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
  ARCH_SUFFIX="arm64"
else
  ARCH_SUFFIX="x64"
fi

QUALITY="${VSCODE_QUALITY:-insider}"
BASE_URL="https://update.code.visualstudio.com"

TMP_TAR="$(mktemp /tmp/vscode-server-XXXXXX.tar.gz)"

COMMIT_URL="https://vscode.download.prss.microsoft.com/dbazure/download/${QUALITY}/${COMMIT}/vscode-server-linux-${ARCH_SUFFIX}.tar.gz"
API_URL="${BASE_URL}/commit/${COMMIT}/server-linux-${ARCH_SUFFIX}/${QUALITY}"
LATEST_URL="${BASE_URL}/latest/server-linux-${ARCH_SUFFIX}/${QUALITY}"

echo "Downloading VS Code server commit ${COMMIT} (${QUALITY}, ${ARCH_SUFFIX})..."
if ! curl -fsSL "$COMMIT_URL" -o "$TMP_TAR"; then
  if ! curl -fsSL "$API_URL" -o "$TMP_TAR"; then
    echo "Falling back to latest ${QUALITY} server for ${ARCH_SUFFIX}."
    curl -fsSL "$LATEST_URL" -o "$TMP_TAR"
  fi
fi

rm -rf "$REH_DIR/bin/current"
mkdir -p "$REH_DIR/bin/current"
tar -xzf "$TMP_TAR" -C "$REH_DIR/bin/current" --strip-components=1
rm "$TMP_TAR"

echo "hello" > "${REH_DIR}/token"

SERVER_BIN="code-server"
if [ "$QUALITY" = "insider" ]; then
  SERVER_BIN="code-server-insiders"
fi

exec "${REH_DIR}/bin/current/bin/${SERVER_BIN}" \
  --host 0.0.0.0 \
  --port 11111 \
  --telemetry-level off \
  --connection-token-file "${REH_DIR}/token" \
  --accept-server-license-terms \
  --disable-telemetry
