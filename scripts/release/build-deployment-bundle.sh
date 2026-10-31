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
  "docs/adr/0012-full-distributed-node-local-logs.md"
  "docs/adr/0013-platform-time-authority.md"
  "docs/adr/0015-full-postgresql-log-databases.md"
  "docs/adr/0017-full-postgresql-log-writes-only.md"
  "docs/architecture/batch-scheduling-pause.md"
  "docs/architecture/ddt-management.md"
  "docs/architecture/ddt-association-transfer.md"
  "docs/architecture/full-three-host-runtime-audit.md"
  "docs/architecture/read-model-snapshots.md"
  "docs/architecture/runtime-input-cache.md"
  "docs/architecture/runtime-resource-priority.md"
  "docs/legal/runner-toolchain-notices.md"
  "docs/manuals/administrator.md"
  "docs/manuals/platform-initialization.md"
  "docs/manuals/api-runner-protocol.md"
  "docs/manuals/runner-operations.md"
  "docs/manuals/user.md"
  "docs/operations/backup-recovery.md"
  "docs/operations/capacity-incidents.md"
  "docs/operations/direct-terminal.md"
  "docs/operations/ddt-transfer-verification.md"
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
mkdir -p -- "${package_directory}"
# Package templates only: local .env, generated secrets and mounted node data must never enter a release.
while IFS= read -r -d '' template_path; do
  relative_path="${template_path#"${repository_root}/deploy/compose/"}"
  mkdir -p -- "$(dirname -- "${package_directory}/${relative_path}")"
  cp -- "${template_path}" "${package_directory}/${relative_path}"
done < <(find "${repository_root}/deploy/compose" \
  -type d \( -name secrets -o -name config -o -name node-data \) -prune -o \
  -type f \( -name docker-compose.yml -o -name .env.example -o -name README.md \
    -o -name nginx.conf -o -name prepare-secrets.mjs \) -print0)
# Copy an explicit allowlist: generated credentials and bind data are private.
readonly -a fast_deploy_templates=(
  README.md
  node-a/docker-compose.yml node-a/.env.example
  node-b/docker-compose.yml node-b/.env.example
  node-c/docker-compose.yml node-c/.env.example
  log-postgres/docker-compose.yml log-postgres/.env.example log-postgres/README.md
)
for template in "${fast_deploy_templates[@]}"; do
  source_path="${repository_root}/fast-deploy/${template}"
  if [[ ! -s "${source_path}" ]]; then
    printf 'Missing fast-deploy release template: %s\n' "${source_path}" >&2
    exit 1
  fi
  destination_path="${package_directory}/fast-deploy/${template}"
  mkdir -p -- "$(dirname -- "${destination_path}")"
  cp -- "${source_path}" "${destination_path}"
done
sed -i 's|../../../docs/|../docs/|g' \
  "${package_directory}/distributed/README.md" \
  "${package_directory}/full-bind/README.md" \
  "${package_directory}/full-five-hosts/README.md"
sed -i \
  -e 's|../../../../fast-deploy/|../../fast-deploy/|g' \
  -e 's|../../../../docs/|../../docs/|g' \
  "${package_directory}/full-bind/three-hosts/README.md" \
  "${package_directory}/full-bind/log-postgres/README.md"
# Five-host deployment is part of the standard signed deployment asset. Fail the
# release build if a host template or its IP-only proxy configuration is missing.
required_five_host_templates=(README.md nginx/nginx.conf)
for host in platform-1 platform-2 platform-3 nginx infrastructure; do
  required_five_host_templates+=("${host}/docker-compose.yml" "${host}/.env.example")
done
for template in "${required_five_host_templates[@]}"; do
  required_template="${package_directory}/full-five-hosts/${template}"
  if [[ ! -s "${required_template}" ]]; then
    printf 'Missing five-host release template: %s\n' "${required_template}" >&2
    exit 1
  fi
done
cp -R -- "${repository_root}/scripts/operations" "${package_directory}/operations"
for documentation_path in "${deployment_documentation[@]}"; do
  destination_path="${package_directory}/${documentation_path}"
  mkdir -p -- "$(dirname -- "${destination_path}")"
  cp -- "${repository_root}/${documentation_path}" "${destination_path}"
done
sed -i 's|scripts/operations/verify_ddt_transfer.py|operations/verify_ddt_transfer.py|g' \
  "${package_directory}/docs/operations/ddt-transfer-verification.md"
cp -- "${repository_root}/LICENSE" "${repository_root}/NOTICE" \
  "${repository_root}/THIRD_PARTY_LICENSES.json" "${repository_root}/CHANGELOG.md" \
  "${package_directory}/"
cp -- "${repository_root}/docs/reference/compatibility.md" \
  "${package_directory}/COMPATIBILITY.md"
cp -- "${repository_root}/scripts/release/assets/release-signing-public-key.pem" \
  "${package_directory}/release-signing-public-key.pem"

while IFS= read -r environment_example; do
  sed -i "s/:VERSION-/:${version}-/g" "${environment_example}"
done < <(find "${staging_directory}/${package_name}" -name .env.example -type f -print)
sed -i -E "s|autoforge/backend:[0-9]+\.[0-9]+\.[0-9]+-amd64|autoforge/backend:${version}-amd64|g" \
  "${package_directory}/fast-deploy/node-a/docker-compose.yml"

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
