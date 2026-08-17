#!/usr/bin/env bash
# Builds the java-cases acceptance assets without Maven, following the
# adapters/cotest-testng runtime contract: a test JAR compiled against a
# dependency bundle laid out in up to three directory levels, plus the
# adapter executable JAR itself.

set -Eeuo pipefail

readonly repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly module_directory="${repository_root}/tests/fixtures/java-cases"
readonly output_directory="${module_directory}/dist"
readonly toolchain_directory="${output_directory}/toolchain"
readonly bundle_directory="${output_directory}/dependency-bundle/level-1/level-2/level-3"
readonly classes_directory="${output_directory}/classes"
readonly adapter_classes_directory="${output_directory}/adapter-classes"

readonly testng_url="https://repo.maven.apache.org/maven2/org/testng/testng/7.11.0/testng-7.11.0.jar"
readonly testng_sha256="2edbe6b2211186d8f5439cba7998697cce883432e5f14e0696f6b59d0d58582b"
readonly jcommander_url="https://repo.maven.apache.org/maven2/org/jcommander/jcommander/1.83/jcommander-1.83.jar"
readonly jcommander_sha256="e65f49c2119a1859b9076061e561fb5958a2fa6ffdb49f051ca8d59a0b3f87e4"
readonly slf4j_url="https://repo.maven.apache.org/maven2/org/slf4j/slf4j-api/2.0.16/slf4j-api-2.0.16.jar"
readonly slf4j_sha256="a12578dde1ba00bd9b816d388a0b879928d00bab3c83c240f7013bf4196c579a"
readonly jquery_url="https://repo.maven.apache.org/maven2/org/webjars/jquery/3.7.1/jquery-3.7.1.jar"
readonly jquery_sha256="262016dd3a559df87aefbe392804e9bf620787c9204c0ab8522d4c231ea65097"

download_verified() {
  local url="${1:?download URL is required}"
  local expected_sha256="${2:?SHA-256 is required}"
  local output_path="${3:?output path is required}"
  if [[ -s "${output_path}" ]] \
    && printf '%s  %s\n' "${expected_sha256}" "${output_path}" | sha256sum --check --status; then
    return
  fi
  curl --fail --location --silent --show-error "${url}" --output "${output_path}"
  printf '%s  %s\n' "${expected_sha256}" "${output_path}" | sha256sum --check --status
}

prepare_toolchain() {
  mkdir -p "${toolchain_directory}" "${bundle_directory}" "${classes_directory}" \
    "${adapter_classes_directory}"
  download_verified "${testng_url}" "${testng_sha256}" "${toolchain_directory}/testng-7.11.0.jar"
  download_verified "${jcommander_url}" "${jcommander_sha256}" "${toolchain_directory}/jcommander-1.83.jar"
  download_verified "${slf4j_url}" "${slf4j_sha256}" "${toolchain_directory}/slf4j-api-2.0.16.jar"
  download_verified "${jquery_url}" "${jquery_sha256}" "${toolchain_directory}/jquery-3.7.1.jar"
}

compile_project_utility() {
  local utility_classes="${output_directory}/utility-classes"
  rm -rf "${utility_classes}"
  mkdir -p "${utility_classes}"
  javac \
    --release 11 \
    -encoding UTF-8 \
    -d "${utility_classes}" \
    "${repository_root}/tests/fixtures/real-agent/ProjectFileUtil.java"
  jar --create \
    --file "${bundle_directory}/project-fixture.jar" \
    -C "${utility_classes}" .
}

compile_java_cases() {
  local compile_classpath
  compile_classpath="$(find "${toolchain_directory}" -maxdepth 1 -name '*.jar' -type f -print | LC_ALL=C sort | paste -sd: -)"
  javac \
    --release 11 \
    -encoding UTF-8 \
    -cp "${compile_classpath}:${bundle_directory}/project-fixture.jar" \
    -d "${classes_directory}" \
    "${module_directory}/src/main/java/com/autoforge/javacases/JavaCasesConstants.java" \
    "${module_directory}/src/main/java/com/autoforge/javacases/JavaCasesFixture.java" \
    "${module_directory}/src/main/java/com/autoforge/javacases/JavaCasesFailureFixture.java" \
    "${module_directory}/src/main/java/com/autoforge/javacases/JavaCasesConcurrentAlphaFixture.java" \
    "${module_directory}/src/main/java/com/autoforge/javacases/JavaCasesConcurrentBetaFixture.java"
  jar --create \
    --file "${output_directory}/java-cases-tests.jar" \
    -C "${classes_directory}" .
}

assemble_dependency_bundle() {
  cp -- "${toolchain_directory}"/*.jar "${bundle_directory}/"
  jar --create \
    --file "${output_directory}/java-cases-dependencies.zip" \
    -C "${output_directory}/dependency-bundle" .
}

build_adapter_jar() {
  javac \
    --release 11 \
    -encoding UTF-8 \
    -d "${adapter_classes_directory}" \
    "${repository_root}/adapters/cotest-testng/src/main/java/com/autoforge/adapters/cotest/"*.java
  jar --create \
    --file "${output_directory}/cotest-testng-adapter.jar" \
    --main-class com.autoforge.adapters.cotest.AdapterMain \
    -C "${adapter_classes_directory}" .
}

prepare_toolchain
compile_project_utility
compile_java_cases
assemble_dependency_bundle
build_adapter_jar

cat <<RESULT
java-cases assets built:
  test jar:        ${output_directory}/java-cases-tests.jar
  dependency zip:  ${output_directory}/java-cases-dependencies.zip
  adapter jar:     ${output_directory}/cotest-testng-adapter.jar
RESULT
