#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-rabid-raccoon-postgres}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-rabid_raccoon}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required but not installed."
  exit 1
fi

if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
  if docker ps --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
    echo "Postgres container '${CONTAINER_NAME}' is already running."
  else
    echo "Starting existing Postgres container '${CONTAINER_NAME}'..."
    docker start "${CONTAINER_NAME}" >/dev/null
  fi
else
  echo "Creating Postgres container '${CONTAINER_NAME}'..."
  docker run -d \
    --name "${CONTAINER_NAME}" \
    -e POSTGRES_USER="${POSTGRES_USER}" \
    -e POSTGRES_PASSWORD="${POSTGRES_PASSWORD}" \
    -e POSTGRES_DB="${POSTGRES_DB}" \
    -p "${POSTGRES_PORT}:5432" \
    postgres:16 >/dev/null
fi

echo "Database container ready."
echo "DATABASE_URL=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT}/${POSTGRES_DB}?schema=public"

