#!/usr/bin/env bash

set -Eeuo pipefail

readonly url="${1:?dependency URL is required}"
readonly expected_sha256="${2:?dependency SHA-256 is required}"
readonly output_path="${3:?dependency output path is required}"
if [[ ! "${expected_sha256}" =~ ^[a-f0-9]{64}$ ]]; then
  echo "Dependency SHA-256 must contain 64 lowercase hexadecimal characters." >&2
  exit 1
fi
readonly temporary_path="$(mktemp "${output_path}.partial.XXXXXX")"
cleanup() {
  rm -f -- "${temporary_path}"
}
trap cleanup EXIT

if [[ -n "${AUTOFORGE_ACCEPTANCE_DEPENDENCY_CACHE:-}" ]]; then
  cached_path="${AUTOFORGE_ACCEPTANCE_DEPENDENCY_CACHE}/${expected_sha256}"
  if [[ -f "${cached_path}" ]]; then
    printf '%s  %s\n' "${expected_sha256}" "${cached_path}" | sha256sum --check --status
    cp -- "${cached_path}" "${temporary_path}"
    mv -- "${temporary_path}" "${output_path}"
    printf 'Reused verified acceptance dependency: %s\n' "${output_path##*/}"
    exit 0
  fi
fi

printf 'Downloading pinned acceptance dependency: %s\n' "${output_path##*/}"
authentication=()
# GitHub's authenticated asset endpoint avoids shared unauthenticated API limits.
# Never send this token to an arbitrary dependency host or include it in diagnostics.
if [[ "${url}" == https://api.github.com/repos/*/releases/assets/* && -n "${GH_TOKEN:-}" ]]; then
  authentication=(--header "Authorization: Bearer ${GH_TOKEN}")
fi

# Retry only curl's transient HTTP/transport failures, never checksum mismatches.
curl --fail --location --silent --show-error \
  --header 'Accept: application/octet-stream' \
  "${authentication[@]}" \
  --retry 3 --retry-delay 1 --retry-connrefused --retry-max-time 120 \
  --connect-timeout 10 --max-time 60 \
  "${url}" --output "${temporary_path}"
printf '%s  %s\n' "${expected_sha256}" "${temporary_path}" | sha256sum --check --status
if [[ -n "${AUTOFORGE_ACCEPTANCE_DEPENDENCY_CACHE:-}" ]]; then
  mkdir -p -- "${AUTOFORGE_ACCEPTANCE_DEPENDENCY_CACHE}"
  cp -- "${temporary_path}" "${cached_path}"
fi
mv -- "${temporary_path}" "${output_path}"
