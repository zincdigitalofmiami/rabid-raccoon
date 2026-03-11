#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -z "${MES_SYNC_CLOUD_DATABASE_URL:-}" ]]; then
  echo "MES_SYNC_CLOUD_DATABASE_URL is required"
  exit 1
fi

if [[ -z "${LOCAL_DATABASE_URL:-}" ]]; then
  echo "LOCAL_DATABASE_URL is required"
  exit 1
fi

cd "${REPO_ROOT}"
if [[ -x "${REPO_ROOT}/node_modules/.bin/tsx" ]]; then
  exec "${REPO_ROOT}/node_modules/.bin/tsx" "${REPO_ROOT}/scripts/sync-mes-cloud-to-local.ts" "$@"
fi

exec npx --yes tsx "${REPO_ROOT}/scripts/sync-mes-cloud-to-local.ts" "$@"
