#!/usr/bin/env bash
set -Eeuo pipefail

readonly image="${1:?loaded release image is required}"
readonly expected_revision="$(git rev-parse HEAD)"
readonly image_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${image}")"
if [[ "${image_revision}" != "${expected_revision}" ]]; then
  echo 'Release image revision does not match the acceptance source.' >&2
  exit 1
fi
readonly container="$(docker create "${image}")"
readonly staging="$(mktemp -d)"
cleanup() {
  docker rm --volumes "${container}" >/dev/null
  rm -rf -- "${staging}"
}
trap cleanup EXIT

# Docker validates symlinks against the copied tree. Next's links point outside
# .next into /app/node_modules, so copy the complete /app before selecting outputs.
mkdir -p -- "${staging}/runtime"
docker cp "${container}:/app/." "${staging}/runtime"
for output in apps/web/.next apps/web/dist-server apps/worker/dist resources/agents resources/jenkins resources/log-archive-viewer; do
  # Replace generated files as a directory so older outputs cannot leak into the artifact.
  if [[ -e "${output}" ]]; then mv -- "${output}" "${staging}/previous-$(echo "${output}" | tr / -)"; fi
  mkdir -p -- "${output}"
  cp -a -- "${staging}/runtime/${output}/." "${output}/"
done
node scripts/quality/acceptance-build.mjs seal
