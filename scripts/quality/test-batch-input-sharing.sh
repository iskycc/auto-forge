#!/usr/bin/env bash

set -Eeuo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" ]]; then
  echo "Batch input sharing acceptance is restricted to GitHub Actions because it builds Go/Java assets and starts a production browser flow." >&2
  exit 1
fi

readonly repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly acceptance_directory="$(mktemp -d)"

cleanup() {
  local exit_status="$?"
  rm -rf -- "${acceptance_directory}"
  return "${exit_status}"
}
trap cleanup EXIT

require_host_tools() {
  local missing=0
  for command_name in curl jar java javac sha256sum tar; do
    if ! command -v "${command_name}" >/dev/null 2>&1; then
      echo "Missing required hosted-runner command: ${command_name}" >&2
      missing=1
    fi
  done
  if [[ "${missing}" -ne 0 ]]; then
    exit 1
  fi
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
  E2E_BATCH_SHARE_AGENT_BINARY="${acceptance_directory}/autoforge-agent-0.0.0-ci-${architecture}"
  export E2E_BATCH_SHARE_AGENT_BINARY
}

prepare_jdk_archive() {
  local java_home
  java_home="$(dirname -- "$(dirname -- "${java_executable}")")"
  E2E_BATCH_SHARE_JDK_ARCHIVE="${acceptance_directory}/$(basename -- "${java_home}").tar.gz"
  tar --create --gzip --format=ustar \
    --file "${E2E_BATCH_SHARE_JDK_ARCHIVE}" \
    --directory "$(dirname -- "${java_home}")" \
    "$(basename -- "${java_home}")"
  export E2E_BATCH_SHARE_JDK_ARCHIVE
}

cd "${repository_root}"
require_host_tools
bash scripts/quality/build-java-cases.sh
prepare_agent_binary

readonly fixture_directory="${repository_root}/tests/fixtures/java-cases/dist"
readonly java_executable="$(readlink -f "$(command -v java)")"
prepare_jdk_archive
readonly java_version="$(
  "${java_executable}" -XshowSettings:properties -version 2>&1 \
    | awk -F'= ' '/java.version =/{print $2; exit}'
)"
readonly testng_classpath="$(
  find "${fixture_directory}/toolchain" -maxdepth 1 -name '*.jar' -type f -print \
    | LC_ALL=C sort \
    | paste -sd: -
)"

if [[ -z "${java_version}" || -z "${testng_classpath}" ]]; then
  echo "The Java acceptance toolchain is incomplete." >&2
  exit 1
fi

export AUTOFORGE_E2E_DATA_DIR="${acceptance_directory}/platform-data"
export E2E_BATCH_SHARE_AGENT_DATA_DIR="${acceptance_directory}/agent-data"
export E2E_BATCH_SHARE_JAVA_EXECUTABLE="${java_executable}"
export E2E_BATCH_SHARE_JAVA_VERSION="${java_version}"
export E2E_BATCH_SHARE_TESTNG_CLASSPATH="${testng_classpath}"
export E2E_BATCH_SHARE_ADAPTER_JAR="${fixture_directory}/cotest-testng-adapter.jar"
export E2E_BATCH_SHARE_TEST_JAR="${fixture_directory}/java-cases-tests.jar"
export E2E_BATCH_SHARE_DEPENDENCY_ARCHIVE="${fixture_directory}/java-cases-dependencies.zip"

pnpm exec playwright test tests/e2e/batch-input-sharing.spec.ts
printf 'Batch downloads, extraction, later refill, restart reuse and terminal cleanup passed.\n'
