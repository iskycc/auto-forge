#!/usr/bin/env bash

set -Eeuo pipefail

data_directory=""
output_path=""
platform_stopped=false

while (($# > 0)); do
  case "$1" in
    --data-dir) data_directory="${2:?--data-dir requires a directory}"; shift 2 ;;
    --output) output_path="${2:?--output requires a file}"; shift 2 ;;
    --platform-stopped) platform_stopped=true; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "${data_directory}" || -z "${output_path}" ]]; then
  echo "usage: lite-backup.sh --data-dir DIR --output FILE --platform-stopped" >&2
  exit 2
fi
if [[ "${platform_stopped}" != true ]]; then
  echo "Refusing an inconsistent backup: stop AutoForge and pass --platform-stopped." >&2
  exit 2
fi
if [[ ! -d "${data_directory}" || ! -f "${data_directory}/config/platform.json" ]]; then
  echo "The data directory does not contain config/platform.json." >&2
  exit 2
fi

readonly resolved_data_directory="$(cd -- "${data_directory}" && pwd -P)"
if [[ "${resolved_data_directory}" == "/" ]]; then
  echo "The filesystem root cannot be used as an AutoForge data directory." >&2
  exit 2
fi
readonly output_directory="$(dirname -- "${output_path}")"
mkdir -p -- "${output_directory}"
readonly resolved_output_directory="$(cd -- "${output_directory}" && pwd -P)"
readonly resolved_output_path="${resolved_output_directory}/$(basename -- "${output_path}")"
readonly staging_directory="$(mktemp -d)"

cleanup() {
  rm -rf -- "${staging_directory}"
}
trap cleanup EXIT

mkdir -p -- "${staging_directory}/autoforge-lite-backup/data"
cp -a -- "${resolved_data_directory}/." "${staging_directory}/autoforge-lite-backup/data/"
(
  cd -- "${staging_directory}/autoforge-lite-backup"
  find data -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum >data-sha256sums
)
node - "${resolved_data_directory}/config/platform.json" \
  "${staging_directory}/autoforge-lite-backup/backup-manifest.json" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const configuration = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (configuration.mode !== "lite") throw new Error("Lite backup requires a Lite platform configuration.");
writeFileSync(process.argv[3], `${JSON.stringify({
  schemaVersion: 1,
  product: "AutoForge",
  mode: "lite",
  platformConfigurationSchemaVersion: configuration.schemaVersion,
  platformConfigurationRevision: configuration.revision,
  createdAt: new Date().toISOString(),
  consistency: "platform-stopped",
  includes: ["SQLite database", "object store", "platform configuration and keys"],
  fileIntegrityManifest: "data-sha256sums",
}, null, 2)}\n`, { mode: 0o600 });
NODE

tar --create --gzip --file "${resolved_output_path}" --directory "${staging_directory}" autoforge-lite-backup
(
  cd -- "${resolved_output_directory}"
  sha256sum -- "$(basename -- "${resolved_output_path}")" >"$(basename -- "${resolved_output_path}").sha256"
)
printf 'Created consistent Lite backup: %s\n' "${resolved_output_path}"
