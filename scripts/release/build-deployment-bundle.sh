#!/usr/bin/env bash

set -Eeuo pipefail

readonly script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/common.sh
source "${script_directory}/common.sh"

readonly version="$(normalize_version "${1:?usage: build-deployment-bundle.sh VERSION [OUTPUT_DIR]}")"
readonly output_directory="$(release_output_directory "${2:-dist/release}")"
readonly package_name="autoforge-deploy-${version}"
readonly output_path="${output_directory}/${package_name}.tar.gz"
readonly staging_directory="$(mktemp -d)"

cleanup() {
  rm -rf -- "${staging_directory}"
}
trap cleanup EXIT

release_created_at >/dev/null
mkdir -p -- "${output_directory}"
cp -R -- "${repository_root}/deploy/compose" "${staging_directory}/${package_name}"
cp -R -- "${repository_root}/scripts/operations" "${staging_directory}/${package_name}/operations"
cp -R -- "${repository_root}/docs" "${staging_directory}/${package_name}/docs"
cp -- "${repository_root}/LICENSE" "${repository_root}/NOTICE" \
  "${repository_root}/THIRD_PARTY_LICENSES.json" "${repository_root}/CHANGELOG.md" \
  "${repository_root}/COMPATIBILITY.md" "${repository_root}/release-signing-public-key.pem" \
  "${staging_directory}/${package_name}/"

while IFS= read -r environment_example; do
  sed -i "s/VERSION/${version}/g" "${environment_example}"
done < <(find "${staging_directory}/${package_name}" -name .env.example -type f -print)

printf '%s\n' "${version}" >"${staging_directory}/${package_name}/VERSION"

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

printf 'Built %s\n' "${output_path}"
