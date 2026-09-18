#!/usr/bin/env bash

set -Eeuo pipefail

readonly repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly adapter_pom="${repository_root}/adapters/cotest-testng/pom.xml"
readonly adapter_directory="${repository_root}/adapters/cotest-testng"
readonly adapter_jar="${repository_root}/adapters/cotest-testng/target/cotest-testng-adapter-0.1.0-SNAPSHOT.jar"

for command in jar java javac mvn; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "${command} is required to verify the Java 8 CoTest Adapter build." >&2
    exit 1
  fi
done

readonly java_settings="$(java -XshowSettings:properties -version 2>&1)"
if ! grep -Fq 'java.specification.version = 1.8' <<<"${java_settings}"; then
  echo "The CoTest Adapter release must be compiled with JDK 8." >&2
  java -version >&2
  exit 1
fi
readonly maven_version="$(mvn --version)"
if ! grep -Fq 'Java version: 1.8' <<<"${maven_version}"; then
  echo "Maven must use JDK 8 when building the CoTest Adapter." >&2
  printf '%s\n' "${maven_version}" >&2
  exit 1
fi

mvn --batch-mode --no-transfer-progress --file "${adapter_pom}" clean verify
mvn --batch-mode --no-transfer-progress --file "${adapter_pom}" -Dtestng.version=6.14.3 test
bash "${repository_root}/scripts/quality/verify-cotest-adapter-bytecode.sh" "${adapter_jar}"

readonly smoke_directory="${adapter_directory}/target/java8-smoke"
readonly smoke_jars="${smoke_directory}/jars"
mkdir -p "${smoke_jars}"
mvn --batch-mode --no-transfer-progress --file "${adapter_pom}" \
  dependency:copy-dependencies \
  -DincludeScope=test \
  -DoutputDirectory="${smoke_jars}"
jar cf "${smoke_jars}/autoforge-case.jar" \
  -C "${adapter_directory}/target/test-classes" fixture/AdapterSkippedCase.class \
  -C "${adapter_directory}/target/test-classes" fixture/AdapterAllSkippedCase.class

verify_skipped_case() {
  local fixture_class="$1"
  local expected_passed="$2"
  local report_directory="${smoke_directory}/${fixture_class}"
  local exit_status=0
  mkdir -p "${report_directory}"
  java -jar "${adapter_jar}" \
    --jars "${smoke_jars}" \
    --class "${fixture_class}" \
    --output "${report_directory}" \
    --case-timeout-seconds 60 > "${report_directory}/console.log" 2>&1 || exit_status=$?
  cat "${report_directory}/console.log"
  if [[ "${exit_status}" -ne 1 ]]; then
    echo "${fixture_class}: expected failure exit code 1 for skipped tests, got ${exit_status}." >&2
    return 1
  fi
  if [[ ! -s "${report_directory}/testng-results.xml" ]] \
    || ! grep -Fq "Passed: ${expected_passed}" "${report_directory}/console.log" \
    || ! grep -Fq 'Failed: 0' "${report_directory}/console.log" \
    || ! grep -Fq 'Skipped: 1' "${report_directory}/console.log"; then
    echo "${fixture_class}: expected TestNG XML and passed/failed/skipped counts were not produced." >&2
    return 1
  fi
}

verify_skipped_case fixture.AdapterSkippedCase 1
verify_skipped_case fixture.AdapterAllSkippedCase 0
printf 'Verified mixed and all-skipped failures with the packaged Java 8 Adapter.\n'
