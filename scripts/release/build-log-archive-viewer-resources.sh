#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"
readonly requested_version="${1:-$(node -p 'require(process.argv[1]).version' "${repository_root}/package.json")}"
readonly version="$(normalize_version "${requested_version}")"
readonly output_directory="$(release_output_directory "${2:-resources/log-archive-viewer}")"
mkdir -p "${output_directory}"
node "${repository_root}/apps/web/server/build-log-archive-ui.mjs"
for target in linux-amd64 linux-arm64 windows-amd64; do
  target_os="${target%-*}"
  target_architecture="${target##*-}"
  target_filename="viewer-${target}"
  if [[ "${target_os}" == windows ]]; then target_filename+=".exe"; fi
  (cd "${repository_root}/apps/log-archive-viewer" && env CGO_ENABLED=0 GOMAXPROCS="${GOMAXPROCS:-1}" GOFLAGS=-p=1 GOTOOLCHAIN=go1.26.5 GOOS="${target_os}" GOARCH="${target_architecture}" go build -trimpath -buildvcs=false -ldflags='-s -w' -o "${output_directory}/${target_filename}" ./cmd/viewer)
done
install -m 0644 "${repository_root}/apps/log-archive-viewer/cmd/viewer/assets/licenses.txt" "${output_directory}/viewer-licenses.txt"
node "${repository_root}/scripts/release/create-log-viewer-manifest.mjs" "${version}" "${output_directory}"
