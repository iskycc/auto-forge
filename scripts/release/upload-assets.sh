#!/usr/bin/env bash

set -Eeuo pipefail

readonly release_tag="${1:?usage: upload-assets.sh TAG ASSET_DIRECTORY}"
readonly asset_directory="${2:?usage: upload-assets.sh TAG ASSET_DIRECTORY}"
readonly maximum_attempts=3

if [[ ! "${release_tag}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  printf 'Invalid release tag: %s\n' "${release_tag}" >&2
  exit 1
fi

shopt -s nullglob
assets=("${asset_directory}"/*)
if (( ${#assets[@]} == 0 )); then
  printf 'No release assets found in %s\n' "${asset_directory}" >&2
  exit 1
fi
for asset_path in "${assets[@]}"; do
  if [[ ! -f "${asset_path}" ]]; then
    printf 'Release asset is not a regular file: %s\n' "${asset_path}" >&2
    exit 1
  fi
done

for asset_path in "${assets[@]}"; do
  for (( attempt=1; attempt<=maximum_attempts; attempt++ )); do
    printf 'Uploading %s (attempt %s/%s)\n' "${asset_path##*/}" "${attempt}" "${maximum_attempts}"
    if timeout --kill-after=10s 180s gh release upload "${release_tag}" "${asset_path}" --clobber; then
      break
    fi
    if (( attempt == maximum_attempts )); then
      printf 'Failed to upload %s after %s attempts; Release was not published.\n' \
        "${asset_path##*/}" "${maximum_attempts}" >&2
      exit 1
    fi
    sleep "$((attempt * 5))"
  done
done
