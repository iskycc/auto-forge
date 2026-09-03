#!/usr/bin/env bash

set -Eeuo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

readonly requested_version="${1:-$(node -p 'require(process.argv[1]).version' "${repository_root}/package.json")}"
readonly version="$(normalize_version "${requested_version}")"
readonly output_directory="$(release_output_directory "${2:-resources/agents}")"
readonly temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "${temporary_directory}"' EXIT

mkdir -p "${output_directory}/linux-amd64" "${output_directory}/linux-arm64"

bash "${repository_root}/scripts/release/build-agent.sh" "${version}" amd64 "${temporary_directory}"
bash "${repository_root}/scripts/release/build-agent.sh" "${version}" arm64 "${temporary_directory}"

install -m 0755 \
  "${temporary_directory}/autoforge-agent-${version}-amd64" \
  "${output_directory}/linux-amd64/autoforge-agent"
install -m 0755 \
  "${temporary_directory}/autoforge-agent-${version}-arm64" \
  "${output_directory}/linux-arm64/autoforge-agent"
install -m 0755 "${repository_root}/scripts/agent/install.sh" "${output_directory}/install.sh"

adapter_jar="${AUTOFORGE_ADAPTER_JAR:-}"
if [[ -z "${adapter_jar}" ]]; then
  mvn --quiet --file "${repository_root}/adapters/cotest-testng/pom.xml" -DskipTests package
  adapter_jar="${repository_root}/adapters/cotest-testng/target/cotest-testng-adapter-0.1.0-SNAPSHOT.jar"
fi
bash "${repository_root}/scripts/quality/verify-cotest-adapter-bytecode.sh" "${adapter_jar}"
install -m 0644 "${adapter_jar}" "${output_directory}/cotest-testng-adapter.jar"

node "${repository_root}/scripts/release/create-agent-resource-manifest.mjs" \
  "${version}" "$(release_revision)" "$(release_created_at)" "${output_directory}"

printf '%s\n' "${output_directory}/manifest.json"
