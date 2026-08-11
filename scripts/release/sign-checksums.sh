#!/usr/bin/env bash

set -Eeuo pipefail

readonly private_key_path="${1:?usage: sign-checksums.sh PRIVATE_KEY SHA256SUMS SIGNATURE PUBLIC_KEY}"
readonly checksums_path="${2:?usage: sign-checksums.sh PRIVATE_KEY SHA256SUMS SIGNATURE PUBLIC_KEY}"
readonly signature_path="${3:?usage: sign-checksums.sh PRIVATE_KEY SHA256SUMS SIGNATURE PUBLIC_KEY}"
readonly public_key_path="${4:?usage: sign-checksums.sh PRIVATE_KEY SHA256SUMS SIGNATURE PUBLIC_KEY}"

for required_file in "${private_key_path}" "${checksums_path}" "${public_key_path}"; do
  if [[ ! -f "${required_file}" ]]; then
    printf 'Required signing input is not a regular file: %s\n' "${required_file}" >&2
    exit 1
  fi
done

readonly temporary_signature="$(mktemp "${signature_path}.tmp.XXXXXX")"

cleanup() {
  rm -f -- "${temporary_signature}"
}
trap cleanup EXIT

openssl pkeyutl \
  -sign \
  -rawin \
  -inkey "${private_key_path}" \
  -in "${checksums_path}" \
  -out "${temporary_signature}"

openssl pkeyutl \
  -verify \
  -rawin \
  -pubin \
  -inkey "${public_key_path}" \
  -sigfile "${temporary_signature}" \
  -in "${checksums_path}" >/dev/null

chmod 0644 "${temporary_signature}"
mv -- "${temporary_signature}" "${signature_path}"
printf 'Signed %s as %s\n' "${checksums_path}" "${signature_path}"
