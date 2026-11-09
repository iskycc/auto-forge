#!/usr/bin/env bash
set -Eeuo pipefail

# Non-root tar otherwise applies umask to archived modes, changing verified files.
tar --extract --gzip --same-permissions --file .acceptance-build/runtime.tar.gz
node scripts/quality/acceptance-build.mjs verify
