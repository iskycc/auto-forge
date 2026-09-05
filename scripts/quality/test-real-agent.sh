#!/usr/bin/env bash

set -Eeuo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" ]]; then
  echo "Real Agent acceptance is intentionally restricted to GitHub Actions because it builds Go/Java artifacts and runs a production browser flow." >&2
  exit 1
fi

readonly repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly acceptance_directory="$(mktemp -d)"
readonly agent_pid_file="${acceptance_directory}/agent.pid"
readonly restart_marker_path="${acceptance_directory}/restart-attempt.marker"
readonly toolchain_directory="${acceptance_directory}/toolchain"
readonly fixture_classes_directory="${acceptance_directory}/fixture-classes"
readonly project_fixture_classes_directory="${acceptance_directory}/project-fixture-classes"
readonly dependency_bundle_directory="${acceptance_directory}/dependency-bundle/level-1/level-2/level-3"
readonly run_identity="${GITHUB_RUN_ID//[^0-9A-Za-z_-]/_}-${GITHUB_RUN_ATTEMPT//[^0-9A-Za-z_-]/_}"
readonly cgroup_root="/sys/fs/cgroup/autoforge-ci-${run_identity}"

cleanup() {
  local exit_status="$?"
  set +e
  if [[ -s "${agent_pid_file}" ]]; then
    local agent_pid
    read -r agent_pid <"${agent_pid_file}"
    if [[ "${agent_pid}" =~ ^[1-9][0-9]*$ ]]; then
      kill -TERM -- "-${agent_pid}" >/dev/null 2>&1
      for _ in $(seq 1 50); do
        if ! kill -0 -- "${agent_pid}" >/dev/null 2>&1; then
          break
        fi
        sleep 0.1
      done
      kill -KILL -- "-${agent_pid}" >/dev/null 2>&1
    fi
  fi
  if [[ "${cgroup_root}" == /sys/fs/cgroup/autoforge-ci-* && -d "${cgroup_root}" ]]; then
    # The script lives in ${cgroup_root}/.ci-harness after delegation setup;
    # leave the delegated subtree before removing it.
    printf '%s\n' "$$" | sudo -n tee /sys/fs/cgroup/cgroup.procs >/dev/null 2>&1
    sudo -n find "${cgroup_root}" -depth -type d -exec rmdir -- {} \; >/dev/null 2>&1
  fi
  rm -rf -- "${acceptance_directory}"
  return "${exit_status}"
}
trap cleanup EXIT

download_verified() {
  local url="${1:?download URL is required}"
  local expected_sha256="${2:?SHA-256 is required}"
  local output_path="${3:?output path is required}"
  curl --fail --location --silent --show-error "${url}" --output "${output_path}"
  printf '%s  %s\n' "${expected_sha256}" "${output_path}" | sha256sum --check --status
}

require_host_tools() {
  local missing=0
  for command_name in curl file ip jar java javac sha256sum sudo unshare; do
    if ! command -v "${command_name}" >/dev/null 2>&1; then
      echo "Missing required hosted-runner command: ${command_name}" >&2
      missing=1
    fi
  done
  if [[ "${missing}" -ne 0 ]]; then
    exit 1
  fi
}

