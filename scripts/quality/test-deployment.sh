#!/usr/bin/env bash

set -Eeuo pipefail

readonly repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly temporary_directory="$(mktemp -d)"

cleanup() {
  rm -rf -- "${temporary_directory}"
}
trap cleanup EXIT

cd "${repository_root}"

docker compose \
  --env-file deploy/compose/lite/.env.example \
  --file deploy/compose/lite/docker-compose.yml \
  config --quiet
docker compose \
  --env-file deploy/compose/full/.env.example \
  --file deploy/compose/full/docker-compose.yml \
  config --quiet

mkdir -p "${temporary_directory}/first" "${temporary_directory}/second"
SOURCE_DATE_EPOCH=1786233600 \
  bash scripts/release/build-deployment-bundle.sh 1.2.3 "${temporary_directory}/first"
SOURCE_DATE_EPOCH=1786233600 \
  bash scripts/release/build-deployment-bundle.sh 1.2.3 "${temporary_directory}/second"
cmp \
  "${temporary_directory}/first/autoforge-deploy-1.2.3.tar.gz" \
  "${temporary_directory}/second/autoforge-deploy-1.2.3.tar.gz"

printf 'Compose configuration and deterministic deployment bundle passed.\n'
