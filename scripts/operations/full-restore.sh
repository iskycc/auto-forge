#!/usr/bin/env bash

set -Eeuo pipefail

compose_file=""
input_path=""
replace_existing=false
platform_stopped=false

while (($# > 0)); do
  case "$1" in
    --compose-file) compose_file="${2:?--compose-file requires a file}"; shift 2 ;;
    --input) input_path="${2:?--input requires a file}"; shift 2 ;;
    --replace-existing) replace_existing=true; shift ;;
    --platform-stopped) platform_stopped=true; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ -z "${compose_file}" || -z "${input_path}" || "${replace_existing}" != true || "${platform_stopped}" != true ]]; then
  echo "usage: full-restore.sh --compose-file FILE --input FILE --platform-stopped --replace-existing" >&2
  exit 2
fi
if [[ ! -f "${compose_file}" || ! -f "${input_path}" || ! -f "${input_path}.sha256" ]]; then
  echo "Compose, backup, or checksum file is missing." >&2
  exit 2
fi
readonly running_services="$(docker compose --file "${compose_file}" ps --status running --services)"
if grep -Eq '^(autoforge|worker)$' <<<"${running_services}"; then
  echo "Stop the autoforge and worker services before restore." >&2
  exit 2
fi
readonly input_directory="$(cd -- "$(dirname -- "${input_path}")" && pwd -P)"
readonly input_name="$(basename -- "${input_path}")"
(
  cd -- "${input_directory}"
  LC_ALL=C sha256sum --check --strict "${input_name}.sha256"
)
readonly staging_directory="$(mktemp -d)"
cleanup() { rm -rf -- "${staging_directory}"; }
trap cleanup EXIT
tar --extract --gzip --file "${input_directory}/${input_name}" --directory "${staging_directory}"
readonly backup_root="${staging_directory}/autoforge-full-backup"
node --input-type=module - "${backup_root}/backup-manifest.json" <<'NODE'
import { readFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (manifest.schemaVersion !== 1 || manifest.product !== "AutoForge" || manifest.mode !== "full") {
  throw new Error("Backup manifest is not a supported AutoForge Full backup.");
}
NODE

docker compose --file "${compose_file}" exec -T postgres \
  psql --username=autoforge --dbname=autoforge --set=ON_ERROR_STOP=1 \
  --command='DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
docker compose --file "${compose_file}" exec -T postgres \
  pg_restore --no-owner --no-acl --username=autoforge --dbname=autoforge \
  <"${backup_root}/postgres.dump"
docker compose --file "${compose_file}" run --rm --no-deps \
  --volume "${backup_root}:/backup:ro" --entrypoint sh autoforge -eu -c '
    find /var/lib/autoforge -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
    tar -C /var/lib/autoforge -xzf /backup/platform-data.tar.gz
  '
docker compose --file "${compose_file}" run --rm --no-deps \
  --volume "${backup_root}:/backup:ro" --entrypoint /bin/sh minio-init -eu -c '
    minio_user="$(cat /run/secrets/minio-root-user)"
    minio_password="$(cat /run/secrets/minio-root-password)"
    mc --config-dir /tmp/.mc alias set autoforge http://minio:9000 "${minio_user}" "${minio_password}"
    mc --config-dir /tmp/.mc mirror --overwrite --remove /backup/minio-objects autoforge/autoforge-objects
  '
printf 'Full restore completed. Rotate platform, database, object-store, LDAP, and Runner credentials before reopening access.\n'