prepare_toolchain() {
  mkdir -p \
    "${toolchain_directory}" \
    "${fixture_classes_directory}" \
    "${project_fixture_classes_directory}" \
    "${dependency_bundle_directory}"
  local compile_classpath
  if [[ -n "${E2E_PREBUILT_TOOLCHAIN_ROOT:-}" ]]; then
    if [[ ! -x "${E2E_PREBUILT_TOOLCHAIN_ROOT}/jdk/bin/java" || ! -f "${E2E_PREBUILT_TOOLCHAIN_ROOT}/manifest.json" ]]; then
      echo "The prebuilt offline toolchain is incomplete." >&2
      exit 1
    fi
    (cd "${E2E_PREBUILT_TOOLCHAIN_ROOT}" && sha256sum --check --strict file-sha256sums)
    compile_classpath="$(find "${E2E_PREBUILT_TOOLCHAIN_ROOT}/lib" -maxdepth 1 -name '*.jar' -type f -print | LC_ALL=C sort | paste -sd: -)"
  else
    download_verified \
      "https://repo.maven.apache.org/maven2/org/testng/testng/7.11.0/testng-7.11.0.jar" \
      "2edbe6b2211186d8f5439cba7998697cce883432e5f14e0696f6b59d0d58582b" \
      "${toolchain_directory}/testng-7.11.0.jar"
    download_verified \
      "https://repo.maven.apache.org/maven2/org/jcommander/jcommander/1.83/jcommander-1.83.jar" \
      "e65f49c2119a1859b9076061e561fb5958a2fa6ffdb49f051ca8d59a0b3f87e4" \
      "${toolchain_directory}/jcommander-1.83.jar"
    download_verified \
      "https://repo.maven.apache.org/maven2/org/slf4j/slf4j-api/2.0.16/slf4j-api-2.0.16.jar" \
      "a12578dde1ba00bd9b816d388a0b879928d00bab3c83c240f7013bf4196c579a" \
      "${toolchain_directory}/slf4j-api-2.0.16.jar"
    download_verified \
      "https://repo.maven.apache.org/maven2/org/webjars/jquery/3.7.1/jquery-3.7.1.jar" \
      "262016dd3a559df87aefbe392804e9bf620787c9204c0ab8522d4c231ea65097" \
      "${toolchain_directory}/jquery-3.7.1.jar"
    compile_classpath="${toolchain_directory}/testng-7.11.0.jar:${toolchain_directory}/jcommander-1.83.jar:${toolchain_directory}/slf4j-api-2.0.16.jar:${toolchain_directory}/jquery-3.7.1.jar"
  fi
  if [[ -z "${compile_classpath}" ]]; then
    echo "The offline toolchain does not contain a Java classpath." >&2
    exit 1
  fi

  javac \
    --release 11 \
    -encoding UTF-8 \
    -d "${project_fixture_classes_directory}" \
    "${repository_root}/tests/fixtures/real-agent/ProjectFileUtil.java"
  jar --create \
    --file "${dependency_bundle_directory}/project-fixture.jar" \
    -C "${project_fixture_classes_directory}" .

  javac \
    --release 11 \
    -encoding UTF-8 \
    -cp "${compile_classpath}:${dependency_bundle_directory}/project-fixture.jar" \
    -d "${fixture_classes_directory}" \
    "${repository_root}/tests/fixtures/real-agent/RealAgentFixture.java" \
    "${repository_root}/tests/fixtures/real-agent/RealAgentFailureFixture.java" \
    "${repository_root}/tests/fixtures/real-agent/RealAgentRestartFixture.java" \
    "${repository_root}/tests/fixtures/real-agent/RealAgentRecoveryFixture.java"
  jar --create \
    --file "${acceptance_directory}/real-agent-tests.jar" \
    -C "${fixture_classes_directory}" .

  if [[ -n "${E2E_PREBUILT_TOOLCHAIN_ROOT:-}" ]]; then
    find "${E2E_PREBUILT_TOOLCHAIN_ROOT}/lib" -maxdepth 1 -name '*.jar' -type f \
      -exec cp -- {} "${dependency_bundle_directory}/" \;
  else
    cp -- "${toolchain_directory}"/*.jar "${dependency_bundle_directory}/"
  fi
  jar --create \
    --file "${acceptance_directory}/adapter-dependencies.zip" \
    -C "${acceptance_directory}/dependency-bundle" .
}

prepare_adapter() {
  if [[ -n "${E2E_PREBUILT_ADAPTER_JAR:-}" ]]; then
    if [[ ! -f "${E2E_PREBUILT_ADAPTER_JAR}" ]]; then
      echo "The prebuilt CoTest Adapter JAR does not exist." >&2
      exit 1
    fi
    E2E_REAL_ADAPTER_JAR="$(readlink -f "${E2E_PREBUILT_ADAPTER_JAR}")"
    export E2E_REAL_ADAPTER_JAR
    return
  fi
  if ! command -v mvn >/dev/null 2>&1; then
    echo "Maven is required when no prebuilt CoTest Adapter JAR is provided." >&2
    exit 1
  fi
  mvn --quiet --file "${repository_root}/adapters/cotest-testng/pom.xml" -DskipTests package
  E2E_REAL_ADAPTER_JAR="$(readlink -f "${repository_root}/adapters/cotest-testng/target/cotest-testng-adapter-0.1.0-SNAPSHOT.jar")"
  export E2E_REAL_ADAPTER_JAR
}

prepare_agent_binary() {
  if [[ -n "${E2E_PREBUILT_AGENT_BINARY:-}" ]]; then
    if [[ ! -x "${E2E_PREBUILT_AGENT_BINARY}" ]]; then
      echo "The prebuilt release Agent is not executable." >&2
      exit 1
    fi
    E2E_REAL_AGENT_BINARY="$(readlink -f "${E2E_PREBUILT_AGENT_BINARY}")"
    export E2E_REAL_AGENT_BINARY
    return
  fi
  local architecture
  case "$(uname -m)" in
    x86_64) architecture="amd64" ;;
    aarch64 | arm64) architecture="arm64" ;;
    *)
      echo "Unsupported GitHub Actions architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
  SOURCE_DATE_EPOCH=0 \
  AUTOFORGE_RELEASE_REVISION="${GITHUB_SHA:-unknown}" \
    bash "${repository_root}/scripts/release/build-agent.sh" \
      0.0.0-ci "${architecture}" "${acceptance_directory}"
  E2E_REAL_AGENT_BINARY="${acceptance_directory}/autoforge-agent-0.0.0-ci-${architecture}"
  export E2E_REAL_AGENT_BINARY
}

prepare_cgroup_delegation() {
  for controller in cpu memory pids; do
    if ! grep -qw "${controller}" /sys/fs/cgroup/cgroup.controllers; then
      echo "The GitHub Actions host does not expose cgroup v2 ${controller}." >&2
      exit 1
    fi
    printf '+%s\n' "${controller}" | sudo -n tee /sys/fs/cgroup/cgroup.subtree_control >/dev/null
  done
  sudo -n mkdir -- "${cgroup_root}"
  sudo -n chown \
    "$(id -u):$(id -g)" \
    "${cgroup_root}" \
    "${cgroup_root}/cgroup.procs" \
    "${cgroup_root}/cgroup.subtree_control" \
    "${cgroup_root}/cgroup.threads"
  for controller in cpu memory pids; do
    if ! grep -qw "${controller}" "${cgroup_root}/cgroup.controllers"; then
      echo "The dedicated Agent cgroup was not delegated ${controller}." >&2
      exit 1
    fi
  done
  # cgroup v2 containment: a delegatee cannot place the first process into the
  # delegated subtree (cgroups(7)); the delegater must do that. Move this
  # script into a dedicated child cgroup now so the Agent and the resource
  # wrappers it spawns later can move themselves within the subtree. A child
  # keeps ${cgroup_root} free of member processes, which is required before
  # the Agent may enable controllers in ${cgroup_root}/cgroup.subtree_control.
  sudo -n mkdir -- "${cgroup_root}/.ci-harness"
  sudo -n chown "$(id -u):$(id -g)" "${cgroup_root}/.ci-harness"
  printf '%s\n' "$$" | sudo -n tee "${cgroup_root}/.ci-harness/cgroup.procs" >/dev/null
}

run_network_blocked_browser_flow() {
  # Both wrappers bring the isolated loopback up while they still hold the
  # capability to do so; the acceptance script must not retry `ip link` after
  # setpriv has dropped privileges, because it fails with RTNETLINK EPERM.
  local acceptance_script='
    if curl --fail --silent --connect-timeout 2 --max-time 3 https://example.com >/dev/null 2>&1; then
      echo "Outbound network unexpectedly remained available during real Agent acceptance." >&2
      exit 1
    fi
    exec pnpm exec playwright test tests/e2e/real-agent.spec.ts
  '

  if unshare --user --map-root-user --net bash -Eeuo pipefail -c \
    'ip link set lo up' >/dev/null 2>&1; then
    unshare --user --map-root-user --net bash -Eeuo pipefail -c \
      'ip link set lo up
       exec bash -Eeuo pipefail -c "$1"' _ "${acceptance_script}"
    return
  fi
  if ! command -v setpriv >/dev/null 2>&1 || ! sudo -n unshare --net true >/dev/null 2>&1; then
    echo "The hosted runner cannot create an isolated network namespace." >&2
    exit 1
  fi
  sudo -n env \
    "PATH=${PATH}" \
    "HOME=${HOME}" \
    "CI=${CI:-true}" \
    "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}" \
    "AUTOFORGE_E2E_DATA_DIR=${AUTOFORGE_E2E_DATA_DIR}" \
    "E2E_REAL_AGENT_BINARY=${E2E_REAL_AGENT_BINARY}" \
    "E2E_REAL_AGENT_DATA_DIR=${E2E_REAL_AGENT_DATA_DIR}" \
    "E2E_REAL_AGENT_PID_FILE=${E2E_REAL_AGENT_PID_FILE}" \
    "E2E_REAL_AGENT_RESTART_MARKER=${E2E_REAL_AGENT_RESTART_MARKER}" \
    "E2E_REAL_CGROUP_ROOT=${E2E_REAL_CGROUP_ROOT}" \
    "E2E_REAL_JAVA_EXECUTABLE=${E2E_REAL_JAVA_EXECUTABLE}" \
    "E2E_REAL_JAVA_VERSION=${E2E_REAL_JAVA_VERSION}" \
    "E2E_REAL_TESTNG_CLASSPATH=${E2E_REAL_TESTNG_CLASSPATH}" \
    "E2E_REAL_TEST_JAR=${E2E_REAL_TEST_JAR}" \
    "E2E_REAL_ADAPTER_JAR=${E2E_REAL_ADAPTER_JAR}" \
    "E2E_REAL_DEPENDENCY_ARCHIVE=${E2E_REAL_DEPENDENCY_ARCHIVE}" \
    unshare --net bash -Eeuo pipefail -c '
      ip link set lo up
      setpriv --reuid "$1" --regid "$2" --clear-groups bash -Eeuo pipefail -c "$3"
    ' _ "$(id -u)" "$(id -g)" "${acceptance_script}"
}

run_browser_flow() {
  if [[ -n "${E2E_REAL_AGENT_EXTERNAL_BASE_URL:-}" ]]; then
    export E2E_BASE_URL="${E2E_REAL_AGENT_EXTERNAL_BASE_URL}"
    export E2E_REAL_AGENT_SERVER_URL="${E2E_REAL_AGENT_SERVER_URL:-${E2E_REAL_AGENT_EXTERNAL_BASE_URL}}"
    local reporter_arguments=()
    if [[ "${E2E_DISTRIBUTED_ACCEPTANCE:-}" == distributed-agent ]]; then
      reporter_arguments=(--reporter=line,json --output test-results/distributed-agent)
    fi
    pnpm exec playwright test --config playwright.full.config.ts tests/e2e/real-agent.spec.ts "${reporter_arguments[@]}"
    return
  fi
  run_network_blocked_browser_flow
}

cd "${repository_root}"
require_host_tools
prepare_toolchain
prepare_adapter
prepare_agent_binary
prepare_cgroup_delegation

if [[ -n "${E2E_PREBUILT_TOOLCHAIN_ROOT:-}" ]]; then
  readonly java_executable="$(readlink -f "${E2E_PREBUILT_TOOLCHAIN_ROOT}/jdk/bin/java")"
  readonly testng_classpath="$(find "${E2E_PREBUILT_TOOLCHAIN_ROOT}/lib" -maxdepth 1 -name '*.jar' -type f -print | LC_ALL=C sort | paste -sd: -)"
else
  readonly java_executable="$(readlink -f "$(command -v java)")"
  readonly testng_classpath="${toolchain_directory}/testng-7.11.0.jar:${toolchain_directory}/jcommander-1.83.jar:${toolchain_directory}/slf4j-api-2.0.16.jar:${toolchain_directory}/jquery-3.7.1.jar"
fi
readonly java_version="$("${java_executable}" -XshowSettings:properties -version 2>&1 | awk -F'= ' '/java.version =/{print $2; exit}')"
if [[ -z "${java_version}" ]]; then
  echo "Unable to determine the preinstalled Java version." >&2
  exit 1
fi

export AUTOFORGE_E2E_DATA_DIR="${acceptance_directory}/platform-data"
export E2E_REAL_AGENT_DATA_DIR="${acceptance_directory}/agent-data"
export E2E_REAL_AGENT_PID_FILE="${agent_pid_file}"
export E2E_REAL_AGENT_RESTART_MARKER="${restart_marker_path}"
export E2E_REAL_CGROUP_ROOT="${cgroup_root}"
export E2E_REAL_JAVA_EXECUTABLE="${java_executable}"
export E2E_REAL_JAVA_VERSION="${java_version}"
export E2E_REAL_TESTNG_CLASSPATH="${testng_classpath}"
export E2E_REAL_TEST_JAR="${acceptance_directory}/real-agent-tests.jar"
export E2E_REAL_DEPENDENCY_ARCHIVE="${acceptance_directory}/adapter-dependencies.zip"

run_browser_flow
printf 'Real Go Agent, distributed Adapter, nested dependency archive, logs, structured result and artifacts passed.\n'
