#!/usr/bin/env bash

set -Eeuo pipefail

compose_file=""
output_path=""
platform_stopped=false

while (($# > 0)); do
  case "$1" in
    --compose-file) compose_file="${2:?--compose-file requires a file}"; shift 2 ;;
    --output) output_path="${2:?--output requires a file}"; shift 2 ;;
    --platform-stopped) platform_stopped=true; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ -z "${compose_file}" || -z "${output_path}" || "${platform_stopped}" != true ]]; then
  echo "usage: full-backup.sh --compose-file FILE --output FILE --platform-stopped" >&2
  exit 2
fi
if [[ ! -f "${compose_file}" ]]; then echo "Compose file does not exist." >&2; exit 2; fi
readonly running_services="$(docker compose --file "${compose_file}" ps --status running --services)"
if grep -Eq '^(autoforge|worker)$' <<<"${running_services}"; then
  echo "Stop the autoforge and worker services before taking a Full backup." >&2
  exit 2
fi

mkdir -p -- "$(dirname -- "${output_path}")"
readonly output_directory="$(cd -- "$(dirname -- "${output_path}")" && pwd -P)"
readonly resolved_output_path="${output_directory}/$(basename -- "${output_path}")"
readonly staging_directory="$(mktemp -d)"
cleanup() { rm -rf -- "${staging_directory}"; }
trap cleanup EXIT
mkdir -p -- "${staging_directory}/autoforge-full-backup/minio-objects"

docker compose --file "${compose_file}" exec -T postgres \
  pg_dump --format=custom --no-owner --no-acl --username=autoforge --dbname=autoforge \
  >"${staging_directory}/autoforge-full-backup/postgres.dump"
docker compose --file "${compose_file}" run --rm --no-deps \
  --volume "${staging_directory}/autoforge-full-backup:/backup" \
  --entrypoint sh autoforge -eu -c \
  'tar -C /var/lib/autoforge -czf /backup/platform-data.tar.gz .'
docker compose --file "${compose_file}" run --rm --no-deps \
  --volume "${staging_directory}/autoforge-full-backup:/backup" \
  --entrypoint /bin/sh minio-init -eu -c '
    minio_user="$(cat /run/secrets/minio-root-user)"
    minio_password="$(cat /run/secrets/minio-root-password)"
    mc --config-dir /tmp/.mc alias set autoforge http://minio:9000 "${minio_user}" "${minio_password}"
    mc --config-dir /tmp/.mc mirror --overwrite autoforge/autoforge-objects /backup/minio-objects
  '
node --input-type=module - "${staging_directory}/autoforge-full-backup/backup-manifest.json" <<'NODE'
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], `${JSON.stringify({
  schemaVersion: 1,
  product: "AutoForge",
  mode: "full",
  createdAt: new Date().toISOString(),
  consistency: "web-and-worker-stopped",
  includes: ["PostgreSQL custom dump", "MinIO objects", "shared platform configuration and keys"],
  rebuildable: ["NATS JetStream dispatch messages", "Redis cache and rate-limit state"],
}, null, 2)}\n`, { mode: 0o600 });
NODE
tar --create --gzip --file "${resolved_output_path}" --directory "${staging_directory}" autoforge-full-backup
(
  cd -- "${output_directory}"
  sha256sum -- "$(basename -- "${resolved_output_path}")" >"$(basename -- "${resolved_output_path}").sha256"
)
printf 'Created consistent Full backup: %s\n' "${resolved_output_path}"
