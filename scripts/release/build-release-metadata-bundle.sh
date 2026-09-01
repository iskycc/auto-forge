#!/usr/bin/env bash

set -Eeuo pipefail

readonly script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/common.sh
source "${script_directory}/common.sh"

readonly version="$(normalize_version "${1:?usage: build-release-metadata-bundle.sh VERSION [OUTPUT_DIR]}")"
readonly output_directory="$(release_output_directory "${2:-dist/release}")"
readonly package_name="autoforge-release-metadata-${version}"
readonly output_path="${output_directory}/${package_name}.tar.gz"
readonly staging_directory="$(mktemp -d)"
readonly package_directory="${staging_directory}/${package_name}"

readonly -a metadata_files=(
  "CHANGELOG.md"
  "COMPATIBILITY.md"
  "LICENSE"
  "NOTICE"
  "THIRD_PARTY_LICENSES.json"
)
readonly -a sbom_files=(
  "autoforge-backend-${version}-amd64.spdx.json"
  "autoforge-backend-${version}-arm64.spdx.json"
  "autoforge-deploy-${version}.spdx.json"
  "autoforge-jenkins-dependency-publisher-${version}.spdx.json"
  "autoforge-jenkins-execution-${version}.spdx.json"
)

cleanup() {
  rm -rf -- "${staging_directory}"
}
trap cleanup EXIT

require_regular_file() {
  local path="${1:?file path is required}"
  if [[ ! -f "${path}" ]]; then
    printf 'Required release metadata file is missing: %s\n' "${path}" >&2
    return 1
  fi
}

release_created_at >/dev/null
mkdir -p -- "${output_directory}" "${package_directory}/sbom"

for file_name in "${metadata_files[@]}"; do
  source_path="${repository_root}/${file_name}"
  if [[ "${file_name}" == "COMPATIBILITY.md" ]]; then
    source_path="${repository_root}/docs/reference/compatibility.md"
  fi
  require_regular_file "${source_path}"
  cp -- "${source_path}" "${package_directory}/${file_name}"
done

for file_name in "${sbom_files[@]}"; do
  source_path="${output_directory}/${file_name}"
  require_regular_file "${source_path}"
  cp -- "${source_path}" "${package_directory}/sbom/${file_name}"
done

tar \
  --sort=name \
  --mtime="@${SOURCE_DATE_EPOCH:-0}" \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  --pax-option=delete=atime,delete=ctime \
  --create \
  --file=- \
  --directory="${staging_directory}" \
  "${package_name}" | gzip -n >"${output_path}"

# These exact SBOM inputs are now represented by the signed metadata archive.
# Remove them only after the deterministic archive has been created successfully.
for file_name in "${sbom_files[@]}"; do
  rm -- "${output_directory}/${file_name}"
done

printf 'Built %s\n' "${output_path}"
