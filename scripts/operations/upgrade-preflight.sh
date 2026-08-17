#!/usr/bin/env bash

set -Eeuo pipefail

data_directory=""
release_directory=""
backup_path=""

while (($# > 0)); do
  case "$1" in
    --data-dir) data_directory="${2:?--data-dir requires a directory}"; shift 2 ;;
    --release-dir) release_directory="${2:?--release-dir requires a directory}"; shift 2 ;;
    --backup) backup_path="${2:?--backup requires a file}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "${data_directory}" || -z "${release_directory}" || -z "${backup_path}" ]]; then
  echo "usage: upgrade-preflight.sh --data-dir DIR --release-dir DIR --backup FILE" >&2
  exit 2
fi
for required in "${data_directory}/config/platform.json" "${release_directory}/release-manifest.json" \
  "${release_directory}/SHA256SUMS" "${backup_path}" "${backup_path}.sha256"; do
  if [[ ! -f "${required}" ]]; then echo "Required file is missing: ${required}" >&2; exit 2; fi
done

(
  cd -- "${release_directory}"
  LC_ALL=C sha256sum --check --strict SHA256SUMS
)
(
  cd -- "$(dirname -- "${backup_path}")"
  LC_ALL=C sha256sum --check --strict "$(basename -- "${backup_path}").sha256"
)
node - "${data_directory}/config/platform.json" "${release_directory}/release-manifest.json" <<'NODE'
const { readFileSync } = require("node:fs");
const configuration = JSON.parse(readFileSync(process.argv[2], "utf8"));
const release = JSON.parse(readFileSync(process.argv[3], "utf8"));
if (configuration.schemaVersion !== 1) throw new Error("Unsupported platform configuration schema.");
if (release.schemaVersion !== 1 || release.product !== "AutoForge") throw new Error("Invalid release manifest.");
if (!Array.isArray(release.artifacts) || release.artifacts.length === 0) throw new Error("Release has no artifacts.");
process.stdout.write(`Configuration revision ${configuration.revision}; target release ${release.version}.\n`);
NODE

readonly data_bytes="$(du -sk -- "${data_directory}" | awk '{print $1 * 1024}')"
readonly free_bytes="$(df -Pk -- "${data_directory}" | awk 'NR==2 {print $4 * 1024}')"
if ((free_bytes < data_bytes * 2)); then
  echo "Upgrade preflight failed: free disk must be at least twice the current data size." >&2
  exit 1
fi
printf 'Upgrade preflight passed: data=%s bytes, free=%s bytes.\n' "${data_bytes}" "${free_bytes}"
