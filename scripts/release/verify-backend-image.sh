#!/usr/bin/env bash

set -Eeuo pipefail

readonly image_reference="${1:?usage: verify-backend-image.sh IMAGE PLATFORM}"
readonly platform="${2:?usage: verify-backend-image.sh IMAGE PLATFORM}"
container_id=""

cleanup() {
  if [[ -n "${container_id}" ]]; then
    docker rm --force "${container_id}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

container_id="$(docker run --detach --platform "${platform}" "${image_reference}")"

for _ in $(seq 1 60); do
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "${container_id}")"
  case "${status}" in
    healthy)
      exit 0
      ;;
    unhealthy | missing)
      docker logs "${container_id}" >&2
      echo "backend container health status: ${status}" >&2
      exit 1
      ;;
  esac
  sleep 1
done

docker logs "${container_id}" >&2
echo "backend container did not become healthy within 60 seconds" >&2
exit 1
