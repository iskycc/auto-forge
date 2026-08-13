#!/usr/bin/env bash

set -Eeuo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" ]]; then
  echo "Full business recovery acceptance is restricted to GitHub Actions." >&2
  exit 1
fi

readonly repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
exec bash "${repository_root}/scripts/quality/test-full.sh"
