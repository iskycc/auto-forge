#!/usr/bin/env bash
set -Eeuo pipefail
readonly task_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "${task_directory}"
if [[ ! -f .env ]]; then
  printf '%s\n' 'Copy .env.example to .env, edit NODE_A_IP/NODE_B_IP/NODE_C_IP and the loaded image version, then retry.' >&2
  exit 1
fi
task_version=''
task_arch=''
task_image=''
while IFS= read -r task_line || [[ -n "${task_line}" ]]; do
  task_line="${task_line%$'\r'}"
  case "${task_line}" in
    AUTOFORGE_VERSION=*) task_version="${task_line#*=}" ;;
    ARCH=*) task_arch="${task_line#*=}" ;;
    BACKEND_IMAGE=*) task_image="${task_line#*=}" ;;
  esac
done < .env
if [[ ! "${task_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || ! "${task_arch}" =~ ^(amd64|arm64)$ ]]; then
  printf '%s\n' 'Set AUTOFORGE_VERSION=X.Y.Z and ARCH=amd64 or arm64 in .env.' >&2
  exit 1
fi
task_image="${task_image:-autoforge/backend:${task_version}-${task_arch}}"
if [[ ! "${task_image}" =~ ^[a-zA-Z0-9][a-zA-Z0-9._:/@-]+$ ]]; then
  printf '%s\n' 'BACKEND_IMAGE must name a verified local image.' >&2
  exit 1
fi
docker image inspect "${task_image}" >/dev/null
docker run --rm --pull never --network none --user 0:0 --cpus=1 --memory=512m \
  --mount "type=bind,source=${task_directory},target=/work" --workdir /work \
  "${task_image}" node /work/prepare.mjs /work/.env /work/generated
