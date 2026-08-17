#!/usr/bin/env bash
# Runs the java-cases acceptance spec locally. Unlike test-real-agent.sh this
# variant is meant for developer machines: it builds the java-cases assets,
# the Go Agent binary and delegates a cgroup subtree without network blocking.

set -Eeuo pipefail

# Some minimal shells run without HOME; Go refuses to build without a module
# cache and build cache, so fall back to the passwd entry and derived paths.
export HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
export GOPATH="${GOPATH:-${HOME}/go}"
export GOMODCACHE="${GOMODCACHE:-${GOPATH}/pkg/mod}"
export GOCACHE="${GOCACHE:-${HOME}/.cache/go-build}"

readonly repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly working_directory="${AUTOFORGE_JAVA_CASES_E2E_DIR:-$(mktemp -d)}"
readonly cgroup_root="${E2E_JAVA_CASES_CGROUP_ROOT:-/sys/fs/cgroup/autoforge-java-cases}"

cleanup() {
  local exit_status="$?"
  set +e
  if [[ -d "${cgroup_root}" ]]; then
    # Move this shell back to the cgroup root before removing the subtree,
    # otherwise the rmdir on the leaf holding our own PID fails.
    printf '%s\n' "$$" | tee /sys/fs/cgroup/cgroup.procs >/dev/null 2>&1
    find "${cgroup_root}" -depth -type d -exec rmdir -- {} \; >/dev/null 2>&1
  fi
  return "${exit_status}"
}
trap cleanup EXIT

cd "${repository_root}"

bash scripts/quality/build-java-cases.sh

readonly dist_directory="${repository_root}/tests/fixtures/java-cases/dist"
if [[ ! -x "${working_directory}/autoforge-agent" ]]; then
  mkdir -p "${working_directory}"
  SOURCE_DATE_EPOCH=0 AUTOFORGE_RELEASE_REVISION=local \
    bash scripts/release/build-agent.sh 0.0.0-e2e amd64 "${working_directory}"
  mv "${working_directory}/autoforge-agent-0.0.0-e2e-amd64" "${working_directory}/autoforge-agent"
fi

for controller in cpu memory pids; do
  printf '+%s\n' "${controller}" > /sys/fs/cgroup/cgroup.subtree_control
done
mkdir -p "${cgroup_root}"
for controller in cpu memory pids; do
  grep -qw "${controller}" "${cgroup_root}/cgroup.controllers" \
    || { echo "cgroup root is missing ${controller}" >&2; exit 1; }
done
mkdir -p "${cgroup_root}/.harness"
printf '%s\n' "$$" > "${cgroup_root}/.harness/cgroup.procs"

readonly java_executable="$(readlink -f "$(command -v java)")"
readonly java_version="$("${java_executable}" -XshowSettings:properties -version 2>&1 | awk -F'= ' '/java.version =/{print $2; exit}')"
readonly testng_classpath="${dist_directory}/toolchain/testng-7.11.0.jar:${dist_directory}/toolchain/jcommander-1.83.jar:${dist_directory}/toolchain/slf4j-api-2.0.16.jar:${dist_directory}/toolchain/jquery-3.7.1.jar"

export AUTOFORGE_E2E_DATA_DIR="${working_directory}/platform-data"
export E2E_JAVA_CASES_AGENT_BINARY="${working_directory}/autoforge-agent"
export E2E_JAVA_CASES_AGENT_DATA_DIR="${working_directory}/agent-data"
export E2E_JAVA_CASES_ADAPTER_JAR="${dist_directory}/cotest-testng-adapter.jar"
export E2E_JAVA_CASES_TEST_JAR="${dist_directory}/java-cases-tests.jar"
export E2E_JAVA_CASES_DEPENDENCY_ARCHIVE="${dist_directory}/java-cases-dependencies.zip"
export E2E_JAVA_CASES_JAVA_EXECUTABLE="${java_executable}"
export E2E_JAVA_CASES_JAVA_VERSION="${java_version}"
export E2E_JAVA_CASES_TESTNG_CLASSPATH="${testng_classpath}"
export E2E_JAVA_CASES_CGROUP_ROOT="${cgroup_root}"

pnpm exec playwright test tests/e2e/java-cases-pipeline.spec.ts "$@"
