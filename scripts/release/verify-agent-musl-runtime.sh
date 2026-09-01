#!/usr/bin/env bash

set -Eeuo pipefail

readonly agent_binary="$(realpath "${1:?usage: verify-agent-musl-runtime.sh AGENT_BINARY PLATFORM}")"
readonly platform="${2:?usage: verify-agent-musl-runtime.sh AGENT_BINARY PLATFORM}"
readonly musl_fixture_image="node:24.16.0-alpine3.23@sha256:2bdb65ed1dab192432bc31c95f94155ca5ad7fc1392fb7eb7526ab682fa5bf14"

if [[ ! -f "${agent_binary}" || ! -x "${agent_binary}" ]]; then
  printf 'Agent compatibility fixture is not executable: %s\n' "${agent_binary}" >&2
  exit 1
fi

case "${platform}" in
  linux/amd64 | linux/arm64) ;;
  *)
    printf 'Unsupported Agent compatibility platform: %s\n' "${platform}" >&2
    exit 1
    ;;
esac

docker run \
  --rm \
  --network none \
  --platform "${platform}" \
  --volume "${agent_binary}:/opt/autoforge-agent:ro" \
  --entrypoint /opt/autoforge-agent \
  "${musl_fixture_image}" \
  version >/dev/null

printf 'Verified Agent %s in an Alpine/musl user space.\n' "${platform}"
