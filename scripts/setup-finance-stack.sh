#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${1:-$ROOT_DIR/.venv-finance}"
PYTHON_BIN="${PYTHON_BIN:-python3}"

echo "[finance-setup] root: $ROOT_DIR"
echo "[finance-setup] venv: $VENV_DIR"

"$PYTHON_BIN" -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --upgrade pip setuptools wheel
"$VENV_DIR/bin/pip" install -r "$ROOT_DIR/requirements-finance.txt"

echo "[finance-setup] running verification..."
"$VENV_DIR/bin/python" "$ROOT_DIR/scripts/verify-finance-stack.py"

echo "[finance-setup] complete"
