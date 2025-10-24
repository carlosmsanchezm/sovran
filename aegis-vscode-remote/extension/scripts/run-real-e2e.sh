#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${AEGIS_REAL_E2E_ENV:-.env.real-e2e}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "[run-real-e2e] Env file '$ENV_FILE' not found. Copy .env.real-e2e.example and fill in your values." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

npm run test:e2e:real
