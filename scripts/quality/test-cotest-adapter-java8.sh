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
  -C "${adapter_directory}/target/test-classes" fixture/AdapterSkippedCase.class
java -jar "${adapter_jar}" \
  --jars "${smoke_jars}" \
  --class fixture.AdapterSkippedCase \
  --output "${smoke_directory}/reports" \
  --case-timeout-seconds 60
if [[ ! -f "${smoke_directory}/reports/testng-results.xml" ]]; then
  echo "The Java 8 Adapter smoke run did not produce testng-results.xml." >&2
  exit 1
fi
printf 'Executed the packaged CoTest Adapter with the Java 8 runtime.\n'
