#!/usr/bin/env bash

set -Eeuo pipefail

readonly repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly acceptance_directory="$(mktemp -d)"
readonly acceptance_script='
if curl --fail --silent --connect-timeout 2 https://example.com >/dev/null 2>&1; then
  echo "Outbound network unexpectedly remained available." >&2
  exit 1
fi
pnpm exec vitest run apps/web/src/lib/ldap-directory.test.ts
pnpm test:e2e
bash scripts/operations/lite-backup.sh \
  --data-dir "${AUTOFORGE_E2E_DATA_DIR}" \
  --output "${AUTOFORGE_OFFLINE_ACCEPTANCE_DIR}/lite-backup.tar.gz" \
  --platform-stopped
bash scripts/operations/lite-restore.sh \
  --input "${AUTOFORGE_OFFLINE_ACCEPTANCE_DIR}/lite-backup.tar.gz" \
  --data-dir "${AUTOFORGE_OFFLINE_ACCEPTANCE_DIR}/restored-data" \
  --platform-stopped
diff --recursive --brief \
  "${AUTOFORGE_E2E_DATA_DIR}" "${AUTOFORGE_OFFLINE_ACCEPTANCE_DIR}/restored-data"
'

cleanup() {
  rm -rf -- "${acceptance_directory}"
}
trap cleanup EXIT

if ! command -v unshare >/dev/null 2>&1 || ! command -v ip >/dev/null 2>&1; then
  echo "Offline acceptance requires unshare and ip from the host util-linux/iproute2 baseline." >&2
  exit 1
fi

cd "${repository_root}"
export AUTOFORGE_E2E_DATA_DIR="${acceptance_directory}/platform-data"
export AUTOFORGE_OFFLINE_ACCEPTANCE_DIR="${acceptance_directory}"

if unshare --user --map-root-user --net true >/dev/null 2>&1; then
  unshare --user --map-root-user --net bash -Eeuo pipefail -c '
    ip link set lo up
    exec bash -Eeuo pipefail -c "$1"
  ' _ "${acceptance_script}"
  exit 0
fi

if ! command -v sudo >/dev/null 2>&1 || ! command -v setpriv >/dev/null 2>&1; then
  echo "The host blocks unprivileged network namespaces and has no sudo/setpriv fallback." >&2
  exit 1
fi
if ! sudo -n unshare --net true >/dev/null 2>&1; then
  echo "The host does not permit an isolated user/network namespace." >&2
  exit 1
fi

readonly invoking_user_home="${HOME}"
sudo -n env \
  "HOME=${invoking_user_home}" \
  "PATH=${PATH}" \
  "CI=${CI-}" \
  "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH-}" \
  "AUTOFORGE_E2E_DATA_DIR=${AUTOFORGE_E2E_DATA_DIR}" \
  "AUTOFORGE_OFFLINE_ACCEPTANCE_DIR=${AUTOFORGE_OFFLINE_ACCEPTANCE_DIR}" \
  unshare --net bash -Eeuo pipefail -c '
    ip link set lo up
    setpriv --reuid "$1" --regid "$2" --clear-groups \
      bash -Eeuo pipefail -c "$3"
  ' _ "$(id -u)" "$(id -g)" "${acceptance_script}"
