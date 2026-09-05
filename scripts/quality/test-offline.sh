#!/usr/bin/env bash

set -Eeuo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" ]]; then
  echo "Offline production acceptance is restricted to GitHub Actions because it builds the platform and runs a browser flow in a network namespace." >&2
  exit 1
fi

readonly repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly acceptance_directory="$(mktemp -d)"
readonly acceptance_phase="${1:-all}"

case "${acceptance_phase}" in
  assets)
    readonly offline_e2e_specs="tests/e2e/case-suite-lifecycle.spec.ts tests/e2e/jar-import.spec.ts tests/e2e/project-isolation.spec.ts"
    readonly verify_ldap_directory=0
    readonly verify_backup_restore=0
    ;;
  analysis)
    readonly offline_e2e_specs="tests/e2e/failure-analysis.spec.ts tests/e2e/failure-analysis-assignment.spec.ts tests/e2e/read-model-cache.spec.ts"
    readonly verify_ldap_directory=0
    readonly verify_backup_restore=0
    ;;
  governance)
    readonly offline_e2e_specs="tests/e2e/identity-rbac.spec.ts"
    readonly verify_ldap_directory=1
    readonly verify_backup_restore=0
    ;;
  operations)
    readonly offline_e2e_specs="tests/e2e/management-operations.spec.ts tests/e2e/platform-operations.spec.ts"
    readonly verify_ldap_directory=0
    readonly verify_backup_restore=1
    ;;
  recovery)
    readonly offline_e2e_specs="tests/e2e/execution-recovery.spec.ts"
    readonly verify_ldap_directory=0
    readonly verify_backup_restore=0
    ;;
  all)
    readonly offline_e2e_specs="tests/e2e/failure-analysis.spec.ts tests/e2e/failure-analysis-assignment.spec.ts tests/e2e/read-model-cache.spec.ts tests/e2e/case-suite-lifecycle.spec.ts tests/e2e/execution-recovery.spec.ts tests/e2e/identity-rbac.spec.ts tests/e2e/jar-import.spec.ts tests/e2e/management-operations.spec.ts tests/e2e/platform-operations.spec.ts tests/e2e/project-isolation.spec.ts"
    readonly verify_ldap_directory=1
    readonly verify_backup_restore=1
    ;;
  *)
    printf 'Unknown offline acceptance phase: %s\n' "${acceptance_phase}" >&2
    exit 2
    ;;
esac

readonly acceptance_script='
if curl --fail --silent --connect-timeout 2 https://example.com >/dev/null 2>&1; then
  echo "Outbound network unexpectedly remained available." >&2
  exit 1
fi
if [[ "${AUTOFORGE_OFFLINE_VERIFY_LDAP_DIRECTORY}" == "1" ]]; then
  pnpm exec vitest run apps/web/src/lib/ldap-directory.test.ts
fi
read -r -a offline_specs <<<"${AUTOFORGE_OFFLINE_E2E_SPECS}"
pnpm exec playwright test "${offline_specs[@]}"
if [[ "${AUTOFORGE_OFFLINE_VERIFY_BACKUP_RESTORE}" == "1" ]]; then
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
fi
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
export AUTOFORGE_OFFLINE_E2E_SPECS="${offline_e2e_specs}"
export AUTOFORGE_OFFLINE_VERIFY_LDAP_DIRECTORY="${verify_ldap_directory}"
export AUTOFORGE_OFFLINE_VERIFY_BACKUP_RESTORE="${verify_backup_restore}"
export E2E_PROJECT_MAXIMUM_CONCURRENCY=1

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
  "AUTOFORGE_OFFLINE_E2E_SPECS=${AUTOFORGE_OFFLINE_E2E_SPECS}" \
  "AUTOFORGE_OFFLINE_VERIFY_LDAP_DIRECTORY=${AUTOFORGE_OFFLINE_VERIFY_LDAP_DIRECTORY}" \
  "AUTOFORGE_OFFLINE_VERIFY_BACKUP_RESTORE=${AUTOFORGE_OFFLINE_VERIFY_BACKUP_RESTORE}" \
  "E2E_PROJECT_MAXIMUM_CONCURRENCY=${E2E_PROJECT_MAXIMUM_CONCURRENCY}" \
  unshare --net bash -Eeuo pipefail -c '
    ip link set lo up
    setpriv --reuid "$1" --regid "$2" --clear-groups \
      bash -Eeuo pipefail -c "$3"
  ' _ "$(id -u)" "$(id -g)" "${acceptance_script}"
