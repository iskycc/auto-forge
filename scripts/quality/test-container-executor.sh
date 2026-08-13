#!/usr/bin/env bash

set -Eeuo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" ]]; then
  echo "Container executor acceptance is restricted to GitHub Actions because it builds Go/Java/container artifacts and exercises cgroup limits." >&2
  exit 1
fi

readonly repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly acceptance_directory="$(mktemp -d)"
readonly agent_pid_file="${acceptance_directory}/agent.pid"
readonly toolchain_directory="${acceptance_directory}/toolchain"
readonly fixture_classes_directory="${acceptance_directory}/fixture-classes"
readonly image_context_directory="${acceptance_directory}/image-context"
readonly run_identity="${GITHUB_RUN_ID//[^0-9A-Za-z_-]/_}-${GITHUB_RUN_ATTEMPT//[^0-9A-Za-z_-]/_}"
readonly cgroup_root="/sys/fs/cgroup/autoforge-container-ci-${run_identity}"
readonly registry_container="autoforge-container-registry-${run_identity}"
readonly registry_image="registry:2.8.3@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373"
readonly java_base_image="eclipse-temurin:21.0.8_9-jre-noble@sha256:20e7f7288e1c18eebe8f06a442c9f7183342d9b022d3b9a9677cae2b558ddddd"
readonly mutable_container_image="127.0.0.1:5000/autoforge/testng:${run_identity}"

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
  if command -v docker >/dev/null 2>&1; then
    docker rm --force "${registry_container}" >/dev/null 2>&1
    if [[ -n "${E2E_CONTAINER_IMAGE:-}" ]]; then
      while IFS= read -r container_id; do
        if [[ "${container_id}" =~ ^[a-f0-9]{12,64}$ ]]; then
          docker rm --force "${container_id}" >/dev/null 2>&1
        fi
      done < <(docker ps --quiet --filter "ancestor=${E2E_CONTAINER_IMAGE}" 2>/dev/null)
    fi
  fi
  if [[ "${cgroup_root}" == /sys/fs/cgroup/autoforge-container-ci-* && -d "${cgroup_root}" ]]; then
    sudo -n find "${cgroup_root}" -depth -type d -exec rmdir -- {} \; >/dev/null 2>&1
  fi
  if [[ "${acceptance_directory}" == /tmp/* && -d "${acceptance_directory}" ]]; then
    rm -rf -- "${acceptance_directory}"
  fi
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
  for command_name in curl docker file ip jar java javac sha256sum sudo unshare; do
    if ! command -v "${command_name}" >/dev/null 2>&1; then
      echo "Missing required hosted-runner command: ${command_name}" >&2
      missing=1
    fi
  done
  if [[ "${missing}" -ne 0 ]]; then
    exit 1
  fi
  if [[ "$(id -u)" -eq 0 || "$(id -g)" -eq 0 ]]; then
    echo "Container acceptance requires the hosted runner to use a non-root account." >&2
    exit 1
  fi
}

prepare_toolchain_and_fixture() {
  mkdir -p "${toolchain_directory}" "${fixture_classes_directory}" "${image_context_directory}"
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

  javac \
    --release 11 \
    -encoding UTF-8 \
    -cp "${toolchain_directory}/testng-7.11.0.jar" \
    -d "${fixture_classes_directory}" \
    "${repository_root}/tests/fixtures/container/ContainerAgentFixture.java"
  jar --create \
    --file "${acceptance_directory}/container-agent-tests.jar" \
    -C "${fixture_classes_directory}" .

  cp "${repository_root}/tests/fixtures/container/Dockerfile" "${image_context_directory}/Dockerfile"
  cp "${toolchain_directory}"/*.jar "${image_context_directory}/"
}

prepare_seccomp_profile() {
  download_verified \
    "https://raw.githubusercontent.com/moby/profiles/f9bc03ec19b2dc4c091449b08e88f85c0caa9f0b/seccomp/default.json" \
    "536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74" \
    "${acceptance_directory}/seccomp.json"
}

prepare_container_image() {
  docker pull "${java_base_image}"
  docker pull "${registry_image}"
  docker build \
    --network=none \
    --pull=false \
    --build-arg "BASE_IMAGE=${java_base_image}" \
    --tag "${mutable_container_image}" \
    "${image_context_directory}"

  docker run \
    --detach \
    --name "${registry_container}" \
    --publish 127.0.0.1:5000:5000 \
    "${registry_image}" >/dev/null
  for _ in $(seq 1 50); do
    if curl --fail --silent http://127.0.0.1:5000/v2/ >/dev/null; then
      break
    fi
    sleep 0.2
  done
  curl --fail --silent http://127.0.0.1:5000/v2/ >/dev/null
  docker push "${mutable_container_image}"

  E2E_CONTAINER_IMAGE="$(
    docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "${mutable_container_image}" |
      awk '/^127[.]0[.]0[.]1:5000\/autoforge\/testng@sha256:[a-f0-9]{64}$/{print; exit}'
  )"
  if [[ ! "${E2E_CONTAINER_IMAGE}" =~ ^127[.]0[.]0[.]1:5000/autoforge/testng@sha256:[a-f0-9]{64}$ ]]; then
    echo "The local registry did not return an immutable image digest." >&2
    exit 1
  fi
  docker pull "${E2E_CONTAINER_IMAGE}"
  docker rm --force "${registry_container}" >/dev/null
  docker image inspect "${E2E_CONTAINER_IMAGE}" >/dev/null
  export E2E_CONTAINER_IMAGE
}

prepare_agent_binary() {
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
  E2E_CONTAINER_AGENT_BINARY="${acceptance_directory}/autoforge-agent-0.0.0-ci-${architecture}"
  export E2E_CONTAINER_AGENT_BINARY
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
}

run_network_blocked_browser_flow() {
  local acceptance_script='
    ip link set lo up
    if curl --fail --silent --connect-timeout 2 --max-time 3 https://example.com >/dev/null 2>&1; then
      echo "Outbound network unexpectedly remained available during container acceptance." >&2
      exit 1
    fi
    docker image inspect "${E2E_CONTAINER_IMAGE}" >/dev/null
    exec pnpm exec playwright test tests/e2e/container-executor.spec.ts
  '

  if unshare --user --map-root-user --net bash -Eeuo pipefail -c \
    'ip link set lo up && docker info >/dev/null' >/dev/null 2>&1; then
    unshare --user --map-root-user --net bash -Eeuo pipefail -c "${acceptance_script}"
    return
  fi
  if ! command -v setpriv >/dev/null 2>&1 || ! sudo -n unshare --net true >/dev/null 2>&1; then
    echo "The hosted runner cannot create a Docker-capable isolated network namespace." >&2
    exit 1
  fi
  sudo -n env \
    "PATH=${PATH}" \
    "HOME=${HOME}" \
    "CI=${CI:-true}" \
    "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}" \
    "AUTOFORGE_E2E_DATA_DIR=${AUTOFORGE_E2E_DATA_DIR}" \
    "E2E_CONTAINER_AGENT_BINARY=${E2E_CONTAINER_AGENT_BINARY}" \
    "E2E_CONTAINER_AGENT_DATA_DIR=${E2E_CONTAINER_AGENT_DATA_DIR}" \
    "E2E_CONTAINER_AGENT_PID_FILE=${E2E_CONTAINER_AGENT_PID_FILE}" \
    "E2E_CONTAINER_CGROUP_ROOT=${E2E_CONTAINER_CGROUP_ROOT}" \
    "E2E_CONTAINER_IMAGE=${E2E_CONTAINER_IMAGE}" \
    "E2E_CONTAINER_RUNTIME=${E2E_CONTAINER_RUNTIME}" \
    "E2E_CONTAINER_SECCOMP=${E2E_CONTAINER_SECCOMP}" \
    "E2E_CONTAINER_USER=${E2E_CONTAINER_USER}" \
    "E2E_HOST_JAVA_EXECUTABLE=${E2E_HOST_JAVA_EXECUTABLE}" \
    "E2E_HOST_JAVA_VERSION=${E2E_HOST_JAVA_VERSION}" \
    "E2E_HOST_TESTNG_CLASSPATH=${E2E_HOST_TESTNG_CLASSPATH}" \
    "E2E_CONTAINER_TEST_JAR=${E2E_CONTAINER_TEST_JAR}" \
    unshare --net bash -Eeuo pipefail -c '
      ip link set lo up
      setpriv --reuid "$1" --regid "$2" --init-groups bash -Eeuo pipefail -c "$3"
    ' _ "$(id -u)" "$(id -g)" "${acceptance_script}"
}

cd "${repository_root}"
require_host_tools
prepare_toolchain_and_fixture
prepare_seccomp_profile
prepare_container_image
prepare_agent_binary
prepare_cgroup_delegation

readonly java_executable="$(readlink -f "$(command -v java)")"
readonly java_version="$("${java_executable}" -XshowSettings:properties -version 2>&1 | awk -F'= ' '/java.version =/{print $2; exit}')"
if [[ -z "${java_version}" ]]; then
  echo "Unable to determine the preinstalled Java version." >&2
  exit 1
fi

export AUTOFORGE_E2E_DATA_DIR="${acceptance_directory}/platform-data"
export E2E_CONTAINER_AGENT_DATA_DIR="${acceptance_directory}/agent-data"
export E2E_CONTAINER_AGENT_PID_FILE="${agent_pid_file}"
export E2E_CONTAINER_CGROUP_ROOT="${cgroup_root}"
export E2E_CONTAINER_RUNTIME="$(readlink -f "$(command -v docker)")"
export E2E_CONTAINER_SECCOMP="${acceptance_directory}/seccomp.json"
export E2E_CONTAINER_USER="$(id -u):$(id -g)"
export E2E_HOST_JAVA_EXECUTABLE="${java_executable}"
export E2E_HOST_JAVA_VERSION="${java_version}"
export E2E_HOST_TESTNG_CLASSPATH="${toolchain_directory}/testng-7.11.0.jar:${toolchain_directory}/jcommander-1.83.jar:${toolchain_directory}/slf4j-api-2.0.16.jar:${toolchain_directory}/jquery-3.7.1.jar"
export E2E_CONTAINER_TEST_JAR="${acceptance_directory}/container-agent-tests.jar"

run_network_blocked_browser_flow
printf 'Immutable container execution, isolation limits, cancellation and daemon cleanup passed.\n'
