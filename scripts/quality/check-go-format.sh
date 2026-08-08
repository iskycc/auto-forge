#!/usr/bin/env bash

set -Eeuo pipefail

readonly repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
mapfile -t unformatted < <(gofmt -l "${repository_root}/apps/runner-agent")

if (( ${#unformatted[@]} > 0 )); then
  printf 'Go files require gofmt:\n' >&2
  printf '  %s\n' "${unformatted[@]}" >&2
  exit 1
fi
