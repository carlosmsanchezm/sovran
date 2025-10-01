#!/usr/bin/env bash
set -euo pipefail

COMMIT="${VSCODE_COMMIT:-}"
if [ -z "${COMMIT}" ]; then
  echo "Set VSCODE_COMMIT to your local VS Code Insiders commit (code-insiders --version | sed -n '2p')."
  exit 1
fi

REH_DIR="/reh"
mkdir -p "$REH_DIR/bin/current" "$REH_DIR/workspace"

# Detect architecture
ARCH="$(uname -m)"
if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
  ARCH_SUFFIX="arm64"
else
  ARCH_SUFFIX="x64"
fi

RELEASE_JSON_URL="https://api.github.com/repos/VSCodium/vscodium/releases/latest"
TAG="$(curl -sL ${RELEASE_JSON_URL} | jq -r .tag_name)"
PKG="vscodium-reh-linux-${ARCH_SUFFIX}-${TAG}.tar.gz"
URL="https://github.com/VSCodium/vscodium/releases/download/${TAG}/${PKG}"

echo "Downloading REH ${PKG} (tag ${TAG})..."
curl -fsSL "${URL}" -o "/tmp/${PKG}"
tar -xzf "/tmp/${PKG}" -C "$REH_DIR/bin/current"
rm "/tmp/${PKG}"

echo "hello" > "${REH_DIR}/token"

exec "${REH_DIR}/bin/current/bin/codium-server" \
  --host 0.0.0.0 \
  --port 11111 \
  --telemetry-level off \
  --connection-token-file "${REH_DIR}/token" \
  --accept-server-license-terms \
  --disable-telemetry
