#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -x "${REPO_ROOT}/.venv-finance/bin/python" ]]; then
  PYTHON_BIN="${REPO_ROOT}/.venv-finance/bin/python"
else
  PYTHON_BIN="python3"
fi

exec "${PYTHON_BIN}" "${REPO_ROOT}/scripts/ingest-mes-live-1m.py" \
  --log-ingestion-runs \
  --dataset GLBX.MDP3 \
  --schema OHLCV_1M \
  --symbol MES.c.0 \
  --stype-in continuous \
  "$@"
