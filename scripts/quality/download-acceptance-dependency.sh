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

# Retry only curl's transient HTTP/transport failures, never checksum mismatches.
curl --fail --location --silent --show-error \
  --header 'Accept: application/octet-stream' \
  --retry 3 --retry-delay 1 --retry-connrefused --retry-max-time 120 \
  --connect-timeout 10 --max-time 60 \
  "${url}" --output "${temporary_path}"
printf '%s  %s\n' "${expected_sha256}" "${temporary_path}" | sha256sum --check --status
mv -- "${temporary_path}" "${output_path}"
