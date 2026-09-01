#!/usr/bin/env bash

set -Eeuo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

readonly version="$(normalize_version "${1:?usage: build-agent.sh VERSION ARCHITECTURE [OUTPUT_DIR]}")"
readonly architecture="${2:?usage: build-agent.sh VERSION ARCHITECTURE [OUTPUT_DIR]}"
require_agent_architecture "${architecture}"
readonly output_directory="$(release_output_directory "${3:-dist/release}")"
readonly output_path="${output_directory}/autoforge-agent-${version}-${architecture}"

case "${architecture}" in
  amd64) readonly go_architecture="amd64" ;;
  arm64) readonly go_architecture="arm64" ;;
esac

mkdir -p "${output_directory}"

readonly build_date="$(release_created_at)"
readonly revision="$(release_revision)"
readonly linker_flags="-s -w -buildid= -X main.version=${version} -X main.commit=${revision} -X main.buildDate=${build_date} -X main.variant=${architecture}"

CGO_ENABLED=0 GOARCH="${go_architecture}" GOOS=linux \
  go -C "${repository_root}/apps/runner-agent" build \
  -buildvcs=false \
  -mod=readonly \
  -trimpath \
  -tags="netgo,osusergo" \
  -ldflags="${linker_flags}" \
  -o "${output_path}" \
  ./cmd/autoforge-agent

chmod 0755 "${output_path}"

readonly file_description="$(file --brief "${output_path}")"
if [[ "${file_description}" != *"statically linked"* ]]; then
  echo "agent binary is not statically linked: ${file_description}" >&2
  exit 1
fi
readonly program_headers="$(readelf --program-headers "${output_path}")"
if grep --quiet 'INTERP' <<<"${program_headers}"; then
  echo "agent binary unexpectedly requires a dynamic program interpreter" >&2
  exit 1
fi
readonly dynamic_section="$(readelf --dynamic "${output_path}" 2>/dev/null)"
if grep --quiet '(NEEDED)' <<<"${dynamic_section}"; then
  echo "agent binary unexpectedly requires a shared library" >&2
  exit 1
fi
readonly build_metadata="$(go version -m "${output_path}")"
if ! grep --quiet $'build\tCGO_ENABLED=0' <<<"${build_metadata}"; then
  echo "agent binary build metadata does not confirm CGO_ENABLED=0" >&2
  exit 1
fi
if [[ "${go_architecture}" == "amd64" && "${file_description}" != *"x86-64"* ]]; then
  echo "agent binary architecture mismatch: ${file_description}" >&2
  exit 1
fi
if [[ "${go_architecture}" == "arm64" && "${file_description}" != *"ARM aarch64"* ]]; then
  echo "agent binary architecture mismatch: ${file_description}" >&2
  exit 1
fi

printf '%s\n' "${output_path}"
