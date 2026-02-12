#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-rabid-raccoon-postgres}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required but not installed."
  exit 1
fi

if docker ps --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
  docker stop "${CONTAINER_NAME}" >/dev/null
  echo "Stopped '${CONTAINER_NAME}'."
else
  echo "Container '${CONTAINER_NAME}' is not running."
fi

