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
readonly package_directory="${staging_directory}/${package_name}"
readonly -a deployment_documentation=(
  "docs/architecture/ddt-management.md"
  "docs/legal/runner-toolchain-notices.md"
  "docs/manuals/administrator.md"
  "docs/manuals/api-runner-protocol.md"
  "docs/manuals/runner-operations.md"
  "docs/manuals/user.md"
  "docs/operations/backup-recovery.md"
  "docs/operations/capacity-incidents.md"
  "docs/operations/direct-terminal.md"
  "docs/operations/performance-baseline.md"
  "docs/operations/releases.md"
  "docs/operations/runner-agent-install.md"
  "docs/operations/runner-toolchain.md"
  "docs/operations/security-updates.md"
  "docs/reference/compatibility.md"
  "docs/security/audit-retention.md"
)

cleanup() {
  rm -rf -- "${staging_directory}"
}
trap cleanup EXIT

release_created_at >/dev/null
mkdir -p -- "${output_directory}"
cp -R -- "${repository_root}/deploy/compose" "${package_directory}"
cp -R -- "${repository_root}/scripts/operations" "${package_directory}/operations"
for documentation_path in "${deployment_documentation[@]}"; do
  destination_path="${package_directory}/${documentation_path}"
  mkdir -p -- "$(dirname -- "${destination_path}")"
  cp -- "${repository_root}/${documentation_path}" "${destination_path}"
done
cp -- "${repository_root}/LICENSE" "${repository_root}/NOTICE" \
  "${repository_root}/THIRD_PARTY_LICENSES.json" "${repository_root}/CHANGELOG.md" \
  "${package_directory}/"
cp -- "${repository_root}/docs/reference/compatibility.md" \
  "${package_directory}/COMPATIBILITY.md"
cp -- "${repository_root}/scripts/release/assets/release-signing-public-key.pem" \
  "${package_directory}/release-signing-public-key.pem"

while IFS= read -r environment_example; do
  sed -i "s/VERSION/${version}/g" "${environment_example}"
done < <(find "${staging_directory}/${package_name}" -name .env.example -type f -print)

printf '%s\n' "${version}" >"${package_directory}/VERSION"

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
