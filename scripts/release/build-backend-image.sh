#!/usr/bin/env bash

set -Eeuo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

readonly version="$(normalize_version "${1:?usage: build-backend-image.sh VERSION VARIANT [OUTPUT_DIR]}")"
readonly variant="${2:?usage: build-backend-image.sh VERSION VARIANT [OUTPUT_DIR]}"
require_backend_variant "${variant}"
readonly output_directory="$(release_output_directory "${3:-dist/release}")"

readonly node_image="node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203"

case "${variant}" in
  amd64)
    readonly platform="linux/amd64"
    ;;
  arm64)
    readonly platform="linux/arm64"
    ;;
esac

mkdir -p "${output_directory}"

readonly image_reference="autoforge/backend:${version}-${variant}"
readonly docker_archive="${output_directory}/autoforge-backend-${version}-${variant}.docker.tar"
readonly build_date="$(release_created_at)"
readonly revision="$(release_revision)"

bash "${repository_root}/scripts/release/build-agent-resources.sh" \
  "${version}" "${repository_root}/resources/agents"

buildx_cache_arguments=()
if [[ -n "${AUTOFORGE_BUILDX_CACHE_FROM:-}" ]]; then
  buildx_cache_arguments+=(--cache-from "${AUTOFORGE_BUILDX_CACHE_FROM}")
fi
if [[ -n "${AUTOFORGE_BUILDX_CACHE_TO:-}" ]]; then
  buildx_cache_arguments+=(--cache-to "${AUTOFORGE_BUILDX_CACHE_TO}")
fi

docker buildx build \
  "${buildx_cache_arguments[@]}" \
  --build-arg "CREATED=${build_date}" \
  --build-arg "NODE_IMAGE=${node_image}" \
  --build-arg "REVISION=${revision}" \
  --build-arg "VERSION=${version}" \
  --file "${repository_root}/deploy/docker/backend.Dockerfile" \
  --output "type=docker,dest=${docker_archive}" \
  --platform "${platform}" \
  --provenance=false \
  --tag "${image_reference}" \
  "${repository_root}"

readonly maximum_archive_bytes="${AUTOFORGE_BACKEND_IMAGE_MAX_BYTES:-188743680}"
readonly archive_bytes="$(stat --format='%s' "${docker_archive}")"
if (( archive_bytes > maximum_archive_bytes )); then
  echo "backend Docker archive exceeds the size budget: ${archive_bytes} > ${maximum_archive_bytes} bytes" >&2
  exit 1
fi
printf 'Backend Docker archive size: %s bytes (budget: %s bytes)\n' \
  "${archive_bytes}" "${maximum_archive_bytes}" >&2

printf '%s\n' "${docker_archive}"
