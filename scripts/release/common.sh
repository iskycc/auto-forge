#!/usr/bin/env bash

set -Eeuo pipefail

readonly release_script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly repository_root="$(cd -- "${release_script_directory}/../.." && pwd)"

normalize_version() {
  local raw_version="${1:?version is required}"
  local normalized="${raw_version#v}"
  if [[ ! "${normalized}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
    echo "invalid release version: ${raw_version}" >&2
    return 1
  fi
  printf '%s\n' "${normalized}"
}

require_variant() {
  local candidate_variant="${1:?variant is required}"
  case "${candidate_variant}" in
    amd64 | arm64 | amd64-musl | arm64-musl) ;;
    *)
      echo "unsupported release variant: ${candidate_variant}" >&2
      return 1
      ;;
  esac
}

release_created_at() {
  local epoch="${SOURCE_DATE_EPOCH:-0}"
  if [[ ! "${epoch}" =~ ^[0-9]+$ ]]; then
    echo "SOURCE_DATE_EPOCH must be a non-negative integer" >&2
    return 1
  fi
  date --utc --date="@${epoch}" '+%Y-%m-%dT%H:%M:%SZ'
}

release_revision() {
  printf '%s\n' "${AUTOFORGE_RELEASE_REVISION:-unknown}"
}

release_output_directory() {
  local candidate="${1:?output directory is required}"
  if [[ "${candidate}" == /* ]]; then
    printf '%s\n' "${candidate}"
    return
  fi
  printf '%s/%s\n' "${repository_root}" "${candidate}"
}
