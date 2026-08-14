#!/usr/bin/env bash

set -Eeuo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

readonly version="$(normalize_version "${1:?usage: build-backend-image.sh VERSION VARIANT [OUTPUT_DIR]}")"
readonly variant="${2:?usage: build-backend-image.sh VERSION VARIANT [OUTPUT_DIR]}"
require_variant "${variant}"
readonly output_directory="$(release_output_directory "${3:-dist/release}")"

readonly glibc_node_image="node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203"
readonly musl_node_image="node:24.16.0-alpine3.23@sha256:2bdb65ed1dab192432bc31c95f94155ca5ad7fc1392fb7eb7526ab682fa5bf14"

case "${variant}" in
  amd64)
    readonly platform="linux/amd64"
    readonly node_image="${glibc_node_image}"
    ;;
  arm64)
    readonly platform="linux/arm64"
    readonly node_image="${glibc_node_image}"
    ;;
  amd64-musl)
    readonly platform="linux/amd64"
    readonly node_image="${musl_node_image}"
    ;;
  arm64-musl)
    readonly platform="linux/arm64"
    readonly node_image="${musl_node_image}"
    ;;
esac

mkdir -p "${output_directory}"

readonly image_reference="autoforge/backend:${version}-${variant}"
readonly docker_archive="${output_directory}/autoforge-backend-${version}-${variant}.docker.tar"
readonly compressed_archive="${docker_archive}.zst"
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

# Release latency matters more than the small size gain from zstd level 19.
zstd --threads=0 -10 -f "${docker_archive}" -o "${compressed_archive}"

if [[ "${AUTOFORGE_KEEP_DOCKER_TAR:-0}" != "1" ]]; then
  rm -- "${docker_archive}"
fi

printf '%s\n' "${compressed_archive}"
