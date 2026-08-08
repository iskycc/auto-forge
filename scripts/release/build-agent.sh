#!/usr/bin/env bash

set -Eeuo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

readonly version="$(normalize_version "${1:?usage: build-agent.sh VERSION VARIANT [OUTPUT_DIR]}")"
readonly variant="${2:?usage: build-agent.sh VERSION VARIANT [OUTPUT_DIR]}"
require_variant "${variant}"
readonly output_directory="$(release_output_directory "${3:-dist/release}")"
readonly output_path="${output_directory}/autoforge-agent-${version}-${variant}"

case "${variant}" in
  amd64 | amd64-musl) readonly go_architecture="amd64" ;;
  arm64 | arm64-musl) readonly go_architecture="arm64" ;;
esac

mkdir -p "${output_directory}"

readonly build_date="$(release_created_at)"
readonly revision="$(release_revision)"
readonly linker_flags="-s -w -buildid= -X main.version=${version} -X main.commit=${revision} -X main.buildDate=${build_date} -X main.variant=${variant}"

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
if [[ "${go_architecture}" == "amd64" && "${file_description}" != *"x86-64"* ]]; then
  echo "agent binary architecture mismatch: ${file_description}" >&2
  exit 1
fi
if [[ "${go_architecture}" == "arm64" && "${file_description}" != *"ARM aarch64"* ]]; then
  echo "agent binary architecture mismatch: ${file_description}" >&2
  exit 1
fi

printf '%s\n' "${output_path}"
