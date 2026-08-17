#!/usr/bin/env bash

set -Eeuo pipefail

input_path=""
data_directory=""
platform_stopped=false

while (($# > 0)); do
  case "$1" in
    --input) input_path="${2:?--input requires a file}"; shift 2 ;;
    --data-dir) data_directory="${2:?--data-dir requires a directory}"; shift 2 ;;
    --platform-stopped) platform_stopped=true; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "${input_path}" || -z "${data_directory}" ]]; then
  echo "usage: lite-restore.sh --input FILE --data-dir DIR --platform-stopped" >&2
  exit 2
fi
if [[ "${platform_stopped}" != true ]]; then
  echo "Refusing an online restore: stop AutoForge and pass --platform-stopped." >&2
  exit 2
fi
if [[ ! -f "${input_path}" || ! -f "${input_path}.sha256" ]]; then
  echo "The backup archive or its .sha256 file is missing." >&2
  exit 2
fi
if [[ -d "${data_directory}" && -n "$(find "${data_directory}" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "The restore target must not exist or must be empty; preserve the old data separately." >&2
  exit 2
fi

readonly input_directory="$(cd -- "$(dirname -- "${input_path}")" && pwd -P)"
readonly input_name="$(basename -- "${input_path}")"
(
  cd -- "${input_directory}"
  LC_ALL=C sha256sum --check --strict "${input_name}.sha256"
)
if tar --list --file "${input_directory}/${input_name}" | \
  awk 'BEGIN { bad=0 } /(^\/|(^|\/)\.\.($|\/))/ { bad=1 } END { exit bad ? 0 : 1 }'; then
  echo "The backup contains an unsafe path." >&2
  exit 2
fi

readonly staging_directory="$(mktemp -d)"
cleanup() {
  rm -rf -- "${staging_directory}"
}
trap cleanup EXIT
tar --extract --gzip --file "${input_directory}/${input_name}" --directory "${staging_directory}"
node - "${staging_directory}/autoforge-lite-backup/backup-manifest.json" <<'NODE'
const { readFileSync } = require("node:fs");
const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (manifest.schemaVersion !== 1 || manifest.product !== "AutoForge" || manifest.mode !== "lite") {
  throw new Error("Backup manifest is not a supported AutoForge Lite backup.");
}
NODE
(
  cd -- "${staging_directory}/autoforge-lite-backup"
  LC_ALL=C sha256sum --check --strict data-sha256sums
)
mkdir -p -- "${data_directory}"
cp -a -- "${staging_directory}/autoforge-lite-backup/data/." "${data_directory}/"
chmod 0700 -- "${data_directory}/config"
chmod 0600 -- "${data_directory}/config/platform.json"
printf 'Restored Lite data to: %s\n' "$(cd -- "${data_directory}" && pwd -P)"
