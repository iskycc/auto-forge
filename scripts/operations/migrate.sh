#!/usr/bin/env bash

set -Eeuo pipefail

compose_file=""
while (($# > 0)); do
  case "$1" in
    --compose-file) compose_file="${2:?--compose-file requires a file}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ -z "${compose_file}" || ! -f "${compose_file}" ]]; then
  echo "usage: migrate.sh --compose-file docker-compose.yml" >&2
  exit 2
fi
docker compose --file "${compose_file}" run --rm --no-deps autoforge \
  node apps/web/dist-server/server/migrate.js --data-dir=/var/lib/autoforge
